#!/usr/bin/env bash
[[ $HYDE_SHELL_INIT -ne 1 ]] && eval "$(hyde-shell init)"
notify-send -a "Deprecation Notice" "systemupdate is deprecated. Please use hyde-shell system.update instead." -i dialog-information
"${LIB_DIR}/hyde/system.update.sh" "$@"
