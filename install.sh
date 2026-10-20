#!/usr/bin/env bash
# Instalador do Agentic OS. Só COPIA arquivos; nunca apaga nada.
# - Arquivo igual no destino: pula (rodar de novo não muda nada).
# - Arquivo diferente no destino: o antigo vira <arquivo>.bak-AAAAMMDD-HHMMSS antes da cópia.
# - Não liga timer, não registra MCP, não instala o mod, não sobe serviço: imprime os comandos no fim.
#
# Uso: bash install.sh [--dry-run] [--sem-ferramentas]
set -euo pipefail

SECO=0; FERRAMENTAS=1
for a in "$@"; do
  case "$a" in
    --dry-run) SECO=1 ;;
    --sem-ferramentas) FERRAMENTAS=0 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $a" >&2; exit 2 ;;
  esac
done

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINO="${AGENTIC_OS_DIR:-$HOME/.claude/agentic-os}"
STAMP="$(date +%Y%m%d-%H%M%S)"
copiados=0; iguais=0; backups=0

command -v node >/dev/null || { echo "precisa do node 22+ no PATH" >&2; exit 1; }
maior=$(node -p 'process.versions.node.split(".")[0]')
[ "$maior" -ge 22 ] || { echo "node $maior encontrado; precisa do 22+" >&2; exit 1; }

copia() { # copia <origem> <destino>
  local o="$1" d="$2"
  if [ -e "$d" ] || [ -L "$d" ]; then
    if cmp -s "$o" "$d"; then iguais=$((iguais + 1)); return; fi
    echo "backup: $d -> $d.bak-$STAMP"
    [ "$SECO" = 1 ] || mv "$d" "$d.bak-$STAMP"
    backups=$((backups + 1))
  fi
  echo "copia:  $d"
  if [ "$SECO" = 0 ]; then mkdir -p "$(dirname "$d")"; cp -p "$o" "$d"; fi
  copiados=$((copiados + 1))
}

copia_pasta() { # copia_pasta <pasta-origem> <pasta-destino>  (recursivo, sem .git)
  local o="$1" d="$2" f
  [ -d "$o" ] || return 0
  while IFS= read -r -d '' f; do copia "$f" "$d/${f#"$o"/}"; done < <(find "$o" -type f -not -path '*/.git/*' -print0)
}

echo "== 1/3 repo -> $DESTINO"
if [ -d "$DESTINO" ] && [ "$(cd "$AQUI" && pwd -P)" = "$(cd "$DESTINO" && pwd -P)" ]; then
  echo "(rodando de dentro do destino: nada a copiar)"
else
  for item in central cerebro mod rotinas agentes docs test coletar.mjs package.json CLAUDE.md README.md install.sh .gitignore; do
    if [ -d "$AQUI/$item" ]; then copia_pasta "$AQUI/$item" "$DESTINO/$item"; elif [ -f "$AQUI/$item" ]; then copia "$AQUI/$item" "$DESTINO/$item"; fi
  done
fi

echo "== 2/3 agentes -> ~/.claude/agents"
for f in "$AQUI"/agentes/*.md; do copia "$f" "$HOME/.claude/agents/$(basename "$f")"; done

if [ "$FERRAMENTAS" = 1 ]; then
  echo "== 3/3 ferramentas"
  F="$AQUI/ferramentas"
  copia_pasta "$F/skills" "$HOME/.claude/skills"
  copia_pasta "$F/agents" "$HOME/.claude/agents"
  copia_pasta "$F/rotinas" "$HOME/.claude/rotinas"
  copia_pasta "$F/limpeza" "$HOME/.claude/limpeza"
  copia_pasta "$F/mcp-cerebro" "$HOME/.local/share/mcp-servers/cerebro"
  copia_pasta "$F/systemd" "$HOME/.config/systemd/user"
  for f in "$AQUI"/rotinas/verificador-*.service "$AQUI"/rotinas/verificador-*.timer; do
    copia "$f" "$HOME/.config/systemd/user/$(basename "$f")"
  done
  [ "$SECO" = 1 ] || chmod +x "$HOME/.claude/rotinas/modo-build.sh" "$HOME/.claude/skills/limpeza/"*.sh 2>/dev/null || true
else
  echo "== 3/3 ferramentas: pulado (--sem-ferramentas)"
fi

echo
echo "Placar: $copiados copiados · $iguais iguais (pulados) · $backups backups .bak-$STAMP$([ "$SECO" = 1 ] && echo ' · DRY-RUN, nada foi escrito')"
cat <<EOF

Próximos passos (nada disso foi feito pelo instalador):
  1. Testes:          cd "$DESTINO" && npm test
  2. Subir a Central: node "$DESTINO/central/server.mjs"    # abre http://127.0.0.1:4747
     ou como serviço: systemctl --user daemon-reload && systemctl --user enable --now agentic-os-central.service
  3. Índice do cérebro: node "$DESTINO/cerebro/indexar.mjs"
  4. MCP do cérebro:  claude mcp add --scope user cerebro -- node ~/.local/share/mcp-servers/cerebro/server.mjs
  5. Mod do painel:   claude plugin marketplace add "$DESTINO/mod" && claude plugin install painel-escritorio@agentic-os
  6. Timers sem IA (opcionais): ver ferramentas/README.md
     Verificadores (gastam cota do plano Claude): ver rotinas/README.md — nascem desligados.
EOF
