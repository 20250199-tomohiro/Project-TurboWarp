#!/usr/bin/env bash
set -euo pipefail
: "${TRAMPOLINE_HOST:?TRAMPOLINE_HOST を設定してください}"
: "${EXTENSIONS_HOST:?EXTENSIONS_HOST を設定してください}"

# ---- キャッシュの準備 ----
# Render はビルド間で $XDG_CACHE_HOME(通常は ~/.cache)を保持する
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/mirror-gui"

# scratch-gui の最新コミット。取得に失敗したら毎回違う値にして、必ずフルビルドにする
GUI_COMMIT="$(git ls-remote https://github.com/TurboWarp/scratch-gui HEAD 2>/dev/null | cut -f1 || true)"
[ -n "$GUI_COMMIT" ] || GUI_COMMIT="unknown-$(date +%s)"

# キャッシュの鍵: scratch-gui の版 + 置換先のドメイン + この build.sh の中身
KEY="$(printf '%s|%s|%s|%s' "$GUI_COMMIT" "$TRAMPOLINE_HOST" "$EXTENSIONS_HOST" "$(sha256sum build.sh | cut -d' ' -f1)" | sha256sum | cut -c1-16)"
CACHED="$CACHE_ROOT/$KEY"

rm -rf scratch-gui

if [ -d "$CACHED/build" ]; then
  echo "--- キャッシュを使用します: $KEY ---"
  mkdir -p scratch-gui
  cp -r "$CACHED/build" scratch-gui/build
else
  echo "--- キャッシュがないため、フルビルドします: $KEY ---"
  git clone --depth 1 https://github.com/TurboWarp/scratch-gui
  cd scratch-gui
  npm ci --no-audit --no-fund --prefer-offline

  # trampoline の URL が書かれたファイルを探して、自前の trampoline に置換する
  grep -rlI "trampoline\.turbowarp\." src node_modules/@turbowarp node_modules/scratch-* > /tmp/hits.txt 2>/dev/null || true
  echo "--- 置換対象 ---"
  cat /tmp/hits.txt
  [ -s /tmp/hits.txt ] || { echo "trampolineのURLが見つかりませんでした"; exit 1; }
  xargs -a /tmp/hits.txt sed -i -E "s#trampoline\.turbowarp\.(xyz|org)#${TRAMPOLINE_HOST}#g"

  # 拡張機能ギャラリーの取得先を、自前のギャラリーに置換する
  sed -i "s#extensions\.turbowarp\.org#${EXTENSIONS_HOST}#g" \
    src/containers/extension-library.jsx \
    src/lib/libraries/extensions/index.jsx \
    src/containers/tw-security-manager.jsx

  NODE_ENV=production npm run build
  cd ..

  # 古いキャッシュを消して、今回のビルド結果(patch.py を通す前)を保存する
  rm -rf "$CACHE_ROOT"
  mkdir -p "$CACHED"
  cp -r scratch-gui/build "$CACHED/build"
fi

# ---- ここから下は毎回実行(軽い処理) ----

# patch.py が index.html を消す前に、閲覧ページを player.html として残す
cp scratch-gui/build/index.html scratch-gui/build/player.html

python3 patch.py

# 「探す」ボタンのスクリプトを、トップ(index.html)と閲覧ページ(player.html)に差し込む
cp search-button.js scratch-gui/build/search-button.js
sed -i 's#</body>#<script src="/search-button.js"></script></body>#' \
  scratch-gui/build/index.html scratch-gui/build/player.html
grep -q "search-button.js" scratch-gui/build/index.html || { echo "index.html への差し込みに失敗しました"; exit 1; }
grep -q "search-button.js" scratch-gui/build/player.html || { echo "player.html への差し込みに失敗しました"; exit 1; }
