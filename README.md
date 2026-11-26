# Project-TurboWarp

[TurboWarp](https://turbowarp.org/)のスクリプトを基にしたミラーサイトです。RenderとGithub Actionsのどちらでもデプロイして動かすことが可能です。

## 作り方
詳細は自分のアカウントが出している[Project-TurboWarp-Tutorial](https://github.com/20250199-tomohiro/Project-TurboWarp-Tutorial)をご確認ください。
## ライセンス

ミラースクリプトはMITライセンスの下で提供されています（LICENSEを参照）。ミラースクリプトによって生成されたウェブサイトは、GPL 3.0の下で提供されています。


## TurboWarp Packager

The authenticated `/packager` page uses the official `@turbowarp/packager` Node.js API (pinned to 3.14.0) to export projects saved in the current account. Supported outputs include standalone HTML, ZIP, and desktop packages for supported Windows, macOS, and Linux targets. Generated files are streamed back as downloads; desktop targets may require downloading large runtime assets from the official Packager asset servers.

The Packager integration is available from the account menu and the "私の作品" page. It only packages projects owned by the signed-in account.

The TurboWarp Packager is licensed under MPL-2.0. See the upstream [TurboWarp/packager](https://github.com/TurboWarp/packager) repository and its license for attribution and license details.


## Shared TurboWarp-style UI

Account pages (`/my`, `/friends`, `/messages`, `/collaboration`, and `/packager`) share the root-level `mirror-ui.css` theme. It follows the TurboWarp/Scratch GUI visual language: compact Helvetica typography, a blue menu bar, white panels, compact rounded controls, clear focus states, and responsive navigation. The account dropdown uses the same blue accent and neutral menu styling. A dark color-scheme variant is included.
