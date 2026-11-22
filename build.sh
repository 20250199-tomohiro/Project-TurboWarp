#!/usr/bin/env bash
set -euo pipefail
: "${TRAMPOLINE_HOST:?TRAMPOLINE_HOST を設定してください}"

rm -rf scratch-gui
git clone --depth 1 https://github.com/TurboWarp/scratch-gui
cd scratch-gui
npm ci
echo "--- 拡張機能URL ---"
grep -rnI "extensions\.turbowarp" src | head -30 || true

# trampolineのURLが書かれたファイルを探して置換する
grep -rlI "trampoline\.turbowarp\." src node_modules/@turbowarp node_modules/scratch-* > /tmp/hits.txt 2>/dev/null || true
echo "--- 置換対象 ---"
cat /tmp/hits.txt
[ -s /tmp/hits.txt ] || { echo "trampolineのURLが見つかりませんでした"; exit 1; }
xargs -a /tmp/hits.txt sed -i -E "s#trampoline\.turbowarp\.(xyz|org)#${TRAMPOLINE_HOST}#g"

NODE_ENV=production npm run build
cd ..
python3 patch.py
