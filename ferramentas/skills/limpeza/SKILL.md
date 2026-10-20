---
name: limpeza
description: Diagnóstico e manutenção da máquina Linux onde o Claude Code roda — CPU travada pelo thermald, RAM/swap, sessões do Claude acumuladas, servidor de dev órfão, disco, caches, bancadas/worktrees paradas, hooks e MCPs pesados. Use quando o usuário disser "/limpeza", "o computador está lento", "a máquina travou", "deixa o computador liso", "faz uma faxina", "por que está tudo lento?", ou quando o botão de limpeza da Central mandar.
---

# /limpeza — o computador rodando liso

O script faz o trabalho; você decide e explica. **Diagnóstico é só leitura. Remédio só com o OK do usuário no turno.**

## Passos
1. Rodar exatamente `bash ~/.claude/skills/limpeza/diagnostico.sh --rapido` (16 s). Sem `--rapido`, mede caches
   (≈1 min): usar quando o assunto for disco. Pasta dos repositórios/bancadas: variável `AGENTIC_OS_PROJETOS`
   (padrão `~/Projects`).
2. Ler o relatório e responder no formato abaixo. Para cada `[ALERTA]`, abrir **só** o remédio correspondente em
   `remedios.md` (R1…R8): não ler o arquivo inteiro sem precisar.
3. Se o usuário aprovar um remédio, rodar exatamente o comando do remédio, medir de novo (rodar o script outra
   vez) e mostrar o antes × depois em número.

## Formato da resposta (máx. 5 linhas + a tabela)
- Linha 1: o veredito — "a lentidão é X" (a causa nº 1, com o número que prova).
- Tabela: alerta · número · remédio · porta (mão dupla / única).
- Fecho: UMA ação, a de maior ganho e menor risco.

## Nunca
- Apagar arquivo, matar processo de outra sessão ou mexer em `/etc` sem o OK explícito no turno.
- `rm -rf` em worktree (usar `git worktree remove`); tocar em bancada com alteração não commitada.
- `docker volume prune` (apaga banco local) ou `systemctl restart systemd-logind` (derruba a sessão gráfica).
- Medir processo com `pgrep -f` dentro de script: o próprio script casa e dá número falso.

## Arquivos
| Arquivo | Para quê |
|---|---|
| `diagnostico.sh` | coleta (CPU/thermald, RAM, sessões, órfãos, disco, bancadas, hooks, serviços) |
| `remedios.md` | R1–R8: quando, comando, porta |
| `r5-aplicar.sh` | remédio R5 (apaga só `node_modules`/`.next` de bancada parada; padrão é simulação) |
| `rotina-semanal.sh` | o que o `limpeza-semanal.timer` roda: diagnóstico + aviso no desktop |
| `~/.claude/limpeza/relatorios/` | um `.md` por execução · `~/.claude/limpeza/runs.log` = uma linha por execução |
| `~/.claude/limpeza/bancadas-paradas.txt` | lista completa das bancadas paradas (gerada pelo script) |
