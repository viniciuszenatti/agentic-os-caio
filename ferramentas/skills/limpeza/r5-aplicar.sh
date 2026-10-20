#!/usr/bin/env bash
# R5: apaga SÓ node_modules e .next das bancadas em ~/.claude/limpeza/r5-candidatas.txt.
# Padrão = simulação. Para apagar de verdade: bash r5-aplicar.sh --valer  (só com o OK do usuário).
# Antes de cada pasta, confere de novo: sem alteração não commitada e parada há 14+ dias. pnpm/npm install recria.
# Se r5-candidatas.txt não existir, ele é gerado a partir de bancadas-paradas.txt (rode o diagnostico.sh antes):
# só as paradas SEM alteração e COM node_modules. Formato de cada linha: <MB node_modules> <MB .next> <caminho>.
set -u
VALER=0; [ "${1:-}" = "--valer" ] && VALER=1
BASE="$HOME/.claude/limpeza"
LISTA="$BASE/r5-candidatas.txt"; LOG="$BASE/runs.log"; PARADAS="$BASE/bancadas-paradas.txt"
if [ ! -f "$LISTA" ]; then
  [ -f "$PARADAS" ] || { echo "sem $PARADAS: rode antes bash ~/.claude/skills/limpeza/diagnostico.sh --rapido"; exit 2; }
  while read -r idade nm sujo dir; do
    dir="${dir/#\~/$HOME}"
    [ "$sujo" = 0 ] && [ "$nm" = 1 ] || continue
    a=$(du -sm "$dir/node_modules" 2>/dev/null | cut -f1); b=$(du -sm "$dir/.next" 2>/dev/null | cut -f1)
    echo "${a:-0} ${b:-0} $dir"
  done < "$PARADAS" > "$LISTA"
  echo "gerado $LISTA ($(wc -l < "$LISTA") pastas)"
fi
TOTAL=0; FEITAS=0; PULADAS=0
while read -r nm nx dir; do
  [ -d "$dir" ] || continue
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null | head -1)" ]; then echo "PULA (alteração nova): $dir"; PULADAS=$((PULADAS+1)); continue; fi
  if [ $(( ( $(date +%s) - $(stat -c %Y "$dir") ) / 86400 )) -lt 14 ]; then echo "PULA (mexida há <14 dias): $dir"; PULADAS=$((PULADAS+1)); continue; fi
  TOTAL=$((TOTAL + nm + nx))
  if [ "$VALER" -eq 1 ]; then rm -rf -- "$dir/node_modules" "$dir/.next"; echo "apagado: $dir (${nm}+${nx} MB)"; else echo "simulação: $dir (${nm}+${nx} MB)"; fi
  FEITAS=$((FEITAS+1))
done < "$LISTA"
echo "$([ $VALER -eq 1 ] && echo APAGADO || echo SIMULAÇÃO): $FEITAS pastas · $((TOTAL/1024)) GB · $PULADAS puladas"
[ "$VALER" -eq 1 ] && echo "$(date -Iseconds) r5 pastas=$FEITAS mb=$TOTAL" >> "$LOG"
[ "$VALER" -eq 1 ] && rm -f "$LISTA"
exit 0
