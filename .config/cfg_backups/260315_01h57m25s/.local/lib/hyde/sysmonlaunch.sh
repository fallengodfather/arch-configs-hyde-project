#!/usr/bin/env bash
[[ $HYDE_SHELL_INIT -ne 1 ]] && eval "$(hyde-shell init)"
notify-send -a "Deprecation Notice" "sysmonitor.sh is deprecated. Please use hyde-shell system.monitor open instead." -i dialog-information

"${LIB_DIR}/hyde/system.monitor.sh" "$@"
