#!/usr/bin/env bash
# Diagnóstico da máquina — SOMENTE LEITURA. Não mata processo, não apaga arquivo.
# Saída: relatório markdown em stdout + cópia em ~/.claude/limpeza/relatorios/ + 1 linha em runs.log.
# Uso: bash diagnostico.sh [--rapido]   (--rapido pula os du pesados)
# Pasta dos repositórios/bancadas: AGENTIC_OS_PROJETOS (padrão ~/Projects). Feito para Linux (lê /proc e /sys).
set -u
export LC_ALL=C.UTF-8
RAPIDO=0; [ "${1:-}" = "--rapido" ] && RAPIDO=1
BASE="$HOME/.claude/limpeza"; mkdir -p "$BASE/relatorios"
PROJ="${AGENTIC_OS_PROJETOS:-$HOME/Projects}"
TS=$(date +%Y-%m-%d_%H%M); OUT="$BASE/relatorios/$TS.md"
ALERTAS=0
alerta() { ALERTAS=$((ALERTAS+1)); echo "- [ALERTA] $*"; }
ok()     { echo "- [ok] $*"; }
tam()    { timeout 25 du -sh "$1" 2>/dev/null | cut -f1 || echo "?"; }

{
echo "# Diagnóstico da máquina — $(date '+%d/%m/%Y %H:%M')"
echo

# 1. CPU travada pelo thermald (Intel com RAPL; sem o arquivo, mostra 0 W e não alerta)
echo "## 1. CPU"
PL1=$(cat /sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw 2>/dev/null || echo 0)
W=$((PL1/1000000))
if [ "$W" -gt 0 ] && [ "$W" -lt 10 ]; then
  alerta "limite de potência em **${W} W** (normal: 15 W) — thermald travou a CPU. Remédio R1."
else ok "limite de potência ${W} W"; fi
MHZ=$(awk '/cpu MHz/{s+=$4;n++} END{if(n) printf "%d", s/n}' /proc/cpuinfo)
LOAD=$(cut -d' ' -f1-3 /proc/loadavg); NCPU=$(nproc)
L1=$(cut -d' ' -f1 /proc/loadavg | cut -d. -f1)
[ "$L1" -ge $((NCPU)) ] && alerta "load ${LOAD} com ${NCPU} threads (fila de CPU)" || ok "load ${LOAD} (${NCPU} threads)"
[ "${MHZ:-0}" -lt 1000 ] && alerta "clock médio ${MHZ} MHz (travado?)" || ok "clock médio ${MHZ} MHz"
TEMP=$(sensors 2>/dev/null | awk '/Package id 0/{gsub(/[+°C]/,"",$4); print int($4)}')
[ -n "$TEMP" ] && { [ "$TEMP" -ge 85 ] && alerta "CPU a ${TEMP} °C" || ok "CPU a ${TEMP} °C"; }
echo

# 2. Memória
echo "## 2. Memória"
read -r _ MT MU _ _ _ MA < <(free -m | awk '/^Mem/')
read -r _ ST SU _ < <(free -m | awk '/^Swap/')
[ "${MA:-0}" -lt 2000 ] && alerta "só ${MA} MB de RAM disponível (de ${MT})" || ok "${MA} MB de RAM disponível (de ${MT})"
[ "${ST:-0}" -gt 0 ] && [ $((SU*100/ST)) -ge 60 ] && alerta "swap ${SU}/${ST} MB em uso (zram comprimindo = CPU gasta)" || ok "swap ${SU:-0}/${ST:-0} MB"
echo
echo "Top 5 por CPU agora:"
echo '```'
ps -eo pcpu,etimes,comm --sort=-pcpu | awk 'NR>1 && NR<=6 {printf "%5.0f%%  %5.1f h  %s\n", $1, $2/3600, $3}'
echo '```'
echo "Top 6 por RAM:"
echo '```'
ps -eo rss,etimes,comm --sort=-rss | awk 'NR>1 && NR<=7 {printf "%6d MB  %5.1f h  %s\n", $1/1024, $2/3600, $3}'
echo '```'
echo

# 3. Sessões do Claude (cada uma sobe MCPs: ~450-550 MB)
echo "## 3. Sessões do Claude"
SESS=$(ps -eo pid=,etimes=,rss=,args= | awk '$4 ~ /native-binary\/claude$|\/bin\/claude$/ && $0 !~ /chrome-native-host/ && $0 !~ / -p /')
N=$(printf '%s\n' "$SESS" | grep -c . || true)
VELHAS=$(printf '%s\n' "$SESS" | awk '$2>86400' | grep -c . || true)
RSSS=$(printf '%s\n' "$SESS" | awk '{s+=$3} END{printf "%d", s/1024}')
[ "$N" -gt 6 ] && alerta "${N} sessões abertas somando ${RSSS} MB (só o processo principal, sem MCPs)" || ok "${N} sessões abertas (${RSSS} MB)"
[ "$VELHAS" -gt 0 ] && alerta "${VELHAS} sessão(ões) com mais de 24 h — candidatas a fechar no VS Code (Remédio R2)"
MCP=$(ps -eo args= | grep -cE 'mcp|@modelcontextprotocol|chrome-devtools|21st|runware|gemini-notebook' || true)
echo "- [info] ~${MCP} processos de MCP vivos"
echo
echo "MCPs por RAM (cada sessão sobe os seus — Remédio R8):"
echo '```'
for par in "mcp-image:mcp-image" "runware:runware/mcp" "chrome-devtools:chrome-devtools-mcp" "gemini-notebook:notebooklm-mcp" "rea:rea mcp" "claude-mem:claude-mem" "playwright:playwright-mcp"; do
  nome=${par%%:*}; padrao=${par#*:}
  read -r qtd mb < <(ps -eo rss=,args= | awk -v p="$padrao" 'index($0,p) && $0 !~ /awk/ {n++; s+=$1} END{printf "%d %d", n, s/1024}')
  [ "${qtd:-0}" -gt 0 ] && printf '%4d proc  %6d MB  %s\n' "$qtd" "$mb" "$nome"
done
echo '```'
LATEST=$(jq -r '.mcpServers // {} | to_entries[] | select(((.value.args // [])|join(" ")) | test("@latest")) | .key' ~/.claude.json 2>/dev/null | tr '\n' ' ')
[ -n "$LATEST" ] && alerta "MCP com @latest (baixa/checa versão a cada sessão): ${LATEST}— Remédio R8"
echo

# 4. Servidores de dev esquecidos (next/vite/expo com mais de 12 h)
echo "## 4. Servidores de dev órfãos"
ORF=$(ps -eo pid=,etimes=,rss=,args= | awk '$2>43200 && ($0 ~ /next dev|next-server|vite|expo start|metro|tsc --watch|jest --watch/) && $0 !~ /awk/' )
if [ -n "$ORF" ]; then
  printf '%s\n' "$ORF" | while read -r p e r a; do alerta "PID $p · $((e/3600)) h · $((r/1024)) MB · ${a:0:90}"; done
  echo "  (Remédio R3)"
else ok "nenhum servidor de dev com mais de 12 h"; fi
echo

# 5. Disco
echo "## 5. Disco"
for m in / "$HOME"; do
  P=$(df --output=pcent "$m" 2>/dev/null | tail -1 | tr -dc 0-9); L=$(df -h --output=avail "$m" 2>/dev/null | tail -1 | tr -d ' ')
  [ -z "$P" ] && continue
  [ "$P" -ge 85 ] && alerta "\`$m\` em ${P}% (${L} livres)" || ok "\`$m\` em ${P}% (${L} livres)"
done
if [ "$RAPIDO" -eq 0 ]; then
  echo
  echo "Caches recriáveis (Remédio R4):"
  echo '```'
  for d in ~/.npm ~/.cache ~/.local/share/pnpm ~/.cache/ms-playwright ~/.local/share/Trash ~/.claude/projects; do
    [ -d "$d" ] && printf '%8s  %s\n' "$(tam "$d")" "${d/#$HOME/~}"
  done
  command -v docker >/dev/null && timeout 10 docker system df --format '{{.Size}}|{{.Type}}|{{.Reclaimable}}' 2>/dev/null | awk -F'|' '{printf "%8s  docker %s (recuperável %s)\n",$1,$2,$3}'
  echo '```'
fi
echo

# 6. Bancadas / worktrees paradas (node_modules + .next pesam). Sem du por pasta: seria minutos.
echo "## 6. Bancadas e worktrees paradas há 14+ dias"
LISTA=$(for w in "$PROJ"/bancadas/* "$PROJ"/wt-* "$PROJ"/*/wt-*; do
  [ -d "$w" ] || continue
  IDADE=$(( ( $(date +%s) - $(stat -c %Y "$w") ) / 86400 ))
  [ "$IDADE" -lt 14 ] && continue
  NM=0; [ -d "$w/node_modules" ] && NM=1
  SUJO=0; [ -n "$(timeout 5 git -C "$w" status --porcelain --untracked-files=no 2>/dev/null | head -1)" ] && SUJO=1
  echo "$IDADE $NM $SUJO ${w/#$HOME/~}"
done | sort -rn)
PARADAS=$(printf '%s\n' "$LISTA" | grep -c . || true)
if [ "$PARADAS" -gt 0 ]; then
  COMNM=$(printf '%s\n' "$LISTA" | awk '$2==1' | wc -l); SUJAS=$(printf '%s\n' "$LISTA" | awk '$3==1' | wc -l)
  alerta "${PARADAS} paradas · ${COMNM} com node_modules · ${SUJAS} com alteração não commitada (essas NUNCA entram em limpeza automática). Remédio R5."
  echo "  As 8 mais antigas:"
  printf '%s\n' "$LISTA" | head -8 | awk '{printf "  - %s · %s dias%s%s\n", $4, $1, ($2? " · node_modules":""), ($3? " · **alteração não commitada**":"")}'
  printf '%s\n' "$LISTA" > "$BASE/bancadas-paradas.txt"
  echo "  Lista completa: \`~/.claude/limpeza/bancadas-paradas.txt\` (idade, node_modules, sujo, caminho)"
else ok "nenhuma bancada parada"; fi
echo

# 7. Hooks e plugins (hook que chama npm/node a cada tool call trava tudo)
echo "## 7. Hooks e plugins do Claude Code"
NH=$(jq '[.hooks // {} | .[] | .[] | .hooks[]?] | length' ~/.claude/settings.json 2>/dev/null || echo "?")
NP=$(jq '[.enabledPlugins // {} | to_entries[] | select(.value==true)] | length' ~/.claude/settings.json 2>/dev/null || echo "?")
echo "- [info] ${NH} hooks no settings.json · ${NP} plugins ligados"
PESADOS=$(jq -r '.hooks // {} | .[] | .[] | .hooks[]?.command // empty' ~/.claude/settings.json 2>/dev/null | grep -E 'npm exec|npx |@latest' || true)
[ -n "$PESADOS" ] && alerta "hook chamando npm/npx a cada evento: ${PESADOS:0:120} (Remédio R6)" || ok "nenhum hook com npm exec/npx"
echo

# 8. Serviços
echo "## 8. Serviços"
F=$(systemctl --failed --no-legend 2>/dev/null | wc -l); FU=$(systemctl --user --failed --no-legend 2>/dev/null | wc -l)
[ $((F+FU)) -gt 0 ] && alerta "$((F+FU)) serviço(s) com falha: $( { systemctl --failed --no-legend --plain 2>/dev/null; systemctl --user --failed --no-legend --plain 2>/dev/null; } | awk '{print $1}' | tr '\n' ' ')" || ok "nenhum serviço com falha"
echo

echo "---"
echo "**${ALERTAS} alerta(s).** Relatório: \`${OUT/#$HOME/~}\`. Remédios em \`~/.claude/skills/limpeza/remedios.md\`."
} | tee "$OUT"

echo "$(date -Iseconds) diagnostico alertas=$(grep -c '\[ALERTA\]' "$OUT") arquivo=$OUT" >> "$BASE/runs.log"
