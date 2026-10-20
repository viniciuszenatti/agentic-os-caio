// Score do projeto (docs/arquitetura.md, contrato C4).
//
// Uma nota 0..100 por dimensão e uma geral. Cada dimensão vem de uma fonte medida,
// já lida por quem chama (este módulo não toca disco nem relógio).
//
// ── Formato de cada fonte (fontes = { [chave]: fonte | null }) ─────────────────
// fonte ausente (null/undefined) = "sem dado": a dimensão sai da média e os pesos
// das demais são redistribuídos.
//
//  seguranca   { criticos: n, altos: n, medios: n }
//              achados ABERTOS do último relatório do verificador de segurança.
//              nota = max(0, 100 − 25·criticos − 10·altos − 3·medios)
//
//  bugs        { urgentes: n, normais: n, achadosInterface: n }
//              bugs abertos no seu tracker, se houver (urgentes/normais) + achados do verificador de UI.
//              nota = max(0, 100 − 15·urgentes − 5·normais − 2·achadosInterface)
//
//  velocidade  { paginas: [{ url, performance }] }   performance = Lighthouse 0..100
//              m = média das páginas principais; nota = 100 se m ≥ alvos.lighthouse, senão m.
//              Lista vazia = sem dado.
//
//  apis        { processos: [{ nome, ms }] }   tempo medido de cada processo
//              nota = 100 × (processos com ms ≤ alvos.apiMs ÷ total). Lista vazia = sem dado.
//
//  testes      { verdes: n, total: n, principalVermelha: boolean }
//              nota = max(0, 100 × verdes ÷ total − (principalVermelha ? 20 : 0)).
//              total 0 = sem dado. (Cobertura ainda não entra na fórmula.)
//
//  fluxo       { fazendo: [{ id, diasParado }] }   itens em andamento no seu tracker (opcional; sem fonte = sem dado)
//              parada = diasParado > alvos.diasParado; nota = max(0, 100 − 10·paradas).
//              Lista vazia = 100 (nada parado).
//
//  ambientes   { ok: n, total: n }   checagens de DEV e HML nas últimas 24 h (saude.json)
//              nota = 100 × ok ÷ total. total 0 = sem dado.
//
// Toda nota é arredondada para inteiro. geral = Σ(nota·peso) ÷ Σ(peso das dimensões com dado),
// arredondada; null quando nenhuma dimensão tem dado.

export const DIMENSOES = Object.freeze([
  Object.freeze({ chave: 'seguranca', nome: 'Segurança' }),
  Object.freeze({ chave: 'bugs', nome: 'Bugs e interface' }),
  Object.freeze({ chave: 'velocidade', nome: 'Velocidade das páginas' }),
  Object.freeze({ chave: 'apis', nome: 'Desempenho das APIs' }),
  Object.freeze({ chave: 'testes', nome: 'Testes' }),
  Object.freeze({ chave: 'fluxo', nome: 'Fluxo de trabalho' }),
  Object.freeze({ chave: 'ambientes', nome: 'Ambientes' }),
]);

const CHAVES = DIMENSOES.map((d) => d.chave);

export const PESOS_PADRAO = Object.freeze({
  pesos: Object.freeze({ seguranca: 20, bugs: 20, velocidade: 15, apis: 15, testes: 15, fluxo: 10, ambientes: 5 }),
  alvos: Object.freeze({ lighthouse: 90, apiMs: 800, diasParado: 7 }),
});

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const piso0 = (v) => Math.max(0, v);

/**
 * Valida um score-pesos.json. Devolve a lista de erros (vazia = ok).
 * Pesos: as 7 dimensões, inteiros ≥ 0, somando 100. Alvos: números > 0.
 */
export function validarPesos(obj) {
  return validarConfig(obj, CHAVES, PESOS_PADRAO.alvos, 'score');
}

export function validarConfig(obj, chaves, alvosPadrao, rotulo) {
  const erros = [];
  if (!ehObjeto(obj)) return [`${rotulo}: precisa ser um objeto { pesos, alvos }`];
  if (!ehObjeto(obj.pesos)) return [`${rotulo}: falta o objeto "pesos"`];
  for (const k of Object.keys(obj.pesos)) {
    if (!chaves.includes(k)) erros.push(`${rotulo}: peso desconhecido "${k}"`);
  }
  let soma = 0;
  for (const k of chaves) {
    const p = obj.pesos[k];
    if (!Number.isInteger(p) || p < 0) erros.push(`${rotulo}: peso de "${k}" precisa ser inteiro ≥ 0`);
    else soma += p;
  }
  if (!erros.length && soma !== 100) erros.push(`${rotulo}: os pesos somam ${soma}, precisam somar 100`);
  if (obj.alvos !== undefined) {
    if (!ehObjeto(obj.alvos)) erros.push(`${rotulo}: "alvos" precisa ser um objeto`);
    else {
      for (const [k, v] of Object.entries(obj.alvos)) {
        if (!(k in alvosPadrao)) erros.push(`${rotulo}: alvo desconhecido "${k}"`);
        else if (typeof v !== 'number' || !(v > 0)) erros.push(`${rotulo}: alvo "${k}" precisa ser número > 0`);
      }
    }
  }
  return erros;
}

// ── fórmulas (cada uma devolve { nota|null, motivo }) ─────────────────────────

const SEM_DADO = (motivo = 'sem dado: a fonte ainda não foi medida') => ({ nota: null, motivo });

export const FORMULAS = Object.freeze({
  seguranca(f) {
    const c = num(f.criticos), a = num(f.altos), m = num(f.medios);
    const nota = piso0(100 - 25 * c - 10 * a - 3 * m);
    const motivo = c + a + m === 0 ? 'nenhum achado de segurança aberto'
      : `${c} crítico(s), ${a} alto(s), ${m} médio(s) abertos`;
    return { nota, motivo };
  },
  bugs(f) {
    const u = num(f.urgentes), n = num(f.normais), i = num(f.achadosInterface);
    const nota = piso0(100 - 15 * u - 5 * n - 2 * i);
    const motivo = u + n + i === 0 ? 'nenhum bug aberto'
      : `${u} bug(s) urgente(s), ${n} normal(is), ${i} achado(s) de interface`;
    return { nota, motivo };
  },
  velocidade(f, alvos) {
    const paginas = Array.isArray(f.paginas) ? f.paginas.filter((p) => Number.isFinite(Number(p?.performance))) : [];
    if (!paginas.length) return SEM_DADO('sem dado: nenhuma página medida');
    const media = paginas.reduce((s, p) => s + Number(p.performance), 0) / paginas.length;
    const nota = media >= alvos.lighthouse ? 100 : Math.max(0, Math.min(100, media));
    return { nota, motivo: `Lighthouse médio ${Math.round(media)} em ${paginas.length} página(s) (alvo ${alvos.lighthouse})` };
  },
  apis(f, alvos) {
    const procs = Array.isArray(f.processos) ? f.processos.filter((p) => Number.isFinite(Number(p?.ms))) : [];
    if (!procs.length) return SEM_DADO('sem dado: nenhum processo medido');
    const dentro = procs.filter((p) => Number(p.ms) <= alvos.apiMs).length;
    return { nota: (100 * dentro) / procs.length, motivo: `${dentro} de ${procs.length} processo(s) dentro de ${alvos.apiMs} ms` };
  },
  testes(f) {
    const total = num(f.total), verdes = Math.min(num(f.verdes), total);
    if (total <= 0) return SEM_DADO('sem dado: nenhuma suíte registrada');
    const nota = piso0((100 * verdes) / total - (f.principalVermelha ? 20 : 0));
    const motivo = `${verdes} de ${total} suíte(s) verde(s)` + (f.principalVermelha ? '; a suíte principal está vermelha (−20)' : '');
    return { nota, motivo };
  },
  fluxo(f, alvos) {
    const fazendo = Array.isArray(f.fazendo) ? f.fazendo : [];
    const paradas = fazendo.filter((t) => num(t?.diasParado) > alvos.diasParado).length;
    return {
      nota: piso0(100 - 10 * paradas),
      motivo: paradas === 0 ? `nenhuma tarefa "fazendo" parada há mais de ${alvos.diasParado} dias`
        : `${paradas} tarefa(s) "fazendo" parada(s) há mais de ${alvos.diasParado} dias`,
    };
  },
  ambientes(f) {
    const total = num(f.total), ok = Math.min(num(f.ok), total);
    if (total <= 0) return SEM_DADO('sem dado: nenhuma checagem nas últimas 24 h');
    return { nota: (100 * ok) / total, motivo: `${ok} de ${total} checagem(ns) de DEV/HML ok nas últimas 24 h` };
  },
});

/**
 * Média ponderada que ignora as entradas sem nota (pesos redistribuídos).
 * itens: [{ nota|null, peso }] → inteiro 0..100 ou null.
 */
export function mediaPonderada(itens) {
  let soma = 0, pesos = 0;
  for (const { nota, peso } of itens) {
    if (nota === null || nota === undefined || !(peso > 0)) continue;
    soma += nota * peso;
    pesos += peso;
  }
  return pesos > 0 ? Math.round(soma / pesos) : null;
}

/**
 * Calcula o score.
 * @returns {{ geral: number|null, dimensoes: Array<{chave,nome,nota:number|null,peso,pesoEfetivo,motivo}>, maisPuxa: string|null }}
 *   pesoEfetivo = peso redistribuído entre as dimensões com dado (soma 100); 0 se sem dado.
 *   maisPuxa = chave da dimensão que mais tira pontos da geral (o "criar plano para subir isto").
 */
export function calcular(fontes = {}, pesos = PESOS_PADRAO) {
  const erros = validarPesos(pesos);
  if (erros.length) throw new Error(erros.join('; '));
  const alvos = { ...PESOS_PADRAO.alvos, ...(pesos.alvos || {}) };
  const dimensoes = DIMENSOES.map(({ chave, nome }) => {
    const fonte = fontes?.[chave];
    const { nota, motivo } = ehObjeto(fonte) ? FORMULAS[chave](fonte, alvos) : SEM_DADO();
    return { chave, nome, nota: nota === null ? null : Math.round(nota), peso: pesos.pesos[chave], motivo };
  });
  return montar(dimensoes, 'dimensoes');
}

export function montar(lista, campo) {
  const somaComDado = lista.reduce((s, d) => s + (d.nota === null ? 0 : d.peso), 0);
  for (const d of lista) d.pesoEfetivo = d.nota === null || somaComDado === 0 ? 0 : (100 * d.peso) / somaComDado;
  let maisPuxa = null, perda = 0;
  for (const d of lista) {
    if (d.nota === null) continue;
    const p = (100 - d.nota) * d.peso;
    if (p > perda) { perda = p; maisPuxa = d.chave; }
  }
  return { geral: mediaPonderada(lista), [campo]: lista, maisPuxa };
}

// ── tendência ────────────────────────────────────────────────────────────────

function lerHistorico(historico) {
  if (typeof historico === 'string') {
    return historico.split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  }
  return Array.isArray(historico) ? historico.filter(ehObjeto) : [];
}

// Aceita { chave: nota } ou [{ chave, nota }] (a saída de calcular gravada inteira).
function notasDe(entrada, campo) {
  const v = entrada[campo];
  if (Array.isArray(v)) return Object.fromEntries(v.filter(ehObjeto).map((d) => [d.chave, d.nota ?? null]));
  return ehObjeto(v) ? v : {};
}

function comparar(valores) {
  const comDado = valores.filter((v) => typeof v === 'number');
  const atual = typeof valores.at(-1) === 'number' ? valores.at(-1) : null;
  if (atual === null) return { atual: null, anterior: null, delta: null, direcao: 'sem-dado', seta: '' };
  if (comDado.length < 2) return { atual, anterior: null, delta: null, direcao: 'sem-historico', seta: '' };
  const anterior = comDado.at(-2);
  const delta = atual - anterior;
  const direcao = delta > 0 ? 'sobe' : delta < 0 ? 'desce' : 'estavel';
  return { atual, anterior, delta, direcao, seta: { sobe: '↑', desce: '↓', estavel: '→' }[direcao] };
}

/**
 * Tendência a partir do histórico (score.jsonl: texto, ou array já lido).
 * Linha: { data, geral, dimensoes: { chave: nota|null } | [{ chave, nota }] }
 * Compara a última nota com a anterior que tinha dado.
 * @returns {{ geral: Tend, dimensoes: { [chave]: Tend } }}
 *   Tend = { atual, anterior, delta, direcao: 'sobe'|'desce'|'estavel'|'sem-historico'|'sem-dado', seta }
 */
export function tendencia(historico, { campo = 'dimensoes', chaves = CHAVES } = {}) {
  const linhas = lerHistorico(historico);
  const porChave = {};
  for (const k of chaves) porChave[k] = comparar(linhas.map((l) => notasDe(l, campo)[k] ?? null));
  return { geral: comparar(linhas.map((l) => (typeof l.geral === 'number' ? l.geral : null))), [campo]: porChave };
}
