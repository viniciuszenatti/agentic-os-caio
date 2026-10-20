---
name: pesquisa-rapida
description: Pesquisa rápida na web, grátis e sem conta — busca com trechos já extraídos (Parallel, ~1 s) e leitura de página em markdown (Jina Reader), por script, sem MCP. Use para "pesquisa rápido", "procura aí", "quanto custa X", "qual a versão atual de X", "o que é X", "lê essa página", quando o WebFetch for bloqueado/vier vazio, ou para checar UM fato antes de afirmar. Para pesquisa longa com várias fontes e relatório, use deep-research ou agent-reach; para redes sociais, x-research / youtube-research / instagram-research.
---

# Pesquisa rápida

Duas ferramentas, ambas grátis, sem cadastro e sem cartão (testado em 20/10/2026):

| Para quê | Comando | Serviço |
|---|---|---|
| Buscar | `node ~/.claude/skills/pesquisa-rapida/buscar.mjs "objetivo" "consulta 1" "consulta 2"` | Parallel Search (MCP hospedado, chamado por HTTP) |
| Ler página | `node ~/.claude/skills/pesquisa-rapida/buscar.mjs --ler <url>` | Jina Reader (`r.jina.ai`, 20 req/min sem chave); reserva: Parallel `web_fetch` |

## Como usar

1. Escreva o **objetivo** em uma frase (o que precisa responder) e 1–3 consultas curtas, de preferência em inglês para assunto técnico.
2. Os resultados já trazem trechos da página: responda direto por eles quando bastarem. Só use `--ler` se o trecho não fechar a pergunta.
3. Cite a URL de onde tirou cada fato. Preço, versão e data: diga a data da fonte (`publish_date`) ou "data não informada".
4. Dois resultados divergem → diga que divergem e qual parece oficial (domínio do fornecedor > blog comparativo).

## Regras

- **Nunca** pôr na consulta dado de cliente, nome de pessoa, telefone, segredo ou trecho de código privado: a consulta vai para serviço de terceiro (termos: https://parallel.ai/customer-terms).
- Falhou (HTTP 429/5xx) → cair para o `WebSearch`/`WebFetch` nativos, sem insistir.
- Não trocar por API paga (Exa, Tavily, Brave, Perplexity) sem o usuário autorizar: cadastro com cartão é decisão dele.

## Por que não MCP

Cada MCP instalado soma contexto fixo em toda sessão (rode `node ~/.claude/limpeza/auditoria-contexto.mjs` para medir o seu). Script chamado pela skill só custa quando é usado.
