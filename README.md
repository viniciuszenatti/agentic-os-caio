# Agentic OS

[![testes](https://github.com/viniciuszenatti/agentic-os-caio/actions/workflows/test.yml/badge.svg)](https://github.com/viniciuszenatti/agentic-os-caio/actions/workflows/test.yml)

Um "sistema operacional" local para trabalhar com vários agentes do Claude Code ao mesmo
tempo: uma tela de comando no navegador (a **Central**), um orquestrador que transforma conversa em plano,
líderes por área, verificadores que medem o projeto, um índice de busca dos seus arquivos (o **cérebro**),
um mod para o Claude Code e um conjunto de rotinas e skills. Tudo em Node puro, sem dependências npm,
rodando só na sua máquina (127.0.0.1). O núcleo roda no Linux e no Windows 10/11 (o CI testa os dois a cada push).

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

## Funciona em

O CI (`.github/workflows/test.yml`) roda `npm test`, um teste de fumaça (sobe a Central, confere as rotas,
roda o indexador e conversa com o MCP do cérebro) e, no Windows, o `install.ps1` numa pasta vazia,
em `ubuntu-latest` e `windows-latest`. macOS não tem CI: os caminhos são POSIX, mas nada foi testado lá.

| Peça | Linux | Windows 10/11 | macOS |
|---|---|---|---|
| Central (página, planos, papéis, score, escala, busca, revisão, respostas) | funciona | funciona | não testado |
| Modo plano: item `local` (`claude --bg`) e `projects` | funciona | funciona (*) | não testado |
| Modo plano: item `nuvem` (`claude --cloud`) | funciona (precisa de `python3`) | indisponível: a Central responde o motivo | não testado |
| Botão "abrir" / "abrir terminal" | `xdg-open` / `konsole` | `explorer.exe` / Windows Terminal (`wt.exe`) | `open` / Terminal |
| Cérebro (`cerebro/indexar.mjs`) e MCP do cérebro | funciona | funciona | não testado |
| Mod `painel-escritorio` (painel, respostas da Central, abrir, 📌 guardar) | funciona | funciona (teste do mod com ambiente Windows simulado) | não testado |
| Capacidade do PC (`/proc`, `/sys`) | funciona | indisponível (o cartão diz por quê) | não |
| Diagnóstico e skill `limpeza` (`diagnostico.sh`, thermald) | funciona | indisponível | não |
| Modo build, "encerrar o dia" | funciona (systemd) | indisponível | não |
| Deck headless (`/standup`, `/limpeza` pelo botão) | funciona (bash) | indisponível: rode a skill numa sessão | não testado |
| Timers e serviço (`ferramentas/systemd/`, `rotinas/*.timer`) | funciona | não: use o Agendador de Tarefas (abaixo) | não |
| Rotinas soltas (`ferramentas/rotinas/*.mjs`, statusline, hooks) | funciona | não testado (Node + git; sem `notify-send`) | não testado |
| `install.sh` / `install.ps1` | `install.sh` | `install.ps1` (testado no CI) | `install.sh` |

(*) Testado no CI com o `claude` simulado: o runner não tem Claude logado, então nenhum `claude --bg` de
verdade rodou no Windows. No Windows a Central acha o `claude.exe` no `PATH`; se só houver o `claude.cmd`
do npm, ela roda o `cli.js` do pacote com o próprio node, porque um `.cmd` exigiria shell.

## Pré-requisitos

- **Obrigatório:** Node 22+ e o Claude Code CLI (`claude`) logado. Linux (testado em Fedora) ou Windows 10/11.
- **Opcional no Linux:** systemd de usuário (timers e serviço da Central; sem ele, suba a Central à mão),
  `gh` logado (vigia de CI e trava da nuvem), `jq`, `notify-send`, `xdg-open` (botão "abrir"),
  `konsole` ou outro terminal (`CENTRAL_TERMINAL=gnome-terminal`, botão "abrir terminal"), `python3` (só para `claude --cloud`, que exige pseudo-terminal).
- **Opcional no Windows:** Windows Terminal (`wt.exe`, botão "abrir terminal"; outro com `CENTRAL_TERMINAL`), `git` e `gh` no `PATH`.

## Instalação no Linux

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

1. **Testes:** `cd ~/.claude/agentic-os && npm test` (e `node test/fumaca.mjs`, que sobe a Central na porta 4799 com um HOME temporário).
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

## Instalação no Windows

No PowerShell (5.1 ou 7), dentro da pasta do repo:

```powershell
cd agentic-os-caio
powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun   # mostra o que vai copiar, sem escrever nada
powershell -ExecutionPolicy Bypass -File install.ps1           # copia; arquivo diferente no destino vira .bak-<data> antes
```

O `install.ps1` faz o mesmo que o `install.sh` (só copia, `.bak` antes de sobrescrever, rodar de novo não
muda nada), com estes destinos em `%USERPROFILE%`: `.claude\agentic-os\` (o repo; `AGENTIC_OS_DIR` troca),
`.claude\agents\`, `.claude\skills\`, `.claude\rotinas\`, `.claude\limpeza\` e
`.local\share\mcp-servers\cerebro\`. As units do systemd não são copiadas.

Depois, passo a passo:

1. **Testes:** `cd $HOME\.claude\agentic-os; npm test`.
2. **Índice do cérebro:** `node $HOME\.claude\agentic-os\cerebro\indexar.mjs` (lê `%USERPROFILE%\Projects`; `AGENTIC_OS_PROJETOS` troca).
3. **Subir a Central:** `node $HOME\.claude\agentic-os\central\server.mjs` e abra http://127.0.0.1:4747.
   Porta diferente: `$env:CENTRAL_PORT=4800` antes do comando. A página avisa o que fica indisponível no Windows
   (também em `GET /api/plataforma`).
4. **Token:** igual ao Linux, em `%USERPROFILE%\.claude\agentic-os\central-<porta>.token`. No Windows não existe
   modo 600: o arquivo fica protegido pela permissão da sua pasta de usuário.
5. **MCP do cérebro:** `claude mcp add --scope user cerebro -- node "$HOME\.local\share\mcp-servers\cerebro\server.mjs"`.
6. **Mod:** `claude plugin marketplace add "$HOME\.claude\agentic-os\mod"; claude plugin install painel-escritorio@agentic-os`.
7. **Repos dos planos:** a lista de `CENTRAL_RAIZES` usa `;` no Windows: `$env:CENTRAL_RAIZES="~/Projects;D:\code"`.
   O prompt de cada item cita os caminhos com `/` (o node aceita), para nenhum `\` virar escape de shell.

### Windows: Agendador de Tarefas (opcional)

Não há systemd no Windows. Se quiser que a Central suba sozinha no login e o cérebro reindexe todo dia,
crie as tarefas à mão (nada disso é automático, e nenhuma delas chama IA):

```powershell
$node = (Get-Command node).Source
$os = "$HOME\.claude\agentic-os"
# Central no login (as aspas em -Argument seguram caminho com espaço)
Register-ScheduledTask -TaskName 'AgenticOS-Central' -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
  -Action (New-ScheduledTaskAction -Execute $node -Argument "`"$os\central\server.mjs`"" -WorkingDirectory $HOME)
# cérebro reindexado todo dia às 03:00
Register-ScheduledTask -TaskName 'AgenticOS-Cerebro' -Trigger (New-ScheduledTaskTrigger -Daily -At 03:00) `
  -Action (New-ScheduledTaskAction -Execute $node -Argument "`"$os\cerebro\indexar.mjs`"")
schtasks /Query /TN AgenticOS-Central       # conferir
schtasks /Run /TN AgenticOS-Central         # rodar agora
schtasks /Delete /TN AgenticOS-Central /F   # desfazer (idem AgenticOS-Cerebro)
```

Use os cmdlets acima em vez de `schtasks /Create /TR "…"`: o Windows PowerShell 5.1 tira as aspas internas
dos argumentos de programas externos, e um caminho com espaço quebra.

Os verificadores (`rotinas/rodar-verificador.mjs <nome>`) também podem virar tarefa, mas **gastam cota do
plano Claude**: só crie se quiser pagar por isso, e o teto semanal continua valendo.

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
