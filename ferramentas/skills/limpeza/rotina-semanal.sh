#!/usr/bin/env bash
# Rotina semanal da /limpeza: roda o diagnóstico (só leitura, sem IA) e avisa no desktop.
# Disparada por ~/.config/systemd/user/limpeza-semanal.timer.
node "$HOME/.claude/limpeza/auditoria-contexto.mjs" >/dev/null 2>&1 || true
OUT=$(bash "$HOME/.claude/skills/limpeza/diagnostico.sh" --rapido 2>&1)
N=$(printf '%s\n' "$OUT" | grep -c '\[ALERTA\]' || true)
TOP=$(printf '%s\n' "$OUT" | grep '\[ALERTA\]' | head -3 | sed 's/^- \[ALERTA\] //; s/\*\*//g' | cut -c1-90)
ARQ=$(printf '%s\n' "$OUT" | sed -n 's/.*Relatório: `\([^`]*\)`.*/\1/p')
if [ "$N" -gt 0 ]; then
  notify-send -a "Limpeza" -i dialog-warning "Limpeza semanal: $N alerta(s)" "$TOP
Abra a Central ou peça /limpeza. Relatório: $ARQ" 2>/dev/null || true
else
  notify-send -a "Limpeza" -i dialog-information "Limpeza semanal: máquina ok" "$ARQ" 2>/dev/null || true
fi
echo "$(date -Iseconds) rotina-semanal alertas=$N arquivo=$ARQ" >> "$HOME/.claude/limpeza/runs.log"
