// Confere as definições de agente (agentes/*.md, contrato C6) e as rotinas dos verificadores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
  VERIFICADORES, execucoesNaSemana, inicioDaSemana, argvVerificador, rodar,
} from '../rotinas/rodar-verificador.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR_AGENTES = join(RAIZ, 'agentes');
const DIR_ROTINAS = join(RAIZ, 'rotinas');

const MODELOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const LIDERES = ['exemplo'];
const VERIFS = ['seguranca', 'bugs-ui', 'velocidade', 'otimizacao', 'escalabilidade'];
const ESPERADOS = ['orquestrador', ...LIDERES.map((a) => `lider-${a}`), ...VERIFS.map((v) => `verificador-${v}`)];

/** Frontmatter simples (chave: valor numa linha), como o Claude Code lê. */
function lerFrontmatter(texto) {
  const m = texto.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const campos = {};
  for (const linha of m[1].split('\n')) {
    if (!linha.trim()) continue;
    const i = linha.indexOf(':');
    assert.ok(i > 0, `linha de frontmatter sem "chave:": ${linha}`);
    campos[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
  }
  return { campos, corpo: m[2] };
}

const tools = (fm) => fm.campos.tools.split(',').map((t) => t.trim()).filter(Boolean);
const ler = (nome) => lerFrontmatter(readFileSync(join(DIR_AGENTES, `${nome}.md`), 'utf8'));

test('existem exatamente os 7 agentes esperados', () => {
  const achados = readdirSync(DIR_AGENTES).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(achados, [...ESPERADOS].sort());
});

for (const nome of ESPERADOS) {
  test(`${nome}: frontmatter válido com name, description, tools e model`, () => {
    const fm = ler(nome);
    assert.ok(fm, 'arquivo precisa começar com bloco --- frontmatter ---');
    for (const campo of ['name', 'description', 'tools', 'model']) {
      assert.ok(fm.campos[campo], `campo obrigatório ausente: ${campo}`);
    }
    assert.equal(fm.campos.name, nome, 'name precisa bater com o nome do arquivo');
    assert.match(fm.campos.name, /^[a-z][a-z0-9-]*$/);
    assert.ok(MODELOS.includes(fm.campos.model), `modelo fora da lista fechada: ${fm.campos.model}`);
    assert.ok(fm.campos.description.length >= 80, 'description curta demais para o roteamento');
    assert.ok(tools(fm).length > 0);
    assert.ok(fm.corpo.trim().length > 200, 'corpo com o papel do agente está vazio');
  });
}

test('orquestrador: Opus 5.5, nunca dispara (sem Bash/Agent), grava plano em agentic-os/planos', () => {
  const fm = ler('orquestrador');
  assert.equal(fm.campos.model, 'claude-opus-5-5');
  const t = tools(fm);
  for (const proibida of ['Bash', 'Agent', 'Task', 'Edit']) assert.ok(!t.includes(proibida), `orquestrador não pode ter ${proibida}`);
  assert.ok(t.includes('Write'), 'precisa de Write para gravar o plano proposto');
  assert.match(fm.corpo, /~\/\.claude\/agentic-os\/planos\/<AAAA-MM-DD>-<nome>\.md/);
  assert.match(fm.corpo, /papeis\.json/);
  assert.match(fm.corpo, /proposto/);
  assert.match(fm.corpo, /```prompt id=/);
  assert.match(fm.corpo, /nunca dispara/i);
});

for (const area of LIDERES) {
  test(`lider-${area}: diário próprio, sem disparo`, () => {
    const fm = ler(`lider-${area}`);
    const t = tools(fm);
    for (const proibida of ['Bash', 'Agent', 'Task']) assert.ok(!t.includes(proibida), `líder não pode ter ${proibida}`);
    assert.ok(fm.corpo.includes(`~/.claude/agentic-os/lideres/${area}.md`), 'diário da área');
    assert.match(fm.corpo, /\*\*Etapa:\*\*/);
    assert.match(fm.corpo, /sub-plano/);
  });
}

for (const v of VERIFS) {
  test(`verificador-${v}: só leitura, propõe tarefa sugerida, escreve só relatório`, () => {
    const fm = ler(`verificador-${v}`);
    const t = tools(fm);
    for (const proibida of ['Edit', 'NotebookEdit', 'MultiEdit', 'Agent', 'Task']) {
      assert.ok(!t.includes(proibida), `verificador não pode ter ${proibida}`);
    }
    assert.match(fm.corpo, /sugerida/);
    assert.match(fm.corpo, /Escrita só/);
    assert.match(fm.campos.description, /só leitura/i);
    assert.match(fm.campos.description, /Não corrige/);
  });
}

test('verificador-seguranca: nunca PROD sem ok', () => {
  const { corpo, campos } = ler('verificador-seguranca');
  assert.match(campos.description, /nunca PROD sem ok/);
  assert.match(corpo, /PROD fica fora/);
  for (const t of ['Portas', 'Dependências', 'Segredos', 'Headers']) assert.match(corpo, new RegExp(t));
});

test('verificador-bugs-ui: 3 larguras e tema escuro e console', () => {
  const { corpo } = ler('verificador-bugs-ui');
  for (const t of ['390', '768', '1440', 'tema escuro', 'console']) assert.ok(corpo.includes(t), t);
});

test('verificador-velocidade: histórico e skill velocidade-site', () => {
  const { corpo, campos } = ler('verificador-velocidade');
  assert.ok(tools({ campos }).includes('Skill'));
  assert.match(corpo, /velocidade\.jsonl/);
  assert.match(corpo, /velocidade-site/);
});

test('verificador-otimizacao: processos e ranking dos 5', () => {
  const { corpo } = ler('verificador-otimizacao');
  for (const t of ['Login', 'Cadastro', 'Envio de mensagem', 'Carregar funil', '5 mais lentos', 'arquivo:linha']) assert.ok(corpo.includes(t), t);
});

test('verificador-escalabilidade: 5 eixos com pesos e regras do teste de carga', () => {
  const { corpo } = ler('verificador-escalabilidade');
  const eixos = { carga: 35, dados: 25, 'estado-infra': 20, 'custo-unidade': 10, manutencao: 10 };
  for (const [eixo, peso] of Object.entries(eixos)) {
    assert.match(corpo, new RegExp(`\\| \`${eixo}\` \\| ${peso} \\|`), `eixo ${eixo} com peso ${peso}`);
  }
  assert.equal(Object.values(eixos).reduce((a, b) => a + b, 0), 100);
  assert.match(corpo, /Só no DEV/);
  assert.match(corpo, /Teto de 10×/);
  assert.match(corpo, /5 min por degrau/);
  assert.match(corpo, /Nunca IA paga/);
  assert.match(corpo, /quem cuida do ambiente/);
  assert.match(corpo, /escala\.jsonl/);
});

// ---------- rotinas ----------

for (const nome of Object.keys(VERIFICADORES)) {
  test(`rotina ${nome}: .service + .timer, nasce desabilitada`, () => {
    const svc = readFileSync(join(DIR_ROTINAS, `${nome}.service`), 'utf8');
    const tmr = readFileSync(join(DIR_ROTINAS, `${nome}.timer`), 'utf8');
    for (const u of [svc, tmr]) {
      assert.match(u, /^# NASCE DESABILITADA/m);
      assert.ok(u.includes(`systemctl --user enable --now ${nome}.timer`));
    }
    assert.match(svc, /^\[Service\]$/m);
    assert.match(svc, /^Type=oneshot$/m);
    assert.ok(svc.includes(`rodar-verificador.mjs ${nome}`));
    assert.match(tmr, /^\[Timer\]$/m);
    assert.match(tmr, /^OnCalendar=/m);
    assert.match(tmr, /^WantedBy=timers\.target$/m);
    assert.ok(readdirSync(DIR_AGENTES).includes(`${nome}.md`), 'rotina aponta para agente que existe');
  });
}

test('toda rotina tem verificador e todo verificador tem rotina', () => {
  const units = readdirSync(DIR_ROTINAS).filter((f) => f.endsWith('.timer')).map((f) => f.slice(0, -6)).sort();
  assert.deepEqual(units, VERIFS.map((v) => `verificador-${v}`).sort());
  assert.deepEqual(Object.keys(VERIFICADORES).sort(), units);
});

test('README das rotinas explica teto semanal, custo e como ligar', () => {
  const r = readFileSync(join(DIR_ROTINAS, 'README.md'), 'utf8');
  assert.match(r, /Teto\/semana/);
  assert.match(r, /US\$/);
  assert.match(r, /systemctl --user enable --now/);
  for (const nome of Object.keys(VERIFICADORES)) assert.ok(r.includes(nome), nome);
});

test('inicioDaSemana: segunda 00:00 local', () => {
  const quarta = new Date(2026, 9, 21, 15, 30); // 21/10/2026 é quarta
  assert.equal(inicioDaSemana(quarta).getTime(), new Date(2026, 9, 19, 0, 0).getTime());
  const domingo = new Date(2026, 9, 25, 23, 0);
  assert.equal(inicioDaSemana(domingo).getTime(), new Date(2026, 9, 19, 0, 0).getTime());
});

test('execucoesNaSemana conta só o nome e a semana certos e ignora lixo', () => {
  const agora = new Date(2026, 9, 21, 12, 0);
  const linhas = [
    { nome: 'verificador-velocidade', em: new Date(2026, 9, 19, 4, 0).toISOString() },
    { nome: 'verificador-velocidade', em: new Date(2026, 9, 18, 4, 0).toISOString() }, // semana passada
    { nome: 'verificador-seguranca', em: new Date(2026, 9, 20, 3, 0).toISOString() },
  ].map((l) => JSON.stringify(l)).join('\n') + '\nisto não é json\n{"nome":"verificador-velocidade","em":"lixo"}\n';
  assert.equal(execucoesNaSemana(linhas, 'verificador-velocidade', agora), 1);
  assert.equal(execucoesNaSemana(linhas, 'verificador-seguranca', agora), 1);
  assert.equal(execucoesNaSemana('', 'verificador-seguranca', agora), 0);
});

test('argvVerificador: argv fechado, sem bypass, com teto de gasto', () => {
  const argv = argvVerificador('verificador-seguranca');
  assert.deepEqual(argv.slice(0, 4), ['claude', '-p', '--agent', 'verificador-seguranca']);
  assert.ok(argv.includes('--max-budget-usd'));
  assert.ok(!argv.includes('bypassPermissions'));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'default');
  assert.throws(() => argvVerificador('rm -rf /'), /desconhecido/);
});

function dubles(historicoInicial = '') {
  const arquivos = new Map([['/b/execucoes.jsonl', historicoInicial]]);
  const chamadas = [];
  const fs = {
    async readFile(p) { if (!arquivos.has(p)) throw new Error('ENOENT'); return arquivos.get(p); },
    async mkdir() {},
    async appendFile(p, t) { arquivos.set(p, (arquivos.get(p) || '') + t); },
  };
  const spawn = (cmd, args) => {
    chamadas.push([cmd, ...args]);
    const p = new EventEmitter();
    setImmediate(() => p.emit('close', 0));
    return p;
  };
  return { fs, spawn, chamadas, arquivos };
}

test('rodar: dentro do teto roda e registra a execução', async () => {
  const d = dubles();
  const agora = () => new Date(2026, 9, 21, 3, 0);
  const r = await rodar('verificador-seguranca', { fs: d.fs, spawn: d.spawn, agora, base: '/b' });
  assert.equal(r.rodou, true);
  assert.equal(r.codigo, 0);
  assert.equal(d.chamadas.length, 1);
  assert.equal(d.chamadas[0][0], 'claude');
  assert.equal(execucoesNaSemana(d.arquivos.get('/b/execucoes.jsonl'), 'verificador-seguranca', agora()), 1);
});

test('rodar: teto semanal atingido não roda', async () => {
  const agora = () => new Date(2026, 9, 21, 3, 0);
  const d = dubles(JSON.stringify({ nome: 'verificador-seguranca', em: new Date(2026, 9, 20, 3, 0).toISOString() }) + '\n');
  const r = await rodar('verificador-seguranca', { fs: d.fs, spawn: d.spawn, agora, base: '/b' });
  assert.equal(r.rodou, false);
  assert.match(r.motivo, /teto semanal/);
  assert.equal(d.chamadas.length, 0);
});

test('rodar: nome fora da lista não roda', async () => {
  const d = dubles();
  const r = await rodar('qualquer-coisa', { fs: d.fs, spawn: d.spawn, agora: () => new Date(), base: '/b' });
  assert.equal(r.rodou, false);
  assert.equal(d.chamadas.length, 0);
});
