/**
 * C1 — Lê um plano em markdown e confere se ele pode virar disparo.
 *
 * Porte de vendor/escritorio/src/plano.js. O plano continua sendo UM
 * documento que serve para gente ler e para a máquina disparar: o que a
 * máquina lê é o cabeçalho da cerca de cada bloco de prompt, que o markdown
 * ignora ao renderizar.
 *
 *   ```prompt id=P1 repo=~/Projects/x papel=executor area=web onde=local depende=P0 porta="merge na main"
 *
 * Mudanças em relação ao escritório:
 *   - chaves novas `papel`, `area`, `onde` e `esforco`; `modelo` passa a ter efeito;
 *   - `modo` (aba/fundo) saiu: quem diz onde o item roda agora é `onde`;
 *   - o item herda modelo/esforço/permissão/onde do seu papel (papeis.json) e
 *     pode sobrescrever cada um no próprio bloco;
 *   - `bypassPermissions` não é aceito.
 *
 * Sem E/S de propósito: entra texto, sai objeto. Quem toca o disco é quem chama.
 */

/** Onde um item roda (docs/arquitetura.md). */
export const ONDES = ['local', 'nuvem', 'projects'];

/**
 * Listas fechadas de modelo, esforço e permissão. Espelham as de
 * central/config/papeis.mjs (contrato C4, item N3), que roda em paralelo; a
 * integração (N7) pode trocar estas cópias por um import de lá.
 */
export const MODELOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSOES = ['default', 'acceptEdits', 'plan'];

/** Exclusividades que o formato entende. Hoje só a da pasta. */
export const EXCLUSIVIDADES = ['repo'];

/** Papel de quem não declara `papel=`. */
export const PAPEL_PADRAO = 'executor';

/**
 * Quando não há papeis.json à mão, o item sem `onde=` roda na máquina e sem
 * `permissao=` edita sozinho e para para perguntar comando (a lição do
 * escritório: em `auto` o classificador barra calado e a sessão fica sem a quem pedir).
 */
export const ONDE_PADRAO = 'local';
export const PERMISSAO_PADRAO = 'acceptEdits';

/** As chaves que o formato entende. O resto vai para `extras`, e a conferência reclama. */
export const CHAVES = [
  'id', 'repo', 'papel', 'area', 'onde', 'modelo', 'esforco', 'permissao',
  'depende', 'conflita', 'porta', 'custo', 'exclusivo',
];

/** As chaves que o papel preenche quando o bloco não diz. */
const HERDADAS = ['onde', 'modelo', 'esforco', 'permissao'];

/**
 * Lê os pares chave=valor do cabeçalho da cerca. Aceita aspas porque `porta`
 * é frase ("merge na main"), não palavra.
 */
export function lerAtributos(cabecalho) {
  const attrs = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s",]+(?:,\s*(?!\w+=)[^\s",]+)*))/g;
  let achado = re.exec(cabecalho);
  while (achado) {
    attrs[achado[1]] = achado[2] !== undefined ? achado[2] : achado[3];
    achado = re.exec(cabecalho);
  }
  return attrs;
}

/**
 * `P1 — Reservar ... *(Ana · repo `meu-repo`)*` -> `Reservar ...`
 *
 * O título não é atributo: ele já existe no cabeçalho markdown do item.
 */
export function limparTitulo(bruto, id) {
  // o id vai para dentro de um RegExp: sem escapar, um id torto lança no meio da leitura
  const alvo = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(bruto || '')
    .replace(/\*\([^)]*\)\*/g, '')
    .replace(/[`*]/g, '')
    .replace(new RegExp(`^[^A-Za-z0-9]*\\s*${alvo}\\s*[\\u2013\\u2014:-]\\s*`), '')
    .trim();
}

const lista = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ouNulo = (v) => (v === undefined || v === '' ? null : v);

/**
 * Preenche o que o bloco não disse com o padrão do papel do item.
 *
 * O que o bloco declarou vence sempre (`item.declarado`). Sem papel conhecido,
 * só `onde` e `permissao` ganham padrão — modelo e esforço ficam null, e quem
 * lança usa o padrão da conta.
 *
 * @param {object} item  como sai de lerPlano
 * @param {object} [papeis] { [papel]: { modelo, esforco, onde, permissao } }
 */
export function aplicarPapel(item, papeis) {
  const doPapel = (papeis && papeis[item.papel]) || {};
  const saida = { ...item };
  for (const chave of HERDADAS) {
    if ((item.declarado || []).includes(chave)) continue;
    saida[chave] = doPapel[chave] ?? null;
  }
  if (!saida.onde) saida.onde = ONDE_PADRAO;
  if (!saida.permissao) saida.permissao = PERMISSAO_PADRAO;
  return saida;
}

/**
 * Cercas que dizem um id e não viraram item: a palavra depois das crases
 * escrita errado (`prmopt`), ou uma cerca comum aberta que comeu o bloco
 * seguinte. Nos dois casos um plano de oito encolhe para sete calado.
 */
export function conferirCercas(texto, itens) {
  const nascidos = new Set((itens || []).map((it) => it.id).filter(Boolean));
  const problemas = [];

  String(texto || '').split(/\r?\n/).forEach((linha, i) => {
    const cerca = linha.match(/^ {0,3}`{3,}(\w*)(.*)$/);
    if (!cerca) return;
    const { id } = lerAtributos(cerca[2]);
    if (!id || nascidos.has(id)) return;
    problemas.push(cerca[1] === 'prompt'
      ? `linha ${i + 1}: a cerca de ${id} não virou item -- provavelmente uma cerca aberta antes dela engoliu o bloco`
      : `linha ${i + 1}: a cerca de ${id} diz "${cerca[1]}", e não "prompt"`);
  });

  return problemas;
}

/**
 * @param {string} texto o markdown inteiro do plano
 * @param {object} [opcoes] { papeis } — quando vem, cada item já sai com o
 *   padrão do seu papel aplicado (ver aplicarPapel)
 * @returns {{ titulo: string, itens: Array, erros: string[] }}
 *   `titulo` é o primeiro `# ` do documento; `erros` são as cercas perdidas,
 *   que só o texto cru revela. Cada item segue o contrato C1 e carrega ainda
 *   `extras` (chaves desconhecidas), `declarado`, `fechado` e `linha`.
 */
export function lerPlano(texto, { papeis } = {}) {
  const linhas = String(texto || '').split(/\r?\n/);
  const itens = [];
  let tituloDoPlano = '';
  let titulo = '';

  for (let i = 0; i < linhas.length; i += 1) {
    const topo = linhas[i].match(/^#\s+(.*)$/);
    if (topo) { if (!tituloDoPlano) tituloDoPlano = topo[1].trim(); continue; }
    const cabecalho = linhas[i].match(/^#{2,4}\s+(.*)$/);
    if (cabecalho) { titulo = cabecalho[1]; continue; }

    // qualquer cerca, não só a de prompt: um `## título` dentro de um bloco de
    // exemplo não pode virar o título do próximo item
    const abre = linhas[i].match(/^ {0,3}(`{3,})(\w*)(.*)$/);
    if (!abre) continue;

    // fecha com a MESMA quantidade de crases ou mais: deixa um prompt conter ```bash
    const fecha = new RegExp(`^ {0,3}${abre[1]}\`*\\s*$`);
    const corpo = [];
    let fim = i + 1;
    while (fim < linhas.length && !fecha.test(linhas[fim])) {
      corpo.push(linhas[fim]);
      fim += 1;
    }
    const fechado = fim < linhas.length;
    i = fim;

    if (abre[2] !== 'prompt') continue;

    const attrs = lerAtributos(abre[3]);
    const extras = {};
    for (const chave of Object.keys(attrs)) {
      if (!CHAVES.includes(chave)) extras[chave] = attrs[chave];
    }

    const item = {
      id: attrs.id || '',
      titulo: limparTitulo(titulo, attrs.id || ''),
      prompt: corpo.join('\n').trim(),
      repo: attrs.repo || '',
      papel: attrs.papel || PAPEL_PADRAO,
      area: ouNulo(attrs.area),
      onde: ouNulo(attrs.onde),
      modelo: ouNulo(attrs.modelo),
      esforco: ouNulo(attrs.esforco),
      permissao: ouNulo(attrs.permissao),
      depende: lista(attrs.depende),
      conflita: lista(attrs.conflita),
      porta: ouNulo(attrs.porta),
      custo: ouNulo(attrs.custo),
      exclusivo: ouNulo(attrs.exclusivo),
      // chave escrita errado (`depnde`) apagaria um gate em silêncio
      extras,
      declarado: HERDADAS.filter((c) => ouNulo(attrs[c]) !== null),
      // cerca sem fechamento engole o resto do documento: o item sai marcado
      // e quem recusa é a conferência
      fechado,
      // 1-based, linha de abertura da cerca
      linha: i - corpo.length,
    };
    itens.push(aplicarPapel(item, papeis));
  }

  return { titulo: tituloDoPlano, itens, erros: conferirCercas(texto, itens) };
}

/** Ciclo em `depende` trava o plano inteiro sem dizer nada. */
function ciclos(itens) {
  const mapa = new Map(itens.filter((it) => it.id).map((it) => [it.id, it.depende]));
  const problemas = [];
  const cor = new Map();

  const andar = (id, caminho) => {
    if (cor.get(id) === 2) return;
    if (cor.get(id) === 1) {
      problemas.push(`ciclo em depende: ${[...caminho, id].join(' -> ')}`);
      return;
    }
    cor.set(id, 1);
    for (const d of mapa.get(id) || []) if (mapa.has(d)) andar(d, [...caminho, id]);
    cor.set(id, 2);
  };

  for (const id of mapa.keys()) andar(id, []);
  return problemas;
}

/**
 * Tudo o que impede estes itens de serem despachados, um a um.
 *
 * @param {Array} itens
 * @param {object} opcoes { papeis, repoExiste } — `repoExiste(pasta) -> bool`,
 *   injetável para o teste não depender do disco
 */
export function conferirItens(itens, { papeis, repoExiste = () => true } = {}) {
  if (!itens.length) return ['nenhum bloco de prompt neste documento: é um plano?'];

  const problemas = [];
  const vistos = new Map();
  const ids = new Set(itens.map((it) => it.id).filter(Boolean));
  const nomesDePapel = papeis ? Object.keys(papeis) : null;

  for (const bruto of itens) {
    // quem montou o item à mão (sem lerPlano) também ganha a herança
    const it = papeis ? aplicarPapel(bruto, papeis) : bruto;

    if (it.fechado === false) {
      problemas.push(`linha ${it.linha}: a cerca do bloco ${it.id || 'sem id'} não fecha -- o que vem depois dele foi engolido`);
    }
    for (const chave of Object.keys(it.extras || {})) {
      problemas.push(`${it.id || `linha ${it.linha}`}: chave "${chave}" não existe (use ${CHAVES.join(', ')})`);
    }

    if (!it.id) { problemas.push(`linha ${it.linha}: bloco de prompt sem id`); continue; }
    if (vistos.has(it.id)) {
      problemas.push(`linha ${it.linha}: id ${it.id} repetido (já aparece na linha ${vistos.get(it.id)})`);
    } else {
      vistos.set(it.id, it.linha);
    }
    if (!/^[A-Za-z]+\d+$/.test(it.id)) {
      problemas.push(`linha ${it.linha}: id "${it.id}" fora do formato (P3, S4)`);
    }

    if (!it.repo) problemas.push(`${it.id}: falta repo=`);
    else if (!repoExiste(it.repo)) problemas.push(`${it.id}: a pasta ${it.repo} não existe`);
    if (!it.prompt) problemas.push(`${it.id}: o bloco de prompt está vazio`);

    if (nomesDePapel && !nomesDePapel.includes(it.papel)) {
      problemas.push(`${it.id}: papel "${it.papel}" não existe no papeis.json (use ${nomesDePapel.join(', ')})`);
    }
    if (it.area !== null && it.area !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(it.area)) {
      problemas.push(`${it.id}: area "${it.area}" fora do formato (minúsculas, números e hífen: web, app, infra)`);
    }
    if (it.onde && !ONDES.includes(it.onde)) {
      problemas.push(`${it.id}: onde "${it.onde}" não existe (use ${ONDES.join(', ')})`);
    }
    if (it.modelo && !MODELOS.includes(it.modelo)) {
      problemas.push(`${it.id}: modelo "${it.modelo}" não existe (use ${MODELOS.join(', ')})`);
    }
    if (it.esforco && !ESFORCOS.includes(it.esforco)) {
      problemas.push(`${it.id}: esforço "${it.esforco}" não existe (use ${ESFORCOS.join(', ')})`);
    }
    if (it.permissao && !PERMISSOES.includes(it.permissao)) {
      problemas.push(`${it.id}: permissão "${it.permissao}" não existe (use ${PERMISSOES.join(', ')})`);
    }
    if (it.exclusivo && !EXCLUSIVIDADES.includes(it.exclusivo)) {
      problemas.push(`${it.id}: exclusivo "${it.exclusivo}" não existe (use ${EXCLUSIVIDADES.join(', ')})`);
    }
    for (const outro of it.depende || []) {
      if (!ids.has(outro)) problemas.push(`${it.id}: depende de ${outro}, que não existe neste plano`);
    }
    for (const outro of it.conflita || []) {
      if (!ids.has(outro)) problemas.push(`${it.id}: conflita com ${outro}, que não existe neste plano`);
    }
  }

  return [...problemas, ...ciclos(itens)];
}

/**
 * A porta única: tudo o que impede este plano de virar disparo.
 *
 * As cercas perdidas vêm primeiro: quando TODO bloco se perde, a conferência
 * dos itens só tem a mensagem genérica de documento vazio.
 *
 * @param {{ itens: Array, erros?: string[] }} plano como sai de lerPlano
 * @param {object} opcoes { papeis, repoExiste }
 * @returns {string[]} vazia = ok
 */
export function conferir(plano, { papeis, repoExiste } = {}) {
  return [...((plano && plano.erros) || []), ...conferirItens((plano && plano.itens) || [], { papeis, repoExiste })];
}
