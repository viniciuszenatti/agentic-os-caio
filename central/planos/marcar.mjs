#!/usr/bin/env node
/**
 * O comando que a sessão local roda para se marcar no registro do plano:
 *
 *   node central/planos/marcar.mjs iniciou  <plano.md> <id>
 *   node central/planos/marcar.mjs concluiu <plano.md> <id>
 *   node central/planos/marcar.mjs falhou   <plano.md> <id> [motivo…]
 *
 * Chama `registro.marcar` (contrato C2) e grava com `registro.gravar`
 * (atômico). O registro mora ao lado do plano: `<plano>.registro.json`.
 *
 * `executar` recebe tudo injetado ({ registro, fs, env, agora }) para o teste
 * usar um dublê do C2; só o bloco de linha de comando no fim importa os
 * módulos reais.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EVENTOS = ['iniciou', 'concluiu', 'falhou'];
const RE_ID = /^[A-Za-z]+\d+$/;
const USO = 'uso: node central/planos/marcar.mjs iniciou|concluiu|falhou <plano.md> <id> [motivo]';

/** Onde fica o registro de um plano: ao lado dele, `<nome>.registro.json`. */
export function caminhoDoRegistro(plano) {
  const abs = path.resolve(plano);
  return abs.replace(/\.md$/i, '') + '.registro.json';
}

function hora(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {string[]} args [evento, plano, id, ...motivo]
 * @param {{ registro: {ler, gravar, marcar}, fs: object, env?: object, agora?: () => number }} deps
 * @returns {Promise<{ codigo: number, saida: string }>}
 */
export async function executar(args, { registro, fs, env = {}, agora = () => Date.now() } = {}) {
  const [evento, plano, id, ...resto] = args;
  if (!EVENTOS.includes(evento) || !plano || !id) return { codigo: 2, saida: USO };
  if (!RE_ID.test(id)) return { codigo: 2, saida: `id inválido: ${id} (use letras seguidas de dígitos, ex.: P1)` };
  if (!/\.md$/i.test(plano)) return { codigo: 2, saida: `o plano precisa ser um arquivo .md: ${plano}` };

  const caminho = caminhoDoRegistro(plano);
  const quando = agora();
  const dados = {};
  if (evento === 'iniciou' && env.CLAUDE_CODE_SESSION_ID) dados.sessao = env.CLAUDE_CODE_SESSION_ID;
  if (evento === 'falhou') dados.motivo = resto.join(' ').trim() || 'sem motivo informado';

  try {
    const atual = await registro.ler(caminho, { fs });
    const novo = registro.marcar(atual, id, evento, dados, { agora: quando });
    await registro.gravar(caminho, novo, { fs });
  } catch (e) {
    return { codigo: 1, saida: `não consegui marcar ${id} como ${evento}: ${e.message}` };
  }

  const rotulo = { iniciou: 'iniciado', concluiu: 'concluído', falhou: 'falhou' }[evento];
  const sessao = dados.sessao ? ` · sessão ${dados.sessao.slice(0, 8)}` : '';
  const motivo = dados.motivo ? ` · ${dados.motivo}` : '';
  return { codigo: 0, saida: `${id} ${rotulo}${sessao}${motivo} · ${hora(quando)}` };
}

// linha de comando
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  let r;
  try {
    const registro = await import(pathToFileURL(path.join(aqui, 'registro.mjs')).href);
    const fs = await import('node:fs/promises');
    r = await executar(process.argv.slice(2), { registro, fs, env: process.env });
  } catch (e) {
    r = { codigo: 1, saida: `não consegui carregar o registro (central/planos/registro.mjs): ${e.message}` };
  }
  (r.codigo === 0 ? console.log : console.error)(r.saida);
  process.exitCode = r.codigo;
}
