#!/usr/bin/env bash
set -euo pipefail
: "${TRAMPOLINE_HOST:?TRAMPOLINE_HOST を設定してください}"
: "${EXTENSIONS_HOST:?EXTENSIONS_HOST を設定してください}"

# ---- キャッシュの準備 ----
# Render が次のビルドに引き継ぐと公式に説明されているのは $XDG_CACHE_HOME の中。
# 念のため、プロジェクトのフォルダ内にも保存して、どちらが効くかを診断で確認する
CACHE_BASE_A="${XDG_CACHE_HOME:-$HOME/.cache}"
CACHE_DIR_A="$CACHE_BASE_A/mirror-gui"
CACHE_DIR_B="$PWD/.build-cache"

# scratch-gui の最新コミット。取得に失敗したら毎回違う値にして、必ずフルビルドにする
GUI_COMMIT="$(git ls-remote https://github.com/TurboWarp/scratch-gui HEAD 2>/dev/null | cut -f1 || true)"
[ -n "$GUI_COMMIT" ] || GUI_COMMIT="unknown-$(date +%s)"

# キャッシュの鍵: scratch-gui の版 + 置換先のドメイン + この build.sh と patch-gui.py の中身
KEY="$(printf '%s|%s|%s|%s' "$GUI_COMMIT" "$TRAMPOLINE_HOST" "$EXTENSIONS_HOST" "$(cat build.sh patch-gui.py | sha256sum | cut -d' ' -f1)" | sha256sum | cut -c1-16)"
CACHED=""
for d in "$CACHE_DIR_A" "$CACHE_DIR_B"; do
  if [ -d "$d/$KEY/build" ]; then CACHED="$d/$KEY"; break; fi
done

echo "--- 診断(キャッシュが効かないときは、この部分を教えてください) ---"
echo "scratch-gui の版: $GUI_COMMIT"
echo "キャッシュの鍵: $KEY"
echo "XDG_CACHE_HOME: ${XDG_CACHE_HOME:-(未設定)}"
echo "前回の印(XDG側): $(cat "$CACHE_BASE_A/mirror-marker" 2>/dev/null || echo なし)"
echo "前回の印(プロジェクト内): $(cat "$CACHE_DIR_B/marker" 2>/dev/null || echo なし)"
echo "保存先A の中身: $(ls "$CACHE_DIR_A" 2>/dev/null | tr '\n' ' ' || true)"
echo "保存先B の中身: $(ls "$CACHE_DIR_B" 2>/dev/null | tr '\n' ' ' || true)"
echo "---"

rm -rf scratch-gui

if [ -n "$CACHED" ]; then
  echo "--- キャッシュを使用します: $CACHED ---"
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

  # TurboWarp 標準の「パソコンへの保存」メニューを、ソースから取り除く(アカウントメニューの保存と競合するため)
  python3 ../patch-gui.py

  NODE_ENV=production npm run build
  cd ..

  # 古いキャッシュを消して、今回のビルド結果(patch.py を通す前)を、2か所に保存する
  for d in "$CACHE_DIR_A" "$CACHE_DIR_B"; do
    rm -rf "$d"
    mkdir -p "$d/$KEY"
    cp -r scratch-gui/build "$d/$KEY/build"
  done
fi

# 保存先が次のビルドに引き継がれるかを確かめるための印(毎回更新する)
mkdir -p "$CACHE_BASE_A" "$CACHE_DIR_B"
date -u +%FT%TZ > "$CACHE_BASE_A/mirror-marker"
date -u +%FT%TZ > "$CACHE_DIR_B/marker"

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

# アカウントメニューのスクリプトを、すべてのHTMLページに差し込む
cp account-menu.js scratch-gui/build/account-menu.js
for f in scratch-gui/build/*.html; do
  sed -i 's#</body>#<script src="/account-menu.js"></script></body>#' "$f"
done
grep -q "account-menu.js" scratch-gui/build/index.html || { echo "account-menu.js の差し込みに失敗しました"; exit 1; }
grep -q "account-menu.js" scratch-gui/build/editor.html || { echo "editor.html への差し込みに失敗しました"; exit 1; }
