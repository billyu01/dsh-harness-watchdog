#!/usr/bin/env bash
# 启用看门狗：往指定 profile 的补丁里追加一行挂载，并先备份原文件。
# 幂等：已经启用时不重复追加。
set -euo pipefail

# 用法：bash scripts/enable.sh [profile 名，默认 desktop]
#   当前 19387 界面跑的是 desktop profile；web profile 供 `dsh web` 使用。
PROFILE="${1:-${DSH_PROFILE:-desktop}}"
PATCH="${DSH_PROFILE_PATCH:-$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml}"

if [[ ! -f "$PATCH" ]]; then
  echo "找不到 profile 补丁：$PATCH" >&2
  exit 1
fi

if grep -q "id: harness-watchdog" "$PATCH"; then
  echo "已经启用过了，未改动：$PATCH"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
cp -p "$PATCH" "$PATCH.bak-$STAMP"
echo "已备份：$PATCH.bak-$STAMP"

cat >> "$PATCH" <<'EOF'

# >>> harness-watchdog (managed) — 这一段由 scripts/disable.sh 精确删除，请勿手工改结构
- insert:
    - id: harness-watchdog
      name: dsh-harness-watchdog
# <<< harness-watchdog (managed)
EOF

echo "已启用 harness-watchdog。"
echo "DSH 的 HMR 会监听 profile 补丁变化，应即时生效。"
echo "验证：curl -s http://127.0.0.1:19387/harness-watchdog/status | head -c 400"
