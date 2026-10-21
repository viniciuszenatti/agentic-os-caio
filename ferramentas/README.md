# Ferramentas do Agentic OS

Peças locais que acompanham a Central de Agentes: skills, um agente, um MCP de busca, rotinas sem IA
(timers do systemd), a limpeza da máquina e os hooks do Claude Code. Tudo em Node 22 puro ou bash,
sem dependências npm, sem API paga. Feito para Linux com systemd de usuário.

## O que é cada coisa e para onde copiar

| Pasta | Copiar para | O que é | Obrigatório? |
|---|---|---|---|
| `rotinas/` | `~/.claude/rotinas/` | scripts das rotinas, statusline e hooks; gravam `~/.claude/rotinas/estado/<nome>.json` | sim (a Central lê o estado) |
| `limpeza/` | `~/.claude/limpeza/` | saúde dos ambientes (`saude.mjs` + `alvos.json`) e auditoria de contexto | recomendado |
| `systemd/` | `~/.config/systemd/user/` | timers das rotinas, da limpeza, do reindexador e o serviço da Central | sim, os que você usar |
| `skills/` | `~/.claude/skills/` | `limpeza`, `pesquisa-rapida`, `velocidade-site`, `performance`, `core-web-vitals`, `changelog` (notas de versão do git, sem API paga) | opcional, uma a uma |
| `agents/` | `~/.claude/agents/` | `velocidade-site` (laudo de PageSpeed) | opcional |
| `mcp-cerebro/` | `~/.local/share/mcp-servers/cerebro/` | MCP de busca no índice do segundo cérebro (ver o README dele) | opcional |

```bash
mkdir -p ~/.claude/rotinas ~/.claude/limpeza ~/.claude/skills ~/.claude/agents ~/.config/systemd/user ~/.local/share/mcp-servers/cerebro
cp rotinas/*.mjs rotinas/*.sh rotinas/nomes-sensiveis.exemplo.txt ~/.claude/rotinas/
cp limpeza/*.mjs limpeza/alvos.exemplo.json ~/.claude/limpeza/
cp -r skills/* ~/.claude/skills/
cp agents/*.md ~/.claude/agents/
cp mcp-cerebro/* ~/.local/share/mcp-servers/cerebro/
cp systemd/* ~/.config/systemd/user/
```

## Configurar

1. **Pasta dos repositórios.** As rotinas varrem `~/Projects` (um repo git por subpasta; `wt-*` e
   `bancadas/*` contam como worktrees). Se for outra, defina `AGENTIC_OS_PROJETOS` nos `.service`
   (linha comentada `Environment=` já está lá) e no seu shell.
2. **Alvos da saúde.** `cp ~/.claude/limpeza/alvos.exemplo.json ~/.claude/limpeza/alvos.json` e troque
   pelas URLs dos seus ambientes (só GET de leitura). Sem o arquivo, a saúde não mede nada.
3. **Nomes sensíveis (opcional).** `cp ~/.claude/rotinas/nomes-sensiveis.exemplo.txt ~/.claude/rotinas/nomes-sensiveis.txt`
   e liste os nomes que nunca devem aparecer no estado (um regex por linha; vira `[cliente]`).
4. **Modo build.** Edite a lista `PESADOS=(...)` no topo de `modo-build.sh` com os timers que podem
   pausar durante um build pesado. Precisa de `jq`.
5. **Ligar os timers:**
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now rotina-capacidade.timer rotina-onde-parei.timer rotina-saude-rotinas.timer \
     rotina-lembrete-commit.timer rotina-vigia-ci.timer rotina-fechamento-do-dia.timer rotina-bom-dia.timer \
     limpeza-semanal.timer saude-ambientes.timer cerebro-reindexar.timer
   systemctl --user enable --now agentic-os-central.service
   ```
   Nenhum destes timers chama `claude -p` (headless): não gastam cota do plano Claude.
   `cerebro-reindexar` e `agentic-os-central` esperam a Central e o indexador em `~/.claude/agentic-os/`.

## Hooks e statusline no `~/.claude/settings.json`

Mescle estes blocos no seu `settings.json` (se já existir `hooks`, acrescente os itens nas listas):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/rotinas/statusline.mjs",
    "padding": 0
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/rotinas/trava-checkout.mjs", "timeout": 10, "statusMessage": "Trava de checkout" }
        ]
      }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node ~/.claude/rotinas/hook-linha-do-tempo.mjs", "timeout": 10 } ] }
    ],
    "PreCompact": [
      { "matcher": "auto", "hooks": [ { "type": "command", "command": "node ~/.claude/rotinas/hook-linha-do-tempo.mjs", "timeout": 10 } ] }
    ]
  }
}
```

- `statusline.mjs`: mostra cota de 5 h e da semana, contexto e cache; grava `estado/cota.json` (a Central mostra).
- `trava-checkout.mjs`: nega `git checkout/switch/rebase/pull/stash/reset --hard` quando outra sessão viva do
  Claude está no mesmo checkout. Escape consciente: terminar o comando com `# trava-ok`.
- `hook-linha-do-tempo.mjs`: no fim da sessão grava o motivo e o próximo passo em
  `~/.claude/rotinas/linha-do-tempo/AAAA-MM-DD.jsonl`; antes do compact automático grava uma passagem em
  `~/.claude/handoffs/`.

## Arquivos de estado (o que a Central lê)

| Arquivo | Quem grava | Quando |
|---|---|---|
| `~/.claude/rotinas/estado/capacidade.json` | `capacidade.mjs` | a cada 2 min |
| `~/.claude/rotinas/estado/onde-parei.json` | `onde-parei.mjs` | a cada 30 min |
| `~/.claude/rotinas/estado/saude-rotinas.json` | `saude-rotinas.mjs` | a cada 30 min |
| `~/.claude/rotinas/estado/lembrete-commit.json` | `lembrete-commit.mjs` | seg–sex, 2 em 2 h |
| `~/.claude/rotinas/estado/vigia-ci.json` | `vigia-ci.mjs` (precisa do `gh` logado) | seg–sex, 10 em 10 min |
| `~/.claude/rotinas/estado/fechamento-do-dia.json` | `fechamento-do-dia.mjs` | seg–sex 18h |
| `~/.claude/rotinas/estado/bom-dia.json` | `bom-dia.mjs` | ao entrar e seg–sex 8h30 |
| `~/.claude/rotinas/estado/linha-do-tempo.json` | `linha-do-tempo.mjs` (sem timer; rode à mão) | sob demanda |
| `~/.claude/rotinas/estado/cota.json` (+ `cota.jsonl`) | `statusline.mjs` | a cada resposta, no máx. 1 amostra a cada 2 min |
| `~/.claude/rotinas/estado/modo-build.json` | `modo-build.sh on/off` | quando liga/desliga |
| `~/.claude/limpeza/saude.json` | `limpeza/saude.mjs` | a cada 15 min |
| `~/.claude/limpeza/runs.log` | todas | uma linha por execução |

Internos (não são para a Central): `estado/avisos.json`, `estado/capacidade.interno.json`.

## Dependências

`node` 22+, `git`, `systemd` de usuário, `notify-send` (avisos no desktop; sem ele só não avisa),
`jq` (modo-build e diagnóstico), `gh` (só vigia-ci), `sensors` (opcional, temperatura), `rg` (auditoria de contexto).
