// Nota de escalabilidade (docs/arquitetura.md, contrato C4). À PARTE do score: não entra no
// score do projeto nem redistribui os pesos dele. Histórico próprio em escala.jsonl.
//
// Cada eixo recebe a sua fonte já lida (o verificador A15 mede; este módulo só calcula).
// Fonte ausente (null/undefined) = "sem dado": o eixo sai da média.
// Um achado ("Achado") é { descricao?, arquivo?, linha? }.
//
// ── Formato de cada fonte (fontes = { [chave]: fonte | null }) ─────────────────
//  carga          { degraus: [{ multiplicador: 1|2|5|10, p95Ms, falhou?, fluxo?, motivo?, arquivo?, linha? }] }
//                 Teste de carga no DEV. Um degrau passa se !falhou e p95Ms ≤ alvos.p95Ms.
//                 Os degraus contam em ordem (1×, 2×, 5×, 10×) e param no primeiro que falha
//                 ou que não foi medido. Nota pelo maior degrau aguentado:
//                 10× → 100, 5× → 70, 2× → 40, 1× → 10, falha no 1× → 0. Sem 1× medido = sem dado.
//
//  dados          { achados: [Achado & { tipo?, tabelaCresce: boolean }] }
//                 consulta sem LIMIT/paginação, coluna sem índice, SELECT *, N+1.
//                 nota = max(0, 100 − 8·(achados em tabela que cresce com o tenant) − 3·(demais))
//
//  estado-infra   { servicosSemReplica: [Achado & { servico? }], estadoEmMemoria: [Achado] }
//                 nota = max(0, 100 − 15·servicosSemReplica − 5·estadoEmMemoria)
//
//  custo-unidade  { chamadasSemTeto: [Achado], chamadasEmLoop: [Achado] }
//                 chamadas pagas (LLM, STT, WhatsApp) sem teto ou dentro de loop.
//                 nota = max(0, 100 − 20·chamadasSemTeto − 10·chamadasEmLoop)
//
//  manutencao     { achados: [Achado] }   arquivo > alvos.linhasPorArquivo linhas, import circular,
//                 módulo sem teste importado por alvos.importadores+ outros.
//                 nota = max(0, 100 − 5·achados)
//
// geral = média ponderada dos eixos com dado (arredondada); null se nenhum tem dado.
// primeiroGargalo = o eixo que mais tira pontos da geral, dito em linguagem direta,
//                   com arquivo:linha quando a fonte traz.

import { validarConfig, montar, tendencia as tendenciaGenerica } from './score.mjs';

export const EIXOS = Object.freeze([
  Object.freeze({ chave: 'carga', nome: 'Carga' }),
  Object.freeze({ chave: 'dados', nome: 'Dados' }),
  Object.freeze({ chave: 'estado-infra', nome: 'Estado e infra' }),
  Object.freeze({ chave: 'custo-unidade', nome: 'Custo por unidade' }),
  Object.freeze({ chave: 'manutencao', nome: 'Manutenção pelo time' }),
]);

const CHAVES = EIXOS.map((e) => e.chave);

export const ESCALA_PADRAO = Object.freeze({
  pesos: Object.freeze({ carga: 35, dados: 25, 'estado-infra': 20, 'custo-unidade': 10, manutencao: 10 }),
  // p95Ms entra na fórmula da Carga; linhasPorArquivo e importadores são os limites
  // que o verificador usa para contar achados de Manutenção.
  alvos: Object.freeze({ p95Ms: 800, linhasPorArquivo: 800, importadores: 5 }),
});

export const DEGRAUS = Object.freeze([1, 2, 5, 10]);
export const NOTA_POR_DEGRAU = Object.freeze({ 0: 0, 1: 10, 2: 40, 5: 70, 10: 100 });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lista = (v) => (Array.isArray(v) ? v.filter(ehObjeto) : []);
const piso0 = (v) => Math.max(0, v);

/** Valida escala-pesos.json. Devolve a lista de erros (vazia = ok). Soma precisa dar 100. */
export function validarEscala(obj) {
  return validarConfig(obj, CHAVES, ESCALA_PADRAO.alvos, 'escala');
}

export function local(a) {
  if (!a || !a.arquivo) return null;
  return Number.isInteger(a.linha) ? `${a.arquivo}:${a.linha}` : String(a.arquivo);
}

const comLocal = (texto, a) => (local(a) ? `${texto} (${local(a)})` : texto);
const descr = (a, padrao) => (a && a.descricao ? a.descricao : padrao);
const segundos = (ms) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;

/** Lê os degraus da Carga: { aguenta: 0|1|2|5|10, falha: degrau|null } ou null (sem dado). */
export function avaliarCarga(fonte, alvos) {
  const porMult = new Map(lista(fonte.degraus).map((d) => [Number(d.multiplicador), d]));
  if (!porMult.has(1)) return null;
  let aguenta = 0;
  for (const m of DEGRAUS) {
    const d = porMult.get(m);
    if (!d) return { aguenta, falha: null };
    const passou = !d.falhou && Number.isFinite(Number(d.p95Ms)) && Number(d.p95Ms) <= alvos.p95Ms;
    if (!passou) return { aguenta, falha: d };
    aguenta = m;
  }
  return { aguenta, falha: null };
}

// Cada fórmula devolve { nota|null, motivo, gargalo }, gargalo = { texto, local } | null.
export const FORMULAS = Object.freeze({
  carga(f, alvos) {
    const r = avaliarCarga(f, alvos);
    if (!r) return { nota: null, motivo: 'sem dado: o degrau de 1× não foi medido', gargalo: null };
    const nota = NOTA_POR_DEGRAU[r.aguenta];
    let gargalo = null;
    if (r.falha) {
      const d = r.falha;
      const fluxo = d.fluxo || 'o fluxo mais lento';
      const quanto = Number.isFinite(Number(d.p95Ms))
        ? `passa de ${segundos(Number(d.p95Ms))} no p95 (alvo ${alvos.p95Ms} ms)`
        : 'falha';
      const inicio = r.aguenta === 0 ? `Não aguenta nem 1×: ${fluxo} ${quanto}` : `Aguenta ${r.aguenta}×; no ${d.multiplicador}× ${fluxo} ${quanto}`;
      gargalo = { texto: comLocal(inicio + (d.motivo ? ` porque ${d.motivo}` : '') + '.', d), local: local(d) };
    } else if (r.aguenta < 10) {
      const prox = DEGRAUS[DEGRAUS.indexOf(r.aguenta) + 1];
      gargalo = { texto: `Aguenta ${r.aguenta}×; o degrau de ${prox}× ainda não foi medido.`, local: null };
    }
    const motivo = r.aguenta === 10 ? `p95 abaixo de ${alvos.p95Ms} ms até 10×`
      : r.aguenta === 0 ? 'falha já no 1×' : `aguenta até ${r.aguenta}×`;
    return { nota, motivo, gargalo };
  },
  dados(f) {
    const achados = lista(f.achados);
    const cresce = achados.filter((a) => a.tabelaCresce === true);
    const demais = achados.length - cresce.length;
    const nota = piso0(100 - 8 * cresce.length - 3 * demais);
    const pior = cresce[0] || achados[0];
    return {
      nota,
      motivo: achados.length ? `${cresce.length} achado(s) em tabela que cresce com o tenant, ${demais} nos demais` : 'nenhum achado de dados',
      gargalo: pior ? {
        texto: comLocal(`Dados: ${descr(pior, pior.tipo || 'consulta que não escala')}` + (pior.tabelaCresce ? ', em tabela que cresce com o tenant' : '') + '.', pior),
        local: local(pior),
      } : null,
    };
  },
  'estado-infra'(f) {
    const semReplica = lista(f.servicosSemReplica), memoria = lista(f.estadoEmMemoria);
    const nota = piso0(100 - 15 * semReplica.length - 5 * memoria.length);
    let gargalo = null;
    if (semReplica.length) {
      const s = semReplica[0];
      gargalo = { texto: comLocal(`O serviço ${s.servico || 'medido'} não pode rodar com 2 réplicas` + (s.descricao ? `: ${s.descricao}` : '') + '.', s), local: local(s) };
    } else if (memoria.length) {
      const m = memoria[0];
      gargalo = { texto: comLocal(`Estado guardado na memória do processo: ${descr(m, 'cache, sessão ou fila em variável')}; com 2 réplicas ele se divide.`, m), local: local(m) };
    }
    return {
      nota,
      motivo: semReplica.length + memoria.length ? `${semReplica.length} serviço(s) sem poder replicar, ${memoria.length} estado(s) em memória` : 'todo serviço pode rodar com 2+ réplicas',
      gargalo,
    };
  },
  'custo-unidade'(f) {
    const semTeto = lista(f.chamadasSemTeto), emLoop = lista(f.chamadasEmLoop);
    const nota = piso0(100 - 20 * semTeto.length - 10 * emLoop.length);
    let gargalo = null;
    if (semTeto.length) {
      const c = semTeto[0];
      gargalo = { texto: comLocal(`Chamada paga sem teto: ${descr(c, 'o custo por conversa não tem limite')}.`, c), local: local(c) };
    } else if (emLoop.length) {
      const c = emLoop[0];
      gargalo = { texto: comLocal(`Chamada paga dentro de loop: ${descr(c, 'o custo cresce com o tamanho da entrada')}.`, c), local: local(c) };
    }
    return {
      nota,
      motivo: semTeto.length + emLoop.length ? `${semTeto.length} chamada(s) sem teto, ${emLoop.length} em loop` : 'custo por conversa linear e com teto',
      gargalo,
    };
  },
  manutencao(f) {
    const achados = lista(f.achados);
    const a = achados[0];
    return {
      nota: piso0(100 - 5 * achados.length),
      motivo: achados.length ? `${achados.length} achado(s) de acoplamento` : 'nenhum achado de acoplamento',
      gargalo: a ? { texto: comLocal(`Manutenção: ${descr(a, 'acoplamento alto')}.`, a), local: local(a) } : null,
    };
  },
});

/**
 * Calcula a nota de escalabilidade.
 * @returns {{ geral: number|null,
 *   eixos: Array<{ chave, nome, nota: number|null, peso, pesoEfetivo, motivo }>,
 *   primeiroGargalo: { eixo, texto, local: string|null } | null }}
 */
export function calcularEscala(fontes = {}, pesos = ESCALA_PADRAO) {
  const erros = validarEscala(pesos);
  if (erros.length) throw new Error(erros.join('; '));
  const alvos = { ...ESCALA_PADRAO.alvos, ...(pesos.alvos || {}) };
  const gargalos = {};
  const eixos = EIXOS.map(({ chave, nome }) => {
    const fonte = fontes?.[chave];
    const r = ehObjeto(fonte) ? FORMULAS[chave](fonte, alvos) : { nota: null, motivo: 'sem dado: o eixo ainda não foi medido', gargalo: null };
    gargalos[chave] = r.gargalo;
    return { chave, nome, nota: r.nota === null ? null : Math.round(r.nota), peso: pesos.pesos[chave], motivo: r.motivo };
  });
  const { geral, maisPuxa } = montar(eixos, 'eixos');
  let primeiroGargalo = null;
  if (maisPuxa && gargalos[maisPuxa]) primeiroGargalo = { eixo: maisPuxa, ...gargalos[maisPuxa] };
  return { geral, eixos, primeiroGargalo };
}

/** Tendência a partir de escala.jsonl (texto ou array). Linha: { data, geral, eixos }. */
export function tendenciaEscala(historico) {
  return tendenciaGenerica(historico, { campo: 'eixos', chaves: CHAVES });
}
