#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Chưa có Node.js. Hãy cài Node.js 24 LTS kèm npm rồi thử lại.' >&2
  exit 1
fi
exec node scripts/launch.mjs
