# Arquitetura

Visão curta de como as peças conversam. Detalhe de cada rota fica em `central/README.md`.

## Peças

```
navegador ──HTTP 127.0.0.1:4747──> central/server.mjs ──spawn(argv)──> claude --bg / --cloud / -p
                                     │  rotas-planos.mjs (planos, papéis, score, escala, sessões, líderes)
                                     │  coletar.mjs (retrato: sessões, relatórios, artefatos, rotinas, notas)
                                     │  cerebro/ (índice + mapa)
                                     └─ lê ~/.claude/rotinas/estado/*.json e ~/.claude/limpeza/*.json

claude code ──mod painel-escritorio (mod/)──> coletar.mjs, fila-respostas/
claude code ──MCP cerebro (ferramentas/mcp-cerebro)──> cerebro/indice.json
systemd --user ──timers──> ferramentas/rotinas/*.mjs, cerebro/indexar.mjs, rotinas/rodar-verificador.mjs
```

## Convenção de pastas

- O repo inteiro mora em `~/.claude/agentic-os/` (é o que o `install.sh` faz). A pasta pode mudar com
  `AGENTIC_OS_DIR` (só os dados; o código acha os irmãos pelo próprio caminho).
- Dados que a Central cria ali dentro (fora do git): `planos/`, `lideres/`, `verificadores/`,
  `fila-respostas/`, `revisao/`, `central-<porta>.token`, `central/papeis.json`, `central/layout.json`,
  `central/score*.json(l)`, `central/escala*.json(l)`, `central/nuvem-repos.json`, `cerebro/indice.json`.
- Repos que os planos podem tocar: `~/Projects` por padrão (`CENTRAL_RAIZES="~/Projects:~/code"`; no Windows a lista usa `;`).
- Linux e Windows: tudo que muda de um sistema para o outro passa por `central/plataforma.mjs`, que recebe o
  `platform` por parâmetro (os testes rodam os dois sistemas em qualquer máquina). O CI testa os dois.

## Fluxo de um plano

1. Você conversa com o agente **orquestrador** (`claude --agent orquestrador`). Ele lê `papeis.json`,
   os planos ativos, os diários dos líderes e o cérebro, e grava `~/.claude/agentic-os/planos/AAAA-MM-DD-<nome>.md`
   com estado **proposto**. Ele não tem Bash nem Agent: não dispara nada.
2. A Central mostra o plano (`/api/planos`, `/api/plano`), confere o formato (`planos/plano.mjs → conferir`)
   e você escolhe onde cada item roda: `local` (`claude --bg`), `nuvem` (`claude --cloud`, só em repo
   listado em `central/nuvem-repos.json`, branch limpa e com push) ou `projects` (texto para colar).
3. **Aprovar e disparar** (POST `aprovar-plano`) lança os itens prontos. O prompt de cada item é
   embrulhado com `node central/planos/marcar.mjs iniciou|concluiu|falhou <plano> <id>`; a sessão marca
   o próprio andamento em `<plano>.registro.json`.
4. A cada 30 s o servidor dispara sozinho o item que destravou, **só** em plano já aprovado.

### Formato do bloco de item

````markdown
## P1 — Título curto
```prompt id=P1 repo=~/Projects/meu-app papel=executor area=web onde=local depende= porta="merge na main" custo=zero
Prompt autossuficiente: contexto, branch, caminhos, critério de pronto testável.
```
````

- `id` = letras + dígitos, único no arquivo; `depende=`/`conflita=` citam ids do mesmo arquivo, sem ciclo.
- `papel` existe em `papeis.json`; `modelo`, `esforco`, `permissao`, `onde` vêm de listas fechadas
  (`central/config/papeis.mjs`). `bypassPermissions` é recusado.
- `porta="…"` marca decisão que só humano toma (PROD, migration, merge, gasto); `custo="…"` com valor e moeda.
- Exemplo completo: `central/planos/exemplo.md`.

## Contratos entre módulos (os "C" dos comentários)

| | Módulo | O que expõe |
|---|---|---|
| C1 | `central/planos/plano.mjs` | `lerPlano(md, {papeis})`, `conferir(plano, {papeis, repoExiste})` |
| C2 | `central/planos/registro.mjs` | `ler`, `gravar` (atômico), `marcar`, `estadoDosItens`, `progresso` |
| C3 | `central/lancar/lancar.mjs` | argv de `--bg`/`--cloud`/`stop`/mensagem, `lancar()` via `spawn` injetado, `sessoes()` (`claude agents --json`) |
| C4 | `central/config/papeis.mjs`, `central/score/*.mjs` | papéis, score (7 dimensões) e nota de escalabilidade (5 eixos) |
| C5 | `central/rotas-planos.mjs` + `server.mjs` | rotas HTTP (GET leitura, POST `/api/acao/<id>` com token) |
| C6 | `agentes/*.md` | orquestrador, `lider-exemplo`, 5 verificadores |

Tudo que toca o mundo (fs, spawn, relógio) entra por injeção; os testes usam dublês (`test/stubs/`).

## Segurança

- Escuta só em `127.0.0.1`. Host e Origin precisam ser a própria Central.
- Todo POST exige o header `X-Central-Token`. O token é gerado a cada subida, gravado com modo 600 em
  `~/.claude/agentic-os/central-<porta>.token` e injetado na página (`<meta name="central-token">`).
- Nenhum texto do navegador vira shell: as ações são uma lista fechada e os processos rodam por `spawn(cmd, argv)`.
- "Abrir arquivo" só aceita caminhos (realpath) dentro de `~/.claude/`, do scratch do Claude e do próprio repo.

## Pontos de extensão

- **Tracker de tarefas** (GitHub Issues, Linear, Jira…): não vem embutido. Os verificadores gravam
  sugestões num bloco ```json em `## Tarefas sugeridas` do relatório; a Central só lista (`/api/sugestoes`).
  Para criar item no seu tracker, acrescente uma ação POST em `rotas-planos.mjs` (comentário no
  `verSugestoes`) que relê a sugestão e chama o CLI do tracker por argv fixo.
- **Score**: as dimensões `bugs` e `fluxo` aceitam fonte do seu tracker; sem fonte, saem "sem dado".
- **Líderes de área**: copie `agentes/lider-exemplo.md` para `~/.claude/agents/lider-<area>.md`; a Central
  passa a mostrar a área (pelo agente ou pelo diário `lideres/<area>.md`).
