# Agentic OS

Caio, este é um "sistema operacional" local para trabalhar com vários agentes do Claude Code ao mesmo
tempo: uma tela de comando no navegador (a **Central**), um orquestrador que transforma conversa em plano,
líderes por área, verificadores que medem o projeto, um índice de busca dos seus arquivos (o **cérebro**),
um mod para o Claude Code e um conjunto de rotinas e skills. Tudo em Node puro, sem dependências npm,
rodando só na sua máquina (127.0.0.1).

## O que vem dentro

| Peça | Pasta | O que faz |
|---|---|---|
| Central (porta 4747) | `central/` | Painel no navegador: sessões abertas, "precisa de você", planos, score, escalabilidade, deck de skills, rotinas, calendário, linha do tempo do dia |
| Orquestrador + líderes + verificadores | `agentes/` | `orquestrador` escreve planos (nunca dispara); `lider-exemplo` é o molde para criar líderes por área; 5 verificadores só leitura (segurança, bugs de UI, velocidade, otimização, escalabilidade) |
| Modo plano | `central/planos/`, `central/lancar/` | Plano em markdown → você aprova na Central → cada item vira `claude --bg` (local), `claude --cloud` (nuvem) ou texto para o Claude Projects |
| Cérebro | `cerebro/` + `ferramentas/mcp-cerebro/` | Indexa seus repos, memórias, skills e rotinas; mapa visual em `/cerebro/` e MCP `cerebro_buscar` para as sessões acharem arquivo sem grep |
| Mod do Claude Code | `mod/` | Plugin `painel-escritorio`: painel com sessões, subagentes, checklist, deck, limpeza; entrega no terminal as respostas que você escreve na Central |
| Skills | `ferramentas/skills/` | `limpeza`, `pesquisa-rapida`, `velocidade-site`, `performance`, `core-web-vitals` (+ agente `velocidade-site`) |
| Rotinas, hooks, timers | `ferramentas/rotinas/`, `ferramentas/systemd/`, `rotinas/` | Capacidade do PC, onde parei, lembrete de commit, vigia de CI, statusline com cota, trava de checkout entre sessões, linha do tempo; timers do systemd |

As skills `calibrate` e `personalise`, que a Central também reconhece, não vêm aqui porque o repositório original não tem licença. Instale direto da fonte: https://github.com/robonuggets/skills

Arquitetura e formato do plano: `docs/arquitetura.md`. Rotas da Central: `central/README.md`.
Ferramentas soltas: `ferramentas/README.md`. Verificadores agendados: `rotinas/README.md`.

## Pré-requisitos

- **Obrigatório:** Node 22+, Claude Code CLI (`claude`) logado, Linux (testado em Fedora; precisa de `/proc`).
- **Opcional:** systemd de usuário (timers e serviço da Central; sem ele, suba a Central à mão),
  `gh` logado (vigia de CI e trava da nuvem), `jq`, `notify-send`, `xdg-open` (botão "abrir"),
  `konsole` ou outro terminal (`CENTRAL_TERMINAL=gnome-terminal`, botão "abrir terminal"), `python3` (só para `claude --cloud`, que exige pseudo-terminal).

## Instalação

```bash
cd agentic-os-caio
bash install.sh --dry-run      # mostra o que vai copiar, sem escrever nada
bash install.sh                # copia; arquivo diferente no destino vira .bak-<data> antes
```

O instalador só copia. Ele põe:

| Origem | Destino |
|---|---|
| o repo inteiro | `~/.claude/agentic-os/` (convenção fixa da ferramenta; mude com `AGENTIC_OS_DIR`) |
| `agentes/*.md` | `~/.claude/agents/` |
| `ferramentas/skills/*`, `ferramentas/agents/*` | `~/.claude/skills/`, `~/.claude/agents/` |
| `ferramentas/rotinas/*`, `ferramentas/limpeza/*` | `~/.claude/rotinas/`, `~/.claude/limpeza/` |
| `ferramentas/mcp-cerebro/*` | `~/.local/share/mcp-servers/cerebro/` |
| `ferramentas/systemd/*`, `rotinas/*.service/.timer` | `~/.config/systemd/user/` (copiados, **não** ligados) |

Sem `install.sh`: copie à mão pela tabela acima (`cp -r`).

Depois, passo a passo:

1. **Testes:** `cd ~/.claude/agentic-os && npm test`.
2. **Índice do cérebro:** `node ~/.claude/agentic-os/cerebro/indexar.mjs`. Ele lê `~/Projects`
   (`AGENTIC_OS_PROJETOS` troca), `~/.claude/skills`, as memórias de `~/.claude/projects/*/memory`, os timers
   e, se você tiver, uma pasta de notas (`CEREBRO_VAULT` ou `NOTAS_DIR`).
3. **Subir a Central:** `node ~/.claude/agentic-os/central/server.mjs` e abra http://127.0.0.1:4747.
   Como serviço: `systemctl --user daemon-reload && systemctl --user enable --now agentic-os-central.service`.
   Porta diferente: `CENTRAL_PORT=4800`.
4. **Token (`X-Central-Token`):** é gerado a cada subida e gravado em `~/.claude/agentic-os/central-<porta>.token`
   (modo 600); a página já recebe o token sozinha. Para chamar a API pelo terminal, leia o arquivo
   (exemplo em `central/README.md`). Para trocar o token, reinicie a Central.
5. **MCP do cérebro:** `claude mcp add --scope user cerebro -- node ~/.local/share/mcp-servers/cerebro/server.mjs`
   (aparece em sessão nova; confira com `claude mcp list`).
6. **Mod:** `claude plugin marketplace add ~/.claude/agentic-os/mod && claude plugin install painel-escritorio@agentic-os`.
   Testes do mod: `claude plugin test ~/.claude/agentic-os/mod`.
7. **Hooks e statusline:** trecho de `settings.json` em `ferramentas/README.md`.
8. **Configurar para o seu projeto:**
   - `~/.claude/agentic-os/central/escala-pesos.json`: troque `meu-app`, o caminho do repo e `carga.hostsDev`
     (`dev.exemplo.com`) pelo seu DEV.
   - `~/.claude/agentic-os/central/nuvem-repos.json`: `{ "comApp": ["seu-usuario/*"] }` para liberar `claude --cloud`
     nos repos que têm o app do Claude no GitHub.
   - `~/.claude/limpeza/alvos.json` (a partir de `alvos.exemplo.json`): URLs que a saúde mede.
   - Verificadores: troque `https://dev.exemplo.com` e `~/Projects/meu-app` nos `~/.claude/agents/verificador-*.md`.
   - Líderes: copie `lider-exemplo.md` para `~/.claude/agents/lider-<area>.md` e preencha.
   - Planos podem tocar só repos dentro de `~/Projects` (`CENTRAL_RAIZES="~/Projects:~/code"` amplia).

## Usar

1. `claude --agent orquestrador` e descreva o que quer. Ele grava o plano em `~/.claude/agentic-os/planos/` como **proposto**.
2. Na Central, card de planos: confira, escolha local/nuvem/projects por item e aperte **Aprovar e disparar**.
3. Acompanhe as sessões na Central ou no painel do mod; responda pelo "Precisa de você".

## Aviso de custo e de ambiente

- **Gasta cota do plano Claude:** toda sessão disparada por plano, o deck (`/standup`, `/limpeza` headless),
  "Perguntar ao cérebro" e os **verificadores** (cada execução é uma sessão `claude -p`; os timers deles
  nascem desligados e têm teto semanal em `rotinas/rodar-verificador.mjs`). A Central sempre pede confirmação antes.
- Os timers de `ferramentas/systemd/` não chamam IA.
- **Teste de carga e verificadores só em ambiente próprio de DEV**, nunca em produção nem em ambiente de outra
  pessoa. O teste de carga (`central/escala/carga.mjs`) só aceita os hosts de `carga.hostsDev` ou localhost,
  e sem `--confirmar` só mostra o plano.

## O que não vem

Tracker de tarefas: não há integração pronta. As sugestões dos verificadores aparecem na Central e o ponto
para ligar o seu tracker está descrito em `docs/arquitetura.md` ("Pontos de extensão").
