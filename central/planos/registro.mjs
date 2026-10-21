/**
 * C2 — O registro de um plano: em que estado o plano está (proposto,
 * aprovado, descartado, encerrado) e o que aconteceu com cada item (qual
 * sessão, onde rodou, quando disparou, começou, terminou ou falhou).
 *
 * Porte de vendor/escritorio/src/registro.js (gravação atômica, recusa de
 * registro corrompido, recusa de gravar por cima do registro de outro plano)
 * e de vendor/escritorio/src/despacho.js (as travas depende/conflita/exclusivo
 * e o estado de cada item).
 *
 * O que mudou em relação ao escritório:
 *   - o disco entra por injeção (`{ fs }`, a API de `node:fs/promises`);
 *   - `marcar` é PURA: devolve um registro novo e não mexe no que recebeu;
 *   - sem lista de sessões vivas: o estado vem só das marcas do registro.
 *     Item disparado ou iniciado conta como "em andamento" até concluir ou
 *     falhar — é a leitura conservadora, que nunca libera um conflito no escuro;
 *   - estados novos: `entregue-projects` e `falhou`; e o plano tem estado próprio.
 *
 * Este módulo RECUSA em vez de degradar: um registro lido como vazio libera
 * um item que pode estar rodando agora. Recusar custa uma mensagem de erro;
 * seguir com o palpite errado custa um disparo duplicado.
 */

import { ONDES } from './plano.mjs';

/** Estados do plano. */
export const ESTADOS_DO_PLANO = ['proposto', 'aprovado', 'descartado', 'encerrado'];

/** Estados de cada item. */
export const ESTADOS_DO_ITEM = ['bloqueado', 'pronto', 'disparado', 'iniciado', 'concluido', 'entregue-projects', 'falhou'];

/** Eventos que `marcar` entende. */
export const EVENTOS = ['disparou', 'iniciou', 'concluiu', 'falhou', 'entregou-projects', 'reabriu'];

/** Para onde cada estado do plano pode ir. */
const TRANSICOES = {
  proposto: ['aprovado', 'descartado'],
  aprovado: ['encerrado'],
  descartado: [],
  encerrado: [],
};

// reabertoEm só serve para a junção saber que o 'tentar de novo' é a marca mais nova; não define estado.
const MARCAS = ['disparadoEm', 'iniciadoEm', 'concluidoEm', 'falhouEm', 'reabertoEm'];
const CAMPOS_DO_ITEM = ['onde', 'sessao', 'nome', 'url', ...MARCAS, 'motivo'];

const ausente = (v) => v === undefined || v === null;
const ehObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Um registro novo, de plano que ainda não foi aprovado. */
export function vazio(plano = null) {
  return { plano, estado: 'proposto', aprovadoEm: null, estadoEm: null, itens: {} };
}

/** O item na forma de hoje: todo campo existe, nulo quando não há. */
function normalizarItem(r) {
  const saida = {};
  for (const campo of CAMPOS_DO_ITEM) saida[campo] = r[campo] ?? null;
  return saida;
}

function normalizar(bruto) {
  const itens = {};
  for (const [id, r] of Object.entries(bruto.itens || {})) itens[id] = normalizarItem(r);
  return {
    plano: bruto.plano ?? null,
    estado: bruto.estado ?? 'proposto',
    aprovadoEm: bruto.aprovadoEm ?? null,
    estadoEm: bruto.estadoEm ?? null,
    itens,
  };
}

/** Um item gravado presta? Só máquina escreve aqui, então forma estranha é edição à mão. */
function itemOk(r) {
  if (!ehObjeto(r)) return false;
  // sessão vazia lida como "não está rodando" cegaria a trava de conflito
  if (!(ausente(r.sessao) || (typeof r.sessao === 'string' && r.sessao !== ''))) return false;
  if (!(ausente(r.onde) || ONDES.includes(r.onde))) return false;
  if (!MARCAS.every((m) => ausente(r[m]) || Number.isFinite(r[m]))) return false;
  return ['nome', 'url', 'motivo'].every((c) => ausente(r[c]) || typeof r[c] === 'string');
}

/** O objeto guardado é utilizável? */
function saoDados(bruto) {
  if (!ehObjeto(bruto)) return false;
  if (!(ausente(bruto.estado) || ESTADOS_DO_PLANO.includes(bruto.estado))) return false;
  if (!(ausente(bruto.aprovadoEm) || Number.isFinite(bruto.aprovadoEm))) return false;
  if (!(ausente(bruto.estadoEm) || Number.isFinite(bruto.estadoEm))) return false;
  if (!(ausente(bruto.plano) || typeof bruto.plano === 'string')) return false;
  if (bruto.itens === undefined) return true;
  // "itens": [] é o que se digita para "coleção vazia" ao consertar à mão, e o
  // JSON.stringify some com as chaves de um array depois
  if (!ehObjeto(bruto.itens)) return false;
  return Object.values(bruto.itens).every(itemOk);
}

/** Lê e valida o arquivo cru. null quando o arquivo não existe. */
async function abrir(caminho, fs) {
  let cru;
  try {
    cru = await fs.readFile(caminho, 'utf8');
  } catch (erro) {
    // arquivo que nunca existiu e plano sem registro são a mesma coisa; qualquer
    // OUTRO erro de leitura não é, e passar por vazio seria dizer "nada rodando" sem ter olhado
    if (erro && erro.code === 'ENOENT') return null;
    throw new Error(`não consegui ler ${caminho}: ${erro && erro.message}`);
  }
  let bruto;
  try { bruto = JSON.parse(cru); } catch { bruto = null; }
  if (!saoDados(bruto)) {
    throw new Error(`${caminho} está corrompido; conserte à mão ou apague — apagar perde o registro`
      + ' de quais sessões rodaram quais itens');
  }
  return bruto;
}

/**
 * O registro deste caminho, ou um vazio (estado `proposto`) quando ele ainda
 * não existe. Não grava nada: o arquivo só nasce no primeiro `gravar`.
 *
 * @param {string} caminho o .json do registro
 * @param {object} opcoes { fs } — API de node:fs/promises (readFile)
 */
export async function ler(caminho, { fs }) {
  const bruto = await abrir(caminho, fs);
  return bruto ? normalizar(bruto) : vazio();
}

/** O item com a marca mais recente vence: é a última coisa que aconteceu com ele. */
function maisRecente(r) {
  return Math.max(0, ...MARCAS.map((m) => r[m] || 0));
}

/**
 * Grava o registro: escreve num temporário e troca de nome no fim.
 *
 * `writeFile` direto no arquivo final trunca antes de escrever, e uma
 * interrupção no meio deixaria metade do JSON — o "corrompido" que `ler`
 * recusa. O temporário leva o pid: com nome fixo, dois processos escrevem
 * no MESMO temporário e um publica o conteúdo do outro.
 *
 * Antes de escrever, relê o disco e funde item por item: a Central disparando
 * P2 enquanto a sessão de P1 marca `concluiu` não pode apagar a marca de P1.
 * Em cada item vence o lado com a marca mais recente; no topo, vence o lado
 * com `estadoEm` mais recente. Recusa gravar por cima do registro de outro plano.
 *
 * @param {object} opcoes { fs, pid } — fs com readFile, writeFile, rename, mkdir, rm
 * @returns {Promise<object>} o registro que ficou no disco
 */
export async function gravar(caminho, registro, { fs, pid = process.pid }) {
  const pasta = caminho.replace(/[\\/][^\\/]*$/, '');
  if (pasta && pasta !== caminho && fs.mkdir) await fs.mkdir(pasta, { recursive: true });

  const doDisco = await abrir(caminho, fs);
  const meu = normalizar(registro);
  if (doDisco && doDisco.plano && meu.plano && doDisco.plano !== meu.plano) {
    throw new Error(`${caminho} é o registro de ${doDisco.plano}, e não de ${meu.plano}. Se são dois planos`
      + ' diferentes com o mesmo nome de arquivo, renomeie um deles');
  }

  let juntos = meu;
  if (doDisco) {
    const disco = normalizar(doDisco);
    const itens = { ...disco.itens };
    for (const [id, r] of Object.entries(meu.itens)) {
      if (!itens[id] || maisRecente(r) >= maisRecente(itens[id])) itens[id] = r;
    }
    const topoMeu = (meu.estadoEm || 0) >= (disco.estadoEm || 0);
    const topo = topoMeu ? meu : disco;
    juntos = {
      plano: meu.plano ?? disco.plano,
      estado: topo.estado,
      aprovadoEm: topo.aprovadoEm ?? (topoMeu ? disco.aprovadoEm : meu.aprovadoEm),
      estadoEm: topo.estadoEm,
      itens,
    };
  }

  const temp = `${caminho}.${pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(juntos, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temp, caminho);
  } catch (erro) {
    try { await fs.rm(temp, { force: true }); } catch { /* o temporário é descartável */ }
    throw erro;
  }
  return juntos;
}

function trocarEstado(registro, para, agora) {
  const de = registro.estado || 'proposto';
  if (de === para) return { ...registro, itens: { ...registro.itens } };
  if (!TRANSICOES[de] || !TRANSICOES[de].includes(para)) {
    throw new Error(`o plano está ${de} e não pode ir para ${para}`);
  }
  return {
    ...registro,
    estado: para,
    estadoEm: agora,
    aprovadoEm: para === 'aprovado' ? agora : (registro.aprovadoEm ?? null),
    itens: { ...registro.itens },
  };
}

/** proposto -> aprovado. Puro. */
export function aprovar(registro, { agora = Date.now() } = {}) { return trocarEstado(registro, 'aprovado', agora); }
/** proposto -> descartado. Puro. */
export function descartar(registro, { agora = Date.now() } = {}) { return trocarEstado(registro, 'descartado', agora); }
/** aprovado -> encerrado (tirado da frente). Puro. */
export function encerrar(registro, { agora = Date.now() } = {}) { return trocarEstado(registro, 'encerrado', agora); }

const VAZIO_DO_ITEM = Object.freeze(Object.fromEntries(CAMPOS_DO_ITEM.map((c) => [c, null])));

/**
 * Anota um evento num item. PURA: devolve um registro novo.
 *
 * - `disparou` { onde, sessao, nome, url }: execução nova — as marcas da
 *   anterior caem. Só com o plano aprovado.
 * - `entregou-projects` { nome, url }: o mesmo, com onde=projects (o texto foi
 *   entregue ao Claude Projects oficial).
 * - `iniciou` { sessao }: fato relatado pela sessão. Já iniciado pela mesma
 *   sessão não muda (a primeira marca vale); por outra, é execução nova.
 * - `concluiu`: já concluído não muda. Sem `iniciou` antes, as duas marcas
 *   nascem juntas (a sessão pulou a primeira; o item da nuvem que só avisa no fim).
 * - `falhou` { motivo }: o item parou sem concluir. Concluído não volta a falhar.
 *
 * `onde` nos dados de qualquer evento atualiza onde o item rodou.
 */
export function marcar(registro, id, evento, dados = {}, { agora = Date.now() } = {}) {
  if (!EVENTOS.includes(evento)) {
    throw new Error(`evento desconhecido: ${evento || '(vazio)'} — use ${EVENTOS.join(', ')}`);
  }
  if (!/^[A-Za-z]+\d+$/.test(String(id || ''))) throw new Error(`id "${id}" fora do formato (P3, S4)`);
  const d = dados || {};
  if (!ausente(d.onde) && !ONDES.includes(d.onde)) {
    throw new Error(`onde "${d.onde}" não existe (use ${ONDES.join(', ')})`);
  }
  if (!ausente(d.sessao) && (typeof d.sessao !== 'string' || d.sessao === '')) {
    throw new Error(`sessão inválida para ${id}`);
  }

  const atual = { ...VAZIO_DO_ITEM, ...((registro.itens || {})[id] || {}) };
  const onde = d.onde ?? atual.onde;
  let novo;

  if (evento === 'reabriu') {
    // "Tentar de novo": só item que falhou; as marcas caem e ele volta a pronto (ou bloqueado, se depender de algo).
    if (!atual.falhouEm) throw new Error(`${id} não falhou: só item com falha pode tentar de novo`);
    if (registro.estado !== 'aprovado') throw new Error(`o plano está ${registro.estado || 'proposto'}: só plano aprovado reabre item`);
    novo = { ...VAZIO_DO_ITEM, onde: onde ?? 'local', reabertoEm: agora };
  } else if (evento === 'disparou' || evento === 'entregou-projects') {
    if (registro.estado !== 'aprovado') {
      throw new Error(`o plano está ${registro.estado || 'proposto'}: só plano aprovado dispara item`);
    }
    novo = {
      ...VAZIO_DO_ITEM,
      onde: evento === 'entregou-projects' ? 'projects' : (onde ?? 'local'),
      sessao: d.sessao ?? null,
      nome: d.nome ?? null,
      url: d.url ?? null,
      disparadoEm: agora,
    };
  } else if (evento === 'iniciou') {
    if (atual.iniciadoEm && !atual.concluidoEm && !atual.falhouEm && atual.sessao === (d.sessao ?? atual.sessao)) {
      return { ...registro, itens: { ...registro.itens } };
    }
    novo = {
      ...atual, onde, sessao: d.sessao ?? atual.sessao, iniciadoEm: agora,
      concluidoEm: null, falhouEm: null, motivo: null,
    };
  } else if (evento === 'concluiu') {
    if (atual.concluidoEm) return { ...registro, itens: { ...registro.itens } };
    novo = {
      ...atual, onde, sessao: d.sessao ?? atual.sessao, iniciadoEm: atual.iniciadoEm ?? agora,
      concluidoEm: agora, falhouEm: null, motivo: null,
    };
  } else {
    if (atual.concluidoEm) return { ...registro, itens: { ...registro.itens } };
    novo = { ...atual, onde, falhouEm: agora, motivo: d.motivo ? String(d.motivo) : null };
  }

  return { ...registro, itens: { ...registro.itens, [id]: novo } };
}

/** Com quem este item conflita, contando as duas direções. */
export function conflitantes(itens, id) {
  const eu = itens.find((it) => it.id === id);
  const todos = new Set(eu ? (eu.conflita || []) : []);
  for (const it of itens) if ((it.conflita || []).includes(id)) todos.add(it.id);
  todos.delete(id);
  return [...todos];
}

/** O estado que as marcas do registro dão a um item, ou null se ele nunca saiu do lugar. */
function estadoDasMarcas(r) {
  if (!r) return null;
  if (r.concluidoEm) return 'concluido';
  if (r.falhouEm) return 'falhou';
  if (r.iniciadoEm) return 'iniciado';
  if (r.disparadoEm) return r.onde === 'projects' ? 'entregue-projects' : 'disparado';
  return null;
}

const EM_ANDAMENTO = new Set(['disparado', 'iniciado', 'entregue-projects']);

/** Disparado, iniciado ou entregue ao Projects, e ainda sem concluir nem falhar. */
export function emAndamento(r) {
  return EM_ANDAMENTO.has(estadoDasMarcas(r));
}

/** Em que pé está a predecessora — a frase do bloqueio diz o que falta. */
function peDaPredecessora(d, r) {
  const e = estadoDasMarcas(r);
  if (!e) return `depende de ${d}, que ainda não foi disparada`;
  if (e === 'falhou') return `depende de ${d}, que falhou${r.motivo ? ` (${r.motivo})` : ''}`;
  if (e === 'disparado') return `depende de ${d}, que foi disparada e ainda não começou`;
  if (e === 'entregue-projects') return `depende de ${d}, que está no Claude Projects e ainda não concluiu`;
  return `depende de ${d}, que está em andamento`;
}

const mesmaPasta = (a, b) => {
  const n = (p) => String(p || '').trim().replace(/[\\/]+$/, '');
  return n(a) !== '' && n(a) === n(b);
};

/**
 * O estado de cada item com o porquê.
 *
 * Estados das marcas vêm primeiro (concluido, falhou, iniciado, disparado,
 * entregue-projects). Item que ainda não saiu do lugar é `pronto` ou
 * `bloqueado` pelas travas:
 *   - plano descartado ou encerrado: nada mais dispara;
 *   - `depende`: toda predecessora precisa estar CONCLUÍDA;
 *   - `conflita` (vale nos dois sentidos): nenhuma conflitante em andamento;
 *   - `exclusivo=repo`: nenhum outro item deste plano em andamento na mesma pasta.
 * `porta` e `custo` não bloqueiam: viram aviso.
 *
 * Plano `proposto` calcula as travas normalmente: `pronto` ali quer dizer
 * "dispara assim que for aprovado".
 *
 * @returns {{ [id]: { estado, motivo, avisos, desde } }}
 */
export function detalharEstados(plano, registro, { agora = Date.now() } = {}) {
  const itens = (plano && plano.itens) || [];
  const marcas = (registro && registro.itens) || {};
  const saida = {};

  for (const it of itens) {
    const r = marcas[it.id];
    const avisos = [];
    if (it.porta) avisos.push(`porta única: ${it.porta}`);
    if (it.custo) avisos.push(`custo: ${it.custo}`);

    const dasMarcas = estadoDasMarcas(r);
    if (dasMarcas) {
      const desde = r.concluidoEm || r.falhouEm || r.iniciadoEm || r.disparadoEm;
      saida[it.id] = {
        estado: dasMarcas,
        motivo: dasMarcas === 'falhou' ? (r.motivo || '') : '',
        avisos,
        desde,
        minutos: Math.max(0, Math.round((agora - desde) / 60_000)),
      };
      continue;
    }

    let motivo = '';
    if (registro && (registro.estado === 'descartado' || registro.estado === 'encerrado')) {
      motivo = `o plano foi ${registro.estado}`;
    }
    for (const d of it.depende || []) {
      if (motivo) break;
      if (estadoDasMarcas(marcas[d]) !== 'concluido') motivo = peDaPredecessora(d, marcas[d]);
    }
    for (const c of conflitantes(itens, it.id)) {
      if (motivo) break;
      if (emAndamento(marcas[c])) motivo = `conflita com ${c}, que está em andamento`;
    }
    if (!motivo && it.exclusivo === 'repo') {
      const ocupante = itens.find((o) => o.id !== it.id && mesmaPasta(o.repo, it.repo) && emAndamento(marcas[o.id]));
      if (ocupante) motivo = `a pasta ${it.repo} está com ${ocupante.id} em andamento — o item pediu a pasta só para ele (exclusivo=repo)`;
    }

    saida[it.id] = { estado: motivo ? 'bloqueado' : 'pronto', motivo, avisos, desde: null, minutos: null };
  }
  return saida;
}

/** C2: `{ [id]: Estado }`, só o nome do estado. O porquê está em `detalharEstados`. */
export function estadoDosItens(plano, registro, opcoes = {}) {
  const detalhe = detalharEstados(plano, registro, opcoes);
  return Object.fromEntries(Object.entries(detalhe).map(([id, d]) => [id, d.estado]));
}

/**
 * Quanto do plano está concluído. Conta só os itens DO DOCUMENTO (id que só
 * existe no registro não conta) e só `concluido` — item entregue ao Projects
 * entra no total e conta quando concluir. `pct` arredonda para baixo: 100 só
 * com tudo concluído.
 */
export function progresso(plano, registro) {
  const itens = (plano && plano.itens) || [];
  const marcas = (registro && registro.itens) || {};
  const total = itens.length;
  const concluidos = itens.filter((it) => estadoDasMarcas(marcas[it.id]) === 'concluido').length;
  return { concluidos, total, pct: total ? Math.floor((concluidos * 100) / total) : 0 };
}
