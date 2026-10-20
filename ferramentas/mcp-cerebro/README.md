# MCP `cerebro`

Servidor MCP local (stdio) que expõe o índice do segundo cérebro
(`~/.claude/agentic-os/cerebro/indice.json`, gerado pelo `indexar.mjs` da Central a cada 2 h pelo
timer `cerebro-reindexar.timer`) para qualquer sessão do Claude Code achar arquivo sem varrer pasta com grep.

Node puro (22+), **sem dependências**. Somente leitura.

## Instalar

```bash
mkdir -p ~/.local/share/mcp-servers/cerebro
cp server.mjs teste.mjs README.md ~/.local/share/mcp-servers/cerebro/
node ~/.local/share/mcp-servers/cerebro/teste.mjs      # deve terminar com "TUDO OK"
claude mcp add --scope user cerebro -- node ~/.local/share/mcp-servers/cerebro/server.mjs
```

Versão com menos memória (flags do V8):

```bash
claude mcp add --scope user cerebro -- node --max-semi-space-size=1 --max-old-space-size=64 --single-threaded \
  ~/.local/share/mcp-servers/cerebro/server.mjs
```

- Só aparece em sessão **nova** do Claude Code. Conferir: `claude mcp list`.
- Desfazer: `claude mcp remove cerebro --scope user`.
- Sem o `indice.json`, as ferramentas respondem "índice não encontrado" (não quebra a sessão). Rode o
  indexador uma vez: `node ~/.claude/agentic-os/cerebro/indexar.mjs`.

## Configuração (variáveis de ambiente, todas opcionais)

| Variável | Padrão | Para quê |
|---|---|---|
| `CEREBRO_INDICE` | `~/.claude/agentic-os/cerebro/indice.json` | onde está o índice |
| `CEREBRO_RAIZES` | ver abaixo | pastas de onde `cerebro_arquivo` pode ler conteúdo, separadas por `:` |
| `AGENTIC_OS_PROJETOS` | `~/Projects` | pasta dos seus repositórios (entra nas raízes padrão) |
| `CEREBRO_VAULT` | — | pasta de notas pessoais, se quiser incluir |

Raízes padrão: `~/Projects`, `~/.claude/skills`, `~/.claude/projects/*/memory` (só a memória, nunca os
transcripts), `~/.claude/limpeza/relatorios`, `~/.claude/doc-de-sessao`, `~/.config/systemd/user`,
`~/.claude/CLAUDE.md`. Elas devem bater com as pastas que o `indexar.mjs` varre.

Para passar variável no registro: `claude mcp add --scope user cerebro -e CEREBRO_VAULT=$HOME/Notas -- node ...`.

## Ferramentas

| Ferramenta | Entrada | Devolve |
|---|---|---|
| `cerebro_buscar` | `consulta`, `area?`, `tipo?`, `limite≤20` | itens ranqueados (título 6–8 pts, caminho 3, preview 1; bônus se todos os termos casam; +até 3 por recência, meia-vida ~30 d). Sem acento. |
| `cerebro_arquivo` | `caminho` (absoluto, `~/…` ou só o nome se for único) | metadados do índice + até 4 KB do conteúdo |
| `cerebro_ligacoes` | `caminho` | links de saída e de entrada (`[[...]]` e `](x.md)`, resolvidos pelo indexador) |
| `cerebro_recentes` | `area?`, `dias≤30`, `limite≤20` | o que mudou, mais novo primeiro |

`area` e `tipo` são os valores que o indexador grava em cada item (campos `a` e `k` do `indice.json`).

## Segurança

- `cerebro_arquivo` só lê se o `realpath` do arquivo cair dentro das raízes acima.
- Filtro de segredo (`secret|token|.env|credential|senha|password|.pem|.key|id_rsa|.config/`):
  caminho sensível nunca tem conteúdo lido. Efeito colateral: timers em `~/.config/systemd/user` só mostram metadados.
- Arquivo binário (tem byte NUL) não é devolvido.

## Memória e desempenho

- O índice só é carregado na **1ª chamada de ferramenta**; sessão que nunca usa fica no mínimo do Node.
- Recarrega sozinho quando o mtime do `indice.json` muda (checa a cada chamada, sem watcher).
- Solta o índice depois de 15 min sem chamada.
- Medida de referência (2.114 itens, Node 22): parado RSS ~51 MB, mas **privada ~11 MB** (o resto é o
  binário do node, compartilhado entre processos); busca ~30 ms a frio, 1–8 ms a quente.

## Teste

```bash
node ~/.local/share/mcp-servers/cerebro/teste.mjs
```

Monta um índice falso numa pasta temporária, fala JSON-RPC por stdio (initialize, tools/list, chamadas
reais, bloqueio de segredo), mede latência e memória; sai 1 se algo falhar. Não usa rede nem o seu índice.
