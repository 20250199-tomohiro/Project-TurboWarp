"""
TurboWarp 標準の「パソコンへの保存」メニューを、ビルド前のソースから取り除く。

scratch-gui のフォルダの中で実行する(build.sh が `cd scratch-gui` した後に呼ぶ)。
取り除く対象は、ファイルメニューの <SB3Downloader> ... </SB3Downloader> のまとまり。
この中に、次の3つの項目が入っている。
  - 「コンピューターに保存」        (gui.menuBar.downloadToComputer)
  - 「"ファイル名".sb3 に保存」     (tw.saveTo / 上書き保存)
  - 「名前を付けて保存...」など      (tw.saveAs / tw.oldDownload)
取り除けなかった場合は、警告を出してそのまま続ける(画面側の非表示処理が代わりに働く)。
"""
import re
import sys
from pathlib import Path

TARGET = Path('src/components/menu-bar/menu-bar.jsx')
MARKER = 'getSaveToComputerHandler'  # このまとまりが「パソコンへの保存」だと見分けるための目印
OPEN_RE = re.compile(r'<SB3Downloader(?=[\s>/])')
CLOSE = '</SB3Downloader>'


def warn(message):
    print('警告: ' + message)
    print('警告: パソコンへの保存メニューは、ソースから取り除けませんでした(画面側の非表示処理だけが働きます)')


def find_block_end(text, start):
    """start にある <SB3Downloader ...> に対応する </SB3Downloader> の直後の位置を返す。見つからなければ None。"""
    depth = 0
    pos = start
    while True:
        m_open = OPEN_RE.search(text, pos)
        i_close = text.find(CLOSE, pos)
        if i_close < 0:
            return None
        if m_open and m_open.start() < i_close:
            depth += 1
            pos = m_open.end()
        else:
            depth -= 1
            pos = i_close + len(CLOSE)
            if depth == 0:
                return pos


def replacement_for(before):
    """ブロックの直前の文字から、JSX の子として置くか、式として置くかを決める。"""
    stripped = before.rstrip()
    if not stripped:
        return None
    if stripped.endswith('=>') or stripped.endswith('return'):
        return 'null'
    last = stripped[-1]
    if last in '(?:&|,=':
        return 'null'
    if last in '>}':
        return '{null}'
    return None


def main():
    if not TARGET.exists():
        warn(str(TARGET) + ' が見つかりません')
        return 0

    text = TARGET.read_text(encoding='utf-8')
    starts = [m.start() for m in OPEN_RE.finditer(text)]
    if not starts:
        warn('<SB3Downloader> が見つかりません')
        return 0

    removed = 0
    # 後ろから処理して、前の位置がずれないようにする
    for start in reversed(starts):
        end = find_block_end(text, start)
        if end is None:
            continue
        block = text[start:end]
        if MARKER not in block:
            continue
        repl = replacement_for(text[:start])
        if repl is None:
            warn('<SB3Downloader> の置き換え方を判断できませんでした')
            continue
        text = text[:start] + repl + text[end:]
        removed += 1

    if removed == 0:
        warn('「パソコンへの保存」のまとまりが見つかりませんでした')
        return 0

    TARGET.write_text(text, encoding='utf-8')
    print('パソコンへの保存メニューを取り除きました(' + str(removed) + ' か所): ' + str(TARGET))
    return 0


if __name__ == '__main__':
    sys.exit(main())
