# Central

Tela de comando local do Agentic OS: http://127.0.0.1:4747

- `server.mjs` — Node puro, sem dependências, escuta só em 127.0.0.1:4747.
- `index.html` — a página (CSS/JS inline, fontes locais Inter e JetBrains Mono, sem CDN). É lida a cada
  pedido: editou, recarregue a página. Editou o servidor: reinicie o processo.
- Variáveis: `CENTRAL_PORT` (4747), `CENTRAL_HOST` (127.0.0.1), `CENTRAL_HOME` (home do usuário),
  `AGENTIC_OS_DIR` (`~/.claude/agentic-os`), `CENTRAL_RAIZES` (`~/Projects`), `CENTRAL_TERMINAL` (`konsole`),
  `NOTAS_DIR` (pasta de notas, opcional).
- Serviço (opcional): `ferramentas/systemd/agentic-os-central.service`.

## Leitura (GET)

`/api/retrato` (coletar.mjs, cache 30 s) · `/api/saude` · `/api/contexto` · `/api/limpeza` · `/api/deck` ·
`/api/execucoes` · `/cerebro/` · `/api/nos` (amostra do índice do cérebro) · `/api/anel` (skills e agentes) ·
`/api/busca?q=` · `/api/hoje` (linha do tempo das sessões de hoje) · `/api/respostas` · `/api/capacidade` ·
`/api/modo-build` · `/api/layout` · `/api/revisao` · `/api/noticias` · `/api/fechamento` · `/api/gemini` ·
`/api/escala` · `/api/estado/<nome>` (lista fechada: `capacidade · vigia-ci · saude-rotinas · lembrete-commit · onde-parei · cota · saude`).

Rotas de planos (`rotas-planos.mjs`): `/api/planos` · `/api/plano?arquivo=` · `/api/papeis` · `/api/score` ·
`/api/sessoes` · `/api/lideres` · `/api/sugestoes`.

Arquivo de estado ausente responde `{ ausente: true }`: a Central funciona sem nenhuma rotina instalada.

## Ações (POST `/api/acao/<id>`, lista fechada, header `X-Central-Token` obrigatório)

- Máquina: `diagnostico` · `saude` · `reindexar` · `modo-build-on` · `modo-build-off` · `encerrar-dia` · `abrir` `{caminho}`.
- Deck (gastam cota do plano; modelo haiku|sonnet|opus, esforço low|medium|high): `deck-standup` (resume
  planos e diários dos líderes) · `deck-limpeza` · `perguntar` `{pergunta ≤ 300, modelo haiku|sonnet}` ·
  `deck-gemini` (só se existir `~/.claude/rotinas/gemini-rodar.sh`, script seu).
- Sessões: `fechar-sessao` (só parada há 24 h+) · `responder` `{sessionId, texto ≤ 2000}` (o mod entrega) ·
  `parar-sessao` · `remover-sessao` · `abrir-terminal` · `mensagem-sessao`.
- Planos: `aprovar-plano` · `descartar-plano` · `tentar-de-novo` · `concluir-projects` · `salvar-papeis` · `salvar-pesos`.
- Painel: `salvar-layout` · `revisar` `{id, decisao: aprovar|rejeitar, comentario ≤ 500}` · `escala-varrer` `{alvo}`.

Proteções: Host e Origin precisam ser a própria Central; corpo até 8 KB; uma execução por ação de cada vez
(409 se repetir); nenhum texto do cliente vira comando de shell.

## Token

Gerado a cada subida (32 bytes aleatórios), gravado com modo 600 em `~/.claude/agentic-os/central-<porta>.token`
e injetado na página. Para chamar a API pelo terminal:

```bash
TOKEN=$(cat ~/.claude/agentic-os/central-4747.token)
curl -s -X POST -H "Origin: http://127.0.0.1:4747" -H "X-Central-Token: $TOKEN" \
  -H 'content-type: application/json' -d '{}' http://127.0.0.1:4747/api/acao/reindexar
```

## Configuração por arquivo (ao lado do server.mjs, fora do git)

- `papeis.json` — modelo, esforço, onde e permissão de cada papel (padrão em `config/papeis.mjs`).
- `nuvem-repos.json` — `{ "comApp": ["seu-usuario/*"] }`: repos do GitHub com o app do Claude instalado
  (sem o arquivo, nenhum item vai para a nuvem).
- `escala-pesos.json` — pesos, alvos e repos da nota de escalabilidade; `carga.hostsDev` lista os hosts de
  DEV aceitos pelo teste de carga (`escala/carga.mjs`, só pelo terminal, nunca HML/PROD).
- `dev/fake-api.mjs` — servidor de mentira para mexer na página sem dados reais.
