#!/bin/zsh
# update_data.sh — Kept for backward compatibility. Calls run_all.sh.
cd "$(dirname "$0")" || exit 1
exec ./run_all.sh "$@"
