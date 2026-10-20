# Rotinas dos verificadores (opcional)

Uma unit `systemd --user` (`.service` + `.timer`) por verificador. **Tudo é opcional e nasce desabilitado.** Cada execução é uma sessão Claude Code em modo headless e **gasta cota do seu plano Claude**. Ligue só o que valer a cota.

| Rotina | Quando | Teto/semana | Teto de gasto por execução |
|---|---|---|---|
| `verificador-seguranca` | segunda 03:00 | 1 | US$ 1,00 |
| `verificador-bugs-ui` | terça 03:00 | 1 | US$ 2,00 |
| `verificador-velocidade` | segunda e quinta 04:00 | 2 | US$ 1,00 |
| `verificador-otimizacao` | quarta 03:00 | 1 | US$ 1,00 |
| `verificador-escalabilidade` | sábado 03:00 | 1 | US$ 1,00 |

- A unit chama `rodar-verificador.mjs <nome>`, que roda `claude -p --agent <nome> --permission-mode default --max-budget-usd <teto>` (argv fechado, sem shell, sem `bypassPermissions`).
- **Teto semanal:** antes de rodar, o script conta as execuções da semana (segunda 00:00, hora local) em `~/.claude/agentic-os/rotinas/execucoes.jsonl`. Bateu o teto, não roda. Rodar à mão também conta.
- `--max-budget-usd` corta a sessão se o equivalente em API passar do teto da tabela. Pior caso com tudo ligado: 6 execuções, US$ 7,00/semana em equivalente de API.
- A rotina de escalabilidade **não roda teste de carga**; o eixo Carga fica "sem dado" nela.
- Antes de ligar, configure os alvos (URL do DEV, repo) no topo de cada `agentes/verificador-*.md`.

## Instalar (não liga nada)

```bash
mkdir -p ~/.claude/agentic-os/rotinas ~/.claude/agents
cp rotinas/rodar-verificador.mjs ~/.claude/agentic-os/rotinas/
cp agentes/*.md ~/.claude/agents/
for u in rotinas/verificador-*.service rotinas/verificador-*.timer; do
  systemctl --user link "$PWD/$u"
done
systemctl --user daemon-reload
```

O `claude` e o `node` precisam estar no `PATH` do systemd do usuário (`systemctl --user show-environment`). Se não estiverem, rode `systemctl --user import-environment PATH`.

## Ligar uma rotina

```bash
systemctl --user enable --now verificador-velocidade.timer
systemctl --user list-timers 'verificador-*'
```

## Rodar uma vez, à mão

```bash
systemctl --user start verificador-seguranca.service
journalctl --user -u verificador-seguranca.service -n 50
```

## Desligar

```bash
systemctl --user disable --now verificador-velocidade.timer
```
