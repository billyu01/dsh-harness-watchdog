#!/usr/bin/env bash
# 停用看门狗：精确删除 enable.sh 追加的那一段，并备份当前补丁。
set -euo pipefail

# 用法：bash scripts/disable.sh [profile 名，默认 desktop]
#   当前 19387 界面跑的是 desktop profile；web profile 供 `dsh web` 使用。
PROFILE="${1:-${DSH_PROFILE:-desktop}}"
PATCH="${DSH_PROFILE_PATCH:-$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml}"

if [[ ! -f "$PATCH" ]]; then
  echo "找不到 profile 补丁：$PATCH" >&2
  exit 1
fi

if ! grep -q ">>> harness-watchdog (managed)" "$PATCH"; then
  echo "没有找到看门狗的挂载段，未改动：$PATCH"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
cp -p "$PATCH" "$PATCH.bak-$STAMP"
echo "已备份：$PATCH.bak-$STAMP"

python3 - "$PATCH" <<'PY'
import sys
path = sys.argv[1]
begin = '# >>> harness-watchdog (managed)'
end = '# <<< harness-watchdog (managed)'
with open(path, encoding='utf-8') as fh:
    lines = fh.readlines()
out, skipping = [], False
for line in lines:
    stripped = line.rstrip('\n')
    if stripped.startswith(begin):
        skipping = True
        continue
    if skipping:
        if stripped.startswith(end):
            skipping = False
        continue
    out.append(line)
# 去掉文件末尾因为追加而多出来的空行
while out and out[-1].strip() == '':
    out.pop()
if out and not out[-1].endswith('\n'):
    out.append('\n')
with open(path, 'w', encoding='utf-8') as fh:
    fh.writelines(out)
print('已删除挂载段。')
PY

echo "已停用 harness-watchdog。"
