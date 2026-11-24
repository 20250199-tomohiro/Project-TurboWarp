#!/usr/bin/env bash
set -euo pipefail
: "${TRAMPOLINE_HOST:?TRAMPOLINE_HOST を設定してください}"

rm -rf scratch-gui
git clone --depth 1 https://github.com/TurboWarp/scratch-gui
cd scratch-gui
npm ci
echo "--- 拡張機能URL ---"

# trampolineのURLが書かれたファイルを探して置換する
grep -rlI "trampoline\.turbowarp\." src node_modules/@turbowarp node_modules/scratch-* > /tmp/hits.txt 2>/dev/null || true
echo "--- 置換対象 ---"
cat /tmp/hits.txt
[ -s /tmp/hits.txt ] || { echo "trampolineのURLが見つかりませんでした"; exit 1; }
xargs -a /tmp/hits.txt sed -i -E "s#trampoline\.turbowarp\.(xyz|org)#${TRAMPOLINE_HOST}#g"
: "${EXTENSIONS_HOST:?EXTENSIONS_HOST を設定してください}"
sed -i "s#extensions\.turbowarp\.org#${EXTENSIONS_HOST}#g" \
  src/containers/extension-library.jsx src/lib/libraries/extensions/index.jsx src/containers/tw-security-manager.jsx

NODE_ENV=production npm run build
cd ..

# patch.py が index.html を消す前に、閲覧ページを player.html として残す
cp scratch-gui/build/index.html scratch-gui/build/player.html

python3 patch.py

# 「探す」ボタンのスクリプトを、トップ(index.html)と閲覧ページ(player.html)に差し込む
cp search-button.js scratch-gui/build/search-button.js
sed -i 's#</body>#<script src="/search-button.js"></script></body>#' \
  scratch-gui/build/index.html scratch-gui/build/player.html
grep -q "search-button.js" scratch-gui/build/index.html || { echo "index.html への差し込みに失敗しました"; exit 1; }
grep -q "search-button.js" scratch-gui/build/player.html || { echo "player.html への差し込みに失敗しました"; exit 1; }
