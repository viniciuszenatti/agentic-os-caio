#!/usr/bin/env node
// Teste do verificador A15 contra o repo plantado em ./fixture e do teste de carga contra um servidor local.
// Rodar: node teste.mjs   (sem rede externa, sem custo; ~10 s)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { avaliar, lerConfig, lerStack } from './verificador.mjs';
import { notaEixo } from './lib.mjs';
import { rodarCarga, hostPermitido } from './carga.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(AQUI, 'fixture');
let falhas = 0, total = 0;
const ok = (cond, nome, extra = '') => { total++; if (cond) console.log(`  ✓ ${nome}`); else { falhas++; console.log(`  ✗ ${nome} ${extra}`); } };

const cfg = lerConfig();
// arquivo grande gerado na hora (não fica versionado no fixture)
const grande = path.join(FIX, 'src/lib/gigante.ts');
fs.writeFileSync(grande, Array.from({ length: cfg.alvos.linhasPorArquivo + 5 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
try {
  console.log('Varredura do repo plantado');
  const r = avaliar({
    raiz: FIX, nome: 'fixture', cfg, alias: { js: 'src', py: 'src' },
    sqls: [fs.readFileSync(path.join(FIX, 'migrations.sql'), 'utf8')],
    stackYml: fs.readFileSync(path.join(FIX, 'stack.yml'), 'utf8'), stackArq: 'stack.yml',
  });
  const todos = Object.values(r.eixos).flatMap((e) => e.achados);
  const tem = (tipo, arq, filtro = () => true) => todos.filter((a) => a.tipo === tipo && a.arquivo.endsWith(arq) && filtro(a));
  ok(tem('sem-limit', 'db.ts').length === 1, 'acha SELECT sem LIMIT nem WHERE (db.ts)', JSON.stringify(tem('sem-limit', 'db.ts')));
  ok(tem('sem-indice', 'db.ts', (a) => /clientes/.test(a.msg)).length === 1, 'acha filtro em coluna sem índice (clientes.email)');
  ok(!tem('sem-indice', 'db.ts', (a) => /pedidos/.test(a.msg)).length, 'não acusa filtro por tenant_id indexado');
  ok(tem('n+1', 'db.ts').length === 1, 'acha N+1 em for (TS)');
  ok(tem('n+1', 'repo.py').length === 1, 'acha N+1 em for (Python)');
  ok(!tem('sem-limit', 'repo.py').length, 'não acusa SQL partido em duas strings com WHERE/LIMIT');
  ok(tem('memoria', 'db.ts').length === 1 && /cachePorTenant/.test(tem('memoria', 'db.ts')[0]?.msg), 'acha Map no topo do módulo e ignora as constantes Set');
  ok(tem('memoria', 'repo.py').length === 1, 'acha dict global mutável (Python) e ignora CAIXA ALTA');
  ok(!tem('memoria', 'use-perfis.ts').length, "não acusa cache de hook 'use client'");
  ok(tem('llm-em-laco', 'db.ts').length === 1, 'acha chamada de LLM dentro de laço');
  ok(tem('llm-sem-teto', 'db.ts').length === 1, 'acha chamada de LLM sem max_tokens (só a sem teto)');
  ok(tem('ciclo', '').length === 1, 'acha import circular pool ↔ ciclo-b');
  ok(tem('arquivo-grande', 'gigante.ts').length === 1, 'acha arquivo acima do limite de linhas');
  ok(tem('nao-replica', 'stack.yml').length === 1 && /arquivos/.test(tem('nao-replica', 'stack.yml')[0]?.msg), 'acha serviço com volume no stack (e não o sem volume)');
  ok(r.eixos.carga.nota === null, 'Carga sem dado quando o teste de carga não rodou');
  ok(typeof r.nota === 'number' && r.nota >= 0 && r.nota <= 100, `nota geral entre 0 e 100 (${r.nota})`);
  ok(r.gargalo && r.gargalo.arquivo && r.gargalo.linha, `gargalo traz arquivo:linha (${r.gargalo?.arquivo}:${r.gargalo?.linha})`);
  const interp = todos.filter((a) => a.arquivo.endsWith('interpolado.ts'));
  ok(interp.length === 2 && interp.every((a) => /clientes/.test(a.msg) && a.linha > 15), `WHERE por constante, interpolação cega e índice parcial não geram achado; valor interpolado e índice parcial não seletivo continuam sendo julgados (${interp.map((a) => a.linha + ' ' + a.msg).join('; ')})`);
  ok(!todos.some((a) => a.arquivo.endsWith('fstring.py')), 'f-string com WHERE em constante não gera achado (Python)');
  const umaPena = [{ pena: 8 }], muitas = Array.from({ length: 40 }, () => ({ pena: 8 }));
  ok(notaEixo([]) === 100 && notaEixo(umaPena) === 92.3 && notaEixo(muitas) > 0, `curva: sem achado 100, uma pena de 8 → 92,3, 40 achados não zeram (${notaEixo(muitas)})`);
  ok(notaEixo(muitas.slice(1)) > notaEixo(muitas), 'curva: consertar 1 achado sobe a nota mesmo com 40');
  ok(lerStack('services:\n  a:\n    deploy:\n      replicas: 3\n').at(0)?.replicas === 3, 'lê replicas do stack');
} finally { fs.rmSync(grande, { force: true }); }

console.log('Teste de carga (servidor local que fica lento acima de 12 conexões)');
const DEV = ['dev.exemplo.com'];
ok(hostPermitido('https://dev.exemplo.com', DEV), 'aceita host DEV');
ok(!hostPermitido('https://hml.exemplo.com', DEV), 'recusa HML');
ok(!hostPermitido('https://exemplo.com', DEV), 'recusa PROD');
ok(!hostPermitido('https://dev.exemplo.com.evil.com', DEV), 'recusa host disfarçado');
ok(!hostPermitido('https://dev.exemplo.com'), 'sem hostsDev configurado, só localhost');
ok(hostPermitido('http://127.0.0.1:9999'), 'aceita localhost');
let ativos = 0, maxVisto = 0;
const srv = http.createServer((req, res) => {
  ativos++; maxVisto = Math.max(maxVisto, ativos);
  if (req.method !== 'GET') { res.writeHead(405); res.end(); ativos--; return; }
  setTimeout(() => { res.end('ok'); ativos--; }, ativos > 12 ? 1200 : 20);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const degraus = await rodarCarga({ base, fluxos: [{ nome: 'raiz', caminho: '/' }], cfgCarga: { ...cfg.carga, usuariosBase: 5, segundosPorDegrau: 1 }, alvos: cfg.alvos, log: () => {} });
srv.close();
ok(degraus.length === 3, `para no primeiro degrau que falhar (rodou ${degraus.map((d) => d.fator + '×').join(', ')})`);
ok(degraus[0].ok && degraus[1].ok && !degraus[2].ok, '1× e 2× passam, 5× falha');
ok(!degraus.some((d) => d.fator === 10), 'não chega no 10× depois da falha');

console.log(`\n${total - falhas}/${total} passaram`);
process.exit(falhas ? 1 : 0);
