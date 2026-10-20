#!/usr/bin/env bash
# Modo build pesado — pausa os timers de usuário pesados/não urgentes enquanto roda um build.
# Uso: modo-build.sh on [--ate HH:MM] | off | status
#   on     : para (stop) os timers da lista que estiverem ativos, guarda quais eram em
#            ~/.claude/rotinas/estado/modo-build.json e agenda o auto-desligar em 2 h.
#   on --ate HH:MM : igual, mas o auto-desligar é no próximo HH:MM (ex.: a Central pode chamar
#            --ate 08:00 para pausar até a manhã seguinte). Se já estiver ligado, só reagenda o auto-desligar. O JSON ganha "volta".
#   off    : religa EXATAMENTE os que estavam ativos (nada além) e cancela o auto-desligar.
#   status : imprime o JSON.
# rotina-capacidade.timer fica sempre LIGADO (é ele que avisa se a máquina sufocar).
# Só usa "stop/start" (vale até o próximo boot); não mexe em enable/disable.
set -euo pipefail
# Precisa de: jq, systemd (systemctl --user, systemd-run), notify-send (opcional).
# Lista dos timers pausados no modo build. Edite para os seus (nome exato do .timer em ~/.config/systemd/user).
PESADOS=(saude-ambientes.timer cerebro-reindexar.timer rotina-vigia-ci.timer rotina-onde-parei.timer rotina-lembrete-commit.timer)
EST="$HOME/.claude/rotinas/estado/modo-build.json"
AUTO=modo-build-auto-off
LOG="$HOME/.claude/limpeza/runs.log"
mkdir -p "$(dirname "$LOG")"
SELF="$(readlink -f "$0")"  # caminho absoluto: o systemd-run não acha "modo-build.sh" relativo
mkdir -p "$(dirname "$EST")"
agora() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ativo() { [ -f "$EST" ] && [ "$(jq -r '.ativo' "$EST")" = "true" ]; }
avisa() { notify-send -a 'Modo build' -i dialog-information "$1" "$2" 2>/dev/null || true; }
ATE=""
if [ "${1:-}" = on ] && [ "${2:-}" = --ate ]; then
  ATE="${3:-}"
  if ! [[ "$ATE" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then echo "uso: $0 on [--ate HH:MM]" >&2; exit 2; fi
elif [ "${1:-}" = on ] && [ -n "${2:-}" ]; then
  echo "uso: $0 on [--ate HH:MM]" >&2; exit 2
fi
# Agenda o auto-desligar (2 h, ou o próximo HH:MM com --ate) e deixa em VOLTA o instante em ISO UTC.
agendar() {
  systemctl --user stop "$AUTO.timer" 2>/dev/null || true
  systemctl --user reset-failed "$AUTO.service" "$AUTO.timer" 2>/dev/null || true
  local alvo
  if [ -n "$ATE" ]; then
    alvo=$(date -d "today $ATE" +%s)
    if [ "$alvo" -le "$(date +%s)" ]; then alvo=$(date -d "tomorrow $ATE" +%s); fi
    systemd-run --user --quiet --unit="$AUTO" --on-calendar="$(date -d "@$alvo" '+%Y-%m-%d %H:%M:00')" --timer-property=AccuracySec=1min "$SELF" off
  else
    alvo=$(( $(date +%s) + 7200 ))
    systemd-run --user --quiet --unit="$AUTO" --on-active=2h --timer-property=AccuracySec=1min "$SELF" off
  fi
  VOLTA=$(date -u -d "@$alvo" +%Y-%m-%dT%H:%M:%SZ)
}

case "${1:-status}" in
  on)
    if ativo; then
      if [ -n "$ATE" ]; then
        agendar
        jq --arg volta "$VOLTA" '.volta=$volta' "$EST" > "$EST.tmp" && mv "$EST.tmp" "$EST"
        echo "$(agora) modo-build reagendado volta=$VOLTA" >> "$LOG"
        cat "$EST"; exit 0
      fi
      echo "modo build já ligado desde $(jq -r .desde "$EST")"; exit 0
    fi
    agendar  # antes de parar os timers: se agendar falhar, nada fica parado sem volta
    parados=()
    for t in "${PESADOS[@]}"; do
      if systemctl --user is-active --quiet "$t"; then systemctl --user stop "$t"; parados+=("$t"); fi
    done
    jq -n --arg desde "$(agora)" --arg volta "$VOLTA" --args '{ativo:true, desde:$desde, volta:$volta, timers:$ARGS.positional}' "${parados[@]}" > "$EST"
    echo "$(agora) modo-build on parados=${parados[*]:-nenhum} volta=$VOLTA" >> "$LOG"
    avisa 'Modo build LIGADO' "Pausei ${#parados[@]} rotina(s): ${parados[*]:-nenhuma}. Desliga sozinho $([ -n "$ATE" ] && echo "às $ATE" || echo "em 2 h") ou: modo-build.sh off"
    cat "$EST" ;;
  off)
    if ! ativo; then echo "modo build já desligado"; exit 0; fi
    mapfile -t volta < <(jq -r '.timers[]' "$EST")
    for t in "${volta[@]}"; do systemctl --user start "$t"; done
    jq --arg ate "$(agora)" '.ativo=false | .ate=$ate' "$EST" > "$EST.tmp" && mv "$EST.tmp" "$EST"
    # cancela o auto-desligar (inofensivo quando quem chama é o próprio auto)
    systemctl --user stop "$AUTO.timer" 2>/dev/null || true
    echo "$(agora) modo-build off religados=${volta[*]:-nenhum}" >> "$LOG"
    avisa 'Modo build DESLIGADO' "Religuei ${#volta[@]} rotina(s): ${volta[*]:-nenhuma}"
    cat "$EST" ;;
  status)
    [ -f "$EST" ] && cat "$EST" || echo '{"ativo":false}' ;;
  *) echo "uso: $0 on|off|status" >&2; exit 2 ;;
esac
