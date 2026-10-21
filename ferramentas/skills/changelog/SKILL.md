---
name: changelog
description: Gera o changelog a partir do que foi MERGEADO no ramo principal dos seus repositórios num período — notas de versão técnicas para o time (PR, commit, tarefa) e um "O que há de novo" em linguagem simples para clientes/usuários, sem jargão. Use quando pedirem "gera o changelog", "o que saiu essa semana", "o que mudou desde X", "notas de versão", "release notes", "o que há de novo", "novidades do mês" ou "/changelog". Só entrega rascunho no chat; não edita arquivo de release nem publica nada sem pedido explícito.
---

# changelog — o que saiu, para o time e para quem usa

Duas saídas a partir dos mesmos fatos (git + PRs mergeados):

- **Time** — técnico, com número de PR, commit, escopo e id de tarefa (se você usa).
- **Clientes/usuários** — "O que há de novo": benefício em português simples, do jeito que quem usa o produto entende.

## Passo 1 — coletar (script, grátis, só leitura)

```bash
node ~/.claude/skills/changelog/coletar.mjs                          # últimos 7 dias, todos os repos da pasta de projetos
node ~/.claude/skills/changelog/coletar.mjs --desde 2026-10-01 --ate 2026-10-15
node ~/.claude/skills/changelog/coletar.mjs --desde v1.2             # depois de uma tag (só repos que têm a tag)
node ~/.claude/skills/changelog/coletar.mjs meu-app minha-api        # só esses repos (nome ou caminho)
node ~/.claude/skills/changelog/coletar.mjs --pasta ~/trabalho --ramo master
```

Traduzir o pedido em período: "essa semana" = segunda até hoje; "desde a última versão" = a última tag
(`git describe --tags --abbrev=0`) ou a data que a pessoa disser.

Configuração (tudo opcional):

| O quê | Flag | Variável | Padrão |
|---|---|---|---|
| Pasta dos repos (um por subpasta) | `--pasta` | `CHANGELOG_PROJETOS` ou `AGENTIC_OS_PROJETOS` | `~/Projects` |
| Ramo principal | `--ramo` | `CHANGELOG_RAMO` | `main` |
| Id de tarefa (regex) | `--tarefa-re` | `CHANGELOG_TAREFA_RE` | nenhum (ex.: `T-\d{4}`, `[A-Z]+-\d+`) |
| Link da tarefa (`{id}` é trocado) | `--tarefa-url` | `CHANGELOG_TAREFA_URL` | sem link |
| Pasta de saída | — | `AGENTIC_OS_DIR` | `~/.claude/agentic-os/changelog/` |

O que o script faz:
- `git fetch origin <ramo>` em cada repo da pasta (sem `wt-*`, `bancadas`, `.*`, `_*`, sem repo sem remote, sem duplicar o mesmo remote) e lê `origin/<ramo>`.
- Caminho de primeiro pai: cada merge commit = 1 entrega (PR); commit direto no ramo também conta.
- `gh pr list --state merged` (se o `gh` estiver logado) dá título e número do PR. Sem `gh`, usa o texto do merge.
- Agrupa por **tipo** do conventional commit (feat, fix, perf, refactor, docs, test, chore, ci, build, style, revert, outro) e por **escopo**.
- Ids de tarefa (se você deu a regex) e refs a issue de outro repo (`repo#123`) ficam anotados.
- **Nomes sensíveis saem como `[cliente]`**: lista em `~/.claude/rotinas/nomes-sensiveis.txt` (formato em
  `nomes-sensiveis.exemplo.txt`), função `limpar` do `comum.mjs` das rotinas, numa passada final sobre o
  markdown e o JSON inteiros. Repo cujo nome bate com a lista fica fora do padrão (passe o nome para incluir).
- Grava `<AAAA-MM-DD_HHMM>.md` e `.json` na pasta de saída (nunca sobrescreve) e imprime contagens por tipo e repo.

Leia o `.md` (e o `.json` se precisar dos commits de dentro de cada PR).

## Passo 2 — reescrever em 2 blocos

### Bloco "Time" (técnico)

```markdown
## Notas de versão — <desde> a <ate>

**Resumo:** <N> PRs em <M> repos · <x> novidades · <y> correções · <z> desempenho.

### <repo ou área>
- **Lista abre sem esperar o servidor** — esqueleto no lugar do "Carregando" ([#61](url), TAREFA-12).
- ...

### Fora do produto (docs, CI, manutenção)
Uma linha por repo com contagem: "docs: 12 PRs de documentação."
```

Regras do Time:
- Agrupar por repo/área; feat → fix → perf primeiro; juntar PRs da mesma frente numa linha só.
- Frase-título em negrito diz **o que mudou de fato**; detalhes e o rastro (PR, tarefa) depois.
- **Destacar sempre**: `BREAKING`, migração de banco, variável de ambiente nova, mudança que exige build/instalação nova.
- docs/test/chore/ci vão comprimidos em "Fora do produto".
- Merge no ramo principal não é o mesmo que "em produção": diga "mergeado em <ramo>" se o deploy for separado.

### Bloco "Clientes/usuários" (O que há de novo)

```markdown
## O que há de novo

**Sua lista ficou mais rápida.** Ela abre na hora, mesmo antes de carregar tudo.

**Agora dá para exportar em planilha.** ...
```

Regras:
- Só entra `feat`, `fix` e `perf` que quem usa **vê ou sente**. Fora: test, chore, docs, refactor, ci, build, style, infra invisível, ferramenta interna.
- Cada item = **benefício**, não mecanismo. "Sua lista abre na hora", não "removemos a chamada síncrona".
- Zero jargão: nada de PR, commit, migration, endpoint, deploy, flag, id de tarefa, número de issue, nome de serviço interno.
- Correção vira melhoria positiva ("agora o horário salva certinho"), sem expor o tamanho do bug.
- **Nunca** dado de cliente: nome de empresa, pessoa, telefone, conta. `[cliente]` no rascunho = reescrever a frase sem o nome.
- **Nunca** anotação interna: data de decisão entre parênteses, código de tarefa, nome de sessão, "fase 2".
- No máximo 5–7 itens, o mais útil primeiro. Recurso atrás de flag desligada **não** entra como "já disponível" — se entrar, "chegando em breve".
- Frase curta, verbo concreto (a skill `no-ai-slop`, se instalada, ajuda).

## Passo 3 — entregar

1. Mostrar os 2 blocos no chat, prontos para copiar.
2. Dizer o arquivo cru (`.md`) e as contagens.
3. Listar o que ficou de fora do bloco Clientes e por quê (1 linha), para a pessoa puxar de volta se quiser.

**Não fazer sem pedido explícito:** editar CHANGELOG/RELEASES do repo, commit, push, PR, post público,
mandar para cliente, chamar API paga (LLM em lote etc.). O script não usa nenhuma.

## Ressalvas

- O período é pela data do **merge** no ramo (commit de primeiro pai), não pela data do commit original.
- PR mergeado em outra base que não o ramo principal (PR empilhado) não aparece.
- Título de PR sem conventional commit herda o tipo dos commits de dentro; se não houver, cai em `outro`.
- `limpar` só pega o que está em `nomes-sensiveis.txt`. Nome novo → acrescentar lá antes de rodar.
