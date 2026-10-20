#!/usr/bin/env node
// Roda UM verificador em modo headless (`claude -p --agent <nome>`), respeitando o teto semanal.
// Chamado pelas units rotinas/verificador-*.service. Nada de shell: argv validado + spawn.
//
// Uso: node rotinas/rodar-verificador.mjs <nome>      (ex.: verificador-seguranca)
//
// Teto semanal: conta as execuções da semana corrente (segunda 00:00, hora local) em
// ~/.claude/agentic-os/rotinas/execucoes.jsonl. Bateu o teto → não roda e sai com 0.

import { spawn as spawnReal } from 'node:child_process';
import { promises as fsReal } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lista fechada: nome do verificador → teto de execuções por semana, teto de gasto por execução
// (US$, passado a --max-budget-usd) e o pedido feito ao agente.
export const VERIFICADORES = {
  'verificador-seguranca': {
    tetoSemana: 1,
    orcamentoUsd: 1,
    pedido: 'Rotina semanal: varra os ambientes de teste configurados no agente (nunca PROD), dependências, segredos e headers. Grave o relatório com o bloco json de tarefas sugeridas.',
  },
  'verificador-bugs-ui': {
    tetoSemana: 1,
    orcamentoUsd: 2,
    pedido: 'Rotina semanal: percorra os fluxos principais no DEV em 390, 768 e 1440 px e no tema escuro, sem enviar mensagem. Grave o relatório com o bloco json de tarefas sugeridas.',
  },
  'verificador-velocidade': {
    tetoSemana: 2,
    orcamentoUsd: 1,
    pedido: 'Rotina: meça as páginas principais, acrescente as linhas em velocidade.jsonl e aponte regressões. Grave o relatório com o bloco json de tarefas sugeridas.',
  },
  'verificador-otimizacao': {
    tetoSemana: 1,
    orcamentoUsd: 1,
    pedido: 'Rotina semanal: meça os processos no DEV (10 chamadas em série, sem IA paga) e monte o ranking dos 5 mais lentos com causa provável. Grave o relatório com o bloco json de tarefas sugeridas.',
  },
  'verificador-escalabilidade': {
    tetoSemana: 1,
    orcamentoUsd: 1,
    pedido: 'Rotina semanal: SEM teste de carga (eixo carga = sem dado). Meça só os eixos dados, estado-infra, custo-unidade e manutencao no repo configurado no agente. Grave a linha em escala.jsonl e o relatório com o bloco json de tarefas sugeridas.',
  },
};

const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;

/** Início da semana corrente (segunda 00:00, hora local) para o instante `agora`. */
export function inicioDaSemana(agora) {
  const d = new Date(agora);
  d.setHours(0, 0, 0, 0);
  const diasDesdeSegunda = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diasDesdeSegunda);
  return d;
}

/** Quantas execuções de `nome` existem na semana de `agora`. Linhas inválidas são ignoradas. */
export function execucoesNaSemana(textoJsonl, nome, agora) {
  const inicio = inicioDaSemana(agora).getTime();
  const fim = inicio + SEMANA_MS;
  let n = 0;
  for (const linha of String(textoJsonl || '').split('\n')) {
    if (!linha.trim()) continue;
    let reg;
    try { reg = JSON.parse(linha); } catch { continue; }
    if (reg?.nome !== nome) continue;
    const t = Date.parse(reg.em);
    if (Number.isFinite(t) && t >= inicio && t < fim) n++;
  }
  return n;
}

/** argv do `claude` headless para o verificador. Lança erro para nome fora da lista. */
export function argvVerificador(nome) {
  const v = VERIFICADORES[nome];
  if (!v) throw new Error(`verificador desconhecido: ${nome}`);
  return [
    'claude', '-p',
    '--agent', nome,
    '--permission-mode', 'default',
    '--max-budget-usd', String(v.orcamentoUsd),
    '--output-format', 'json',
    v.pedido,
  ];
}

/** Decide e roda. Tudo que toca o mundo entra por injeção. -> { rodou, motivo, codigo? } */
export async function rodar(nome, { fs = fsReal, spawn = spawnReal, agora = () => new Date(), base = join(homedir(), '.claude', 'agentic-os', 'rotinas') } = {}) {
  const v = VERIFICADORES[nome];
  if (!v) return { rodou: false, motivo: `verificador desconhecido: ${nome}` };

  const arquivo = join(base, 'execucoes.jsonl');
  let historico = '';
  try { historico = await fs.readFile(arquivo, 'utf8'); } catch { historico = ''; }

  const instante = agora();
  const feitas = execucoesNaSemana(historico, nome, instante);
  if (feitas >= v.tetoSemana) {
    return { rodou: false, motivo: `teto semanal atingido (${feitas}/${v.tetoSemana})` };
  }

  await fs.mkdir(base, { recursive: true });
  await fs.appendFile(arquivo, JSON.stringify({ nome, em: instante.toISOString() }) + '\n');

  const [cmd, ...args] = argvVerificador(nome);
  const codigo = await new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', () => resolve(127));
    p.on('close', (c) => resolve(c ?? 1));
  });
  return { rodou: true, motivo: 'ok', codigo };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const nome = process.argv[2];
  const r = await rodar(nome);
  console.log(`${nome}: ${r.rodou ? `rodou (saída ${r.codigo})` : `não rodou — ${r.motivo}`}`);
  process.exitCode = r.rodou ? r.codigo : (VERIFICADORES[nome] ? 0 : 2);
}
