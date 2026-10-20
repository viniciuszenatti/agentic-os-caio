# Remédios da /limpeza

Cada remédio tem: **quando**, **comando**, **porta** (mão dupla = posso propor e rodar com o OK do turno;
única = só o usuário roda ou autoriza explicitamente). Nunca rodar remédio sem o OK dele no turno.
Os números de referência vieram de um notebook Linux i5 de 15 W com 16 GB; ajuste à sua máquina.

## R1 — CPU travada em 3 W pelo thermald (Intel)
- Quando: limite de potência < 10 W, clock médio < 1.000 MHz, load alto com CPU fria.
- Teste imediato (some no boot): `echo 15000000 | sudo tee /sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw`
  (15000000 = 15 W; use o valor nominal do seu processador).
- Persistente: um serviço de sistema que regrava o PL1 no boot e/ou tirar o `--adaptive` do thermald
  (`systemctl cat thermald`). Isso mexe em `/etc`.
- Porta: **única** (sudo + persistência no sistema). O usuário roda.
- **Nunca** `systemctl restart systemd-logind`: derruba a sessão gráfica.

## R2 — Sessões do Claude acumuladas (cada uma ≈ 450–550 MB com MCPs)
- Quando: mais de 6 sessões ou alguma com 24 h+.
- Remédio: fechar a aba/terminal da sessão parada (a Central mostra quais estão paradas).
- Porta: matar processo de outra sessão = **pedir autorização explícita no turno**. Preferir que o usuário feche.

## R3 — Servidor de dev órfão (next dev, vite, expo, metro, watch)
- Quando: aparece na seção 4 com 12 h+.
- Comando: `kill <PID>` (SIGTERM). Confirmar antes que não é um servidor em uso.
- Porta: mão dupla com o OK do turno.

## R4 — Caches recriáveis (disco)
- `~/.npm`: `npm cache clean --force` · pnpm: `pnpm store prune` · playwright velho: `npx playwright uninstall` (cuidado: baixa de novo depois)
- `~/.cache`: ver o que pesa com `du -sh ~/.cache/* | sort -h | tail` antes; nunca apagar `~/.cache` inteiro.
- Docker: `docker image prune` (só sem tag) · volumes: **não** — `docker volume prune` apaga banco local.
- Lixeira: esvaziar pelo gerenciador de arquivos.
- Porta: mão dupla para npm/pnpm/image prune; **única** para volume do docker e qualquer `rm -rf`.

## R5 — Bancadas / worktrees paradas
- Lista: `~/.claude/limpeza/bancadas-paradas.txt` (idade, tem node_modules, tem alteração, caminho).
- Passo 1 (barato e reversível): apagar só `node_modules` e `.next` das paradas **sem alteração**
  (`pnpm install` / `npm install` recria). Mostrar a lista e o espaço antes.
- Passo 2 (worktree inteira): `git -C <repo-mãe> worktree remove <caminho>` — só se a branch já está
  no remoto (`git branch -r --contains <branch>`) e sem alteração. Nunca `rm -rf` em worktree.
- Bancada com **alteração não commitada**: nunca entra. Listar para o usuário decidir.
- Porta: **única** (apagar arquivo). Pedir com a lista exata e o tamanho.
- Se a pasta de projetos mora em outro disco (link ou bind mount), o espaço volta lá: medir com `df -h <pasta>`.
- Rodar: `bash ~/.claude/skills/limpeza/r5-aplicar.sh` (simulação; gera `r5-candidatas.txt` se não existir) → `--valer` com o OK.

## R6 — Hook pesado no Claude Code
- Quando: hook chamando `npm exec`/`npx`/`@latest` a cada evento.
- Remédio: desligar o plugin em `~/.claude/settings.json` (`enabledPlugins`), com backup
  `settings.json.bak-<motivo>-<data>`.
- Porta: mão dupla com backup e o OK do turno.

## R7 — Swap cheio
- Causa quase sempre é R2 + navegador + editor. Fechar abas/sessões resolve; `swapoff/swapon` não.

## R8 — MCP pesado ou com @latest
- Quando: um MCP soma centenas de MB (ele sobe uma cópia por sessão) ou roda via `npx -y pacote@latest`.
- Remédio A: fixar a versão no `~/.claude.json` (`pacote@1.2.3` em vez de `@latest`): some o download/checagem a cada sessão.
- Remédio B: tirar do escopo user os MCPs que não são diários e ligar só no projeto que usa (`claude mcp remove <nome> -s user` + `claude mcp add` no projeto).
- Porta: mão dupla com backup de `~/.claude.json` e o OK do turno.
