# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Typst-pad：**仿 Typora 的 Typst 桌面编辑器，两套 UI**——「写作模式」（默认，单栏整页纸张：公式与标记就地排版、光标/选区进入即展开源码、无行号）与「源代码模式」（`Ctrl+/`，双栏：等宽代码编辑器 + 右栏整页预览）。前端 SvelteKit SPA（adapter-static），桌面壳 Tauri 2（Rust），编译渲染用**内嵌 typst crate**（0.15.x，Rust 进程内编译，本地字体）。代码注释与 README 均为中文。

## 交接须知（新同学先读这一节）

**这是什么**：仿 Typora 的 Typst 桌面编辑器 —— 「写作模式」（单栏整页纸张、公式与标记就地排版、光标进入即展开源码）与「源代码模式」（`Ctrl+/`，双栏：等宽编辑器 + 整页预览）。纯本地运行：前端 SvelteKit SPA（adapter-static），桌面壳 Tauri 2，排版引擎是**内嵌的 typst crate**（Rust 进程内编译，没有 wasm、没有网络依赖，字体随包分发）。

**交接时的状态（2026-09-14）**：

- 版本 `0.7.6`（0.7.5 之后的修复版：**公式下标不再被裁** + **大缩放下状态栏不再折行** + 引擎的 `ResizeObserver loop` 提示不再误报成脚本错误）。0.7.4 是**首个"自动更新真的能生效"的版本**：0.7.3 引入了 updater，但仓库当时还是私有的，客户端拉不到清单；仓库公开 + 本版发布之后这条链路才第一次跑通）。`main` 与 `origin/main` 同步；tag `v0.7.4` 已推，`release.yml` 建好草稿后由后台一次性任务自动 Publish —— **2026-09-14 实测已发布**：匿名取 `releases/latest/download/latest.json` 返回 **HTTP 200 且 `version` 已是 `0.7.4`**（签名对应 `Typst-pad_0.7.4_x64-setup.exe`），安装包匿名可达（HTTP 200 / 16.75 MB）。**下一次发版的验收就照这两条 curl 做**（见下）。
- **发行状态（2026-09-14 实测）：`v0.7.3`、`v0.7.2`、`v0.7.0` 已发布；只有 `v0.7.1` 还是草稿**（handover 里曾把 v0.7.2 误记成草稿）；`v0.7.4` 见上一条。发版时 `release.yml` 建的仍是**草稿**，**必须手动 Publish**（或按下方约定直接发）——草稿资产不对外，客户端拉不到 `latest.json`，自动更新不会生效。
  - 发布后建议验一次：`gh api repos/Z3O1/Typst-pad/releases/latest --jq .tag_name` 应为新 tag；清单内容用 `gh api repos/Z3O1/Typst-pad/releases/assets/<latest.json 的 id> -H "Accept: application/octet-stream"` 取回核对（version / url / signature）。**匿名可达性是自动更新的硬前提，验这条最直接**：
    ```bash
    /mnt/c/Windows/System32/curl.exe -sL -o NUL -w '%{http_code}\n' https://github.com/Z3O1/Typst-pad/releases/latest/download/latest.json   # 期望 200
    ```
  - **2026-09-14：仓库已从私有转为公开**（用户当时选了"转公开，一条命令就通"）。转公开前自动更新**必然失败**：updater 是匿名请求、不带任何 GitHub 凭据，私有仓库对匿名一律 404（仓库首页 / api / raw / release 资产全 404，连 GitHub 的 404 页都带 `Server: github.com`），而插件对**非 2xx 只记日志**、最后统一报 `Could not fetch a valid release JSON from the remote` —— 用户看到的状态栏原话是「检查更新失败：没有取到更新清单（latest.json）…原始错误：Could not fetch a valid release JSON from the remote」。
    - **别把它误判成「本机网络过滤」**（2026-09-14 犯过一次，已经改回来）：判断顺序是 ① `gh api repos/Z3O1/Typst-pad --jq .private`（现在应为 `false`）→ ② 上面那条 curl 的 `%{http_code}` → ③ 才轮到网络。同一个教训还有第二层：**仓库转公开之前，连安装包都是别人下载不到的**（不只是自动更新）。
    - 转公开前查过历史里没有任何私钥/密钥文件（`git log --diff-filter=A --name-only` 无 `.key`/`.env`/`secret`，`git grep 'minisign encrypted secret key'` 全历史无命中），`.updater-keys/` 一直是 gitignore —— 所以转公开**没有**泄露签名私钥，红线 10 的密钥仍然是安全的。
    - 仓库公开后 GitHub 的 secret scanning / push protection 会生效：**今后任何把私钥 commit 进去的操作会被直接拒绝推送**，别把这条拒绝误读成 SSH 或权限坏了。
- **自动更新已接入（0.7.3）**：`tauri-plugin-updater` + 更新弹窗/状态栏提示/设置开关；签名密钥已生成并设进仓库 Secrets，`latest.json` 由 CI 生成。**注意顺序**：`tauri.conf.json` 里已经有 pubkey，所以任何 `tauri build`（含 main 的 CI）都必须拿得到私钥，**不要删那两个 Secrets**；0.7.3 之前的版本里没有 updater，**要手动装一次 0.7.3 才进入自动更新通道**（之后 0.7.4 起才能自动升）。细节见「自动更新（tauri-plugin-updater）数据流」与「CI / 发布约定」。
- 最近一轮（**0.7.6**，2026-09-14 发，用户指令）：① **公式下标不再被裁**——用户反馈「`a_0 = 0` 的下半部分没有渲染」，根因是 typst 把上下标画到**帧外**而公式页是贴边页、SVG 视口即裁剪框（现在按**墨迹包围盒**撑画布，见「公式渲染」那节）；② **大缩放下状态栏不再折成长条** + ③ **Chromium 的 `ResizeObserver loop` 提示不再被报成「脚本错误」**（用户截图反馈「放大到 190% 之后界面像烂了」，见「界面缩放」那节最后两条注解）。
- 上一轮（**0.7.5**，2026-09-14 发）：① **更新说明的 Markdown 渲染**——用户反馈「更新说明无法渲染」，弹窗里以前直接显示 CHANGELOG 的 Markdown 原文（`### Fixed`、`**粗体**`），现在由 `update-notes.ts` 渲染成受控子集的安全 HTML（见「自动更新数据流」末尾 + 第 26 组验收）；② **界面缩放两轮加固**——先反馈「放大根本没用，缩小有用」，再反馈「最大后无法用滚轮缩小」，两者是**同一个机制**：引擎（WebView2）没接受放大，而 `uiZoom` 照旧涨到上限，于是往下滚要滚十几档才有反应。现在把档位拉回引擎实际给的值（见「界面缩放」那节的几条注解），并且滚轮监听挪到 window 捕获阶段、调档后再确认一次。**现象只在真机 WebView2 上、Chromium 复现不出来，所以最后靠"模拟引擎"的验收（第 27 组）把这条路径锁住。**
- 最近几轮：**0.7.4 = 界面缩放**（Ctrl+滚轮，`zoom.ts` + webview `setZoom`）+ **正文字体设置**（含额外字体目录、中文回退修复）+ 仓库转公开（自动更新首次真正可用的**运维前提**）；0.7.2→0.7.3 是**自动更新**（含签名密钥约束与 `latest.json` 发版链路）；0.7.1→0.7.2 修的是「写作模式」的可用性 bug（Alt 抢焦点、装饰异常导致编辑区卡死、空正文标题崩溃、整行选区底色凸出）。**这些经验都在下面「改动前的红线」和各章节的"勿回退"里，动编辑器/装饰代码前先扫一遍。**

**5 分钟上手**

```bash
npm install
npm run tauri dev        # 桌面应用（WSL 里能跑；libEGL 那几行警告属正常，见「环境备忘」）
npm run check            # 类型检查（当前 0 errors / 1 warning，那 1 个是历史遗留的 previewHost）
npm test                 # 前端 + 脚本单测（24 个文件 / 357 项）
cargo test --manifest-path src-tauri/Cargo.toml    # Rust 单测（33 passed / 1 ignored）
node scripts/check-fonts.mjs                       # 打包字体魔数校验

# 本地打包需要更新签名私钥（配置里已有 pubkey → 缺私钥打包会直接失败）：
# TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/typst-pad.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… npm run tauri build

# 无显示器环境下的「浏览器验收」（本仓库的主力验收手段）：**换端口跑，别跟 tauri dev 抢 1420**
npm run dev -- --port 1425
BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg.mjs        # 110 项交互验收 + 截图
npm run fixtures:math
BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg-visual.mjs # 15 项真实排版视觉验收
BROWSER_CHECK_PORT=1425 node scripts/browser-check/probe.mjs          # 页面坏了先用它看
```

**改动前的红线（都是踩过的，勿回退）**

1. **改 `src/` 会 HMR 到正在运行的 `tauri dev`；改 `src-tauri/` 会让 Tauri 重启应用**（未保存内容靠"启动时恢复上次内容"兜住；排查"内容怎么变了"时先想这一条）。
2. `editorDoc` 必须是编辑器内容的**实时镜像**，绝不允许落后（否则丢未保存内容）。
3. `live-preview.ts` 里任何 `Decoration.*.range(a, b)` 都要 `b > a`；装饰计算与 widget 渲染都在 try/catch 里 —— **别把可能抛异常的代码挪到 try 之外**（抛进 CodeMirror 事务 = 编辑区卡死，用户报过）。
4. 写作模式的左右留白必须挂 `.cm-scroller`，**不能**是 `.cm-content` 的 `padding`（否则整行选区底色比文字列两边各宽 48px）。
5. 菜单（Alt / 鼠标）**不许夺走编辑区焦点**（用户明确要求："不要改变当前编辑位置"）。
6. `src-tauri/fonts/` 不放 `static/`（会被 SvelteKit 打进前端产物，安装包白胖 5.7MB）。
7. `vite.config.js` 的 **dev 白屏修复三件套**与 `optimizeDeps.exclude: ["codemirror-lang-typst"]` 不许删（删了 WSL/WebKit 下会白屏）。
8. 发版纪律：版本号三处一致；rust-cache 不许加 `cache-on-failure`。
9. **绝不阻塞等 GitHub workflow（用户 2026-09-14 连着强调三次：「不要等 CI 测试结束再执行后面的命令」「以后不要等 github workflow 阻塞」「别等 workflow 记录一下」）**：推 main、打 tag、执行后续命令**一律不等** CI / Release 跑完；**不要**挂"等 run 结束再执行"的后台轮询任务；报告状态最多**单次**查一次 `gh run list`（单查可以，轮询不行）。
   - 原有的「别在 CI 运行中 push main」**按用户指示作废**：`ci.yml` 的 concurrency 会 cancel 掉 main 上正在跑的 run（被 cancel 的 run 不保存 rust-cache，缓存代价仍在），但他明确接受这个代价、**不接受为它停下等 CI**。唯一保留的建议是"能一次推完的提交就一次推完"（少制造几次 cancel），不是"等"。详见「和这位用户协作的偏好」。
   - 边界：禁止的是**阻塞我的回合**与**轮询循环**（`while ... gh run list` 那种）；**一次性延时动作可以**——例如"构建完成后把草稿 Release 直接 Publish"这类一条命令的补发（见「CI / 发布约定」的版本升级流程）。
   - **2026-09-14 又犯一次（用户第二次为同一件事发火）**：我用后台 job 查构建结果时带了 `wait: true`（`job_output(job_id, { wait: true, timeout_ms: 600000 })`）——**这就是阻塞**，跟 `gh run watch`、跟轮询没区别。**凡是要"等 CI/Release 跑完才能继续"的取值/确认动作，一律不许放在回合里**：后台 job 自己跑它的（它完成时系统会通知我），我该干活就干活、该收尾就收尾，最多在用户问起时**单次**查一次 `gh run list` / `gh release view`。判断标准很简单：**这一步会让我的回合停在"等外部流程"上 → 不许做**。
10. **自动更新的签名密钥不许动**：`tauri.conf.json` 里已有 `plugins.updater.pubkey`，所以任何 `tauri build`（含 main 的 CI）**必须**能拿到私钥——仓库 Secrets 的 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` **删了就构建不了，换了就再也发不出更新**（老用户装了带旧 pubkey 的版本，只认旧私钥签的包，换钥匙只能让他们手动重装）。本地打包同理（`TAURI_SIGNING_PRIVATE_KEY_PATH`）。
11. **发版权在用户手里：不许自行开新版本（2026-09-14 用户原话「等我说过了才能开新版本」）**。改版本号三处、更新 CHANGELOG 的版本段、打 tag、建/发 Release —— **这四件事都只在用户明确说"发 X.Y.Z"之后才做**；"这版攒了几个修复，我觉得该发了"**不是**可以自己动手的理由。他可能想先自己跑一跑、想攒更多改动、或想换个版本号。（红线 9 那条"草稿好了直接 Publish"只覆盖**他已经决定要发的这个版本**的 Publish 动作，不等于我可以决定要不要发。）拿不准时**问一句**（"要不要我现在发 0.7.6？"），比先斩后奏强。

**已知未决 / 可做**（都不是 bug，是留给接手人的选择）

- `scripts/` 里 5 个 wasm 时代的死脚本（`debug-math*.mjs`、`debug-svg.mjs`、`debug-fontinfo.mjs`、`verify-sanitize.mjs`）依赖已移除的 `@myriaddreamin/typst.ts`，跑不起来也没人引用 —— 可以删。
- 浏览器开发模式（`?browserdev=1`）的编译是**假实现**（内存里的假文件系统 + 假 SVG）。想在浏览器里看真实排版走 `fixtures:math` 夹具链路；**真保存 / 导出 PDF / 系统对话框必须桌面版**。
- 编辑器界面字体走系统字体栈（无 `@font-face`），所以写作模式正文与 PDF 用的思源宋体**并不完全一致**（打包字体只喂给 typst 编译）。要一致就加 `@font-face`。
- `保存失败` / `打开失败` 的状态栏提示没带上 Rust 侧的具体原因（如 `仅支持 .typ 文件`、`目录无效`），可补。
- 设置弹窗的「启动时恢复上次内容」默认开（用户当时的选择）；若不想让新用户被上次内容打扰，可改默认或加提示。
- 没有 git tag 之外的发布脚本；发版本流程见「CI / 发布约定」末尾。
- **自动更新只覆盖 Windows**：CI 只构建 Windows 安装包，`latest.json` 里也只有 `windows-x86_64`。要上 macOS/Linux 得先补构建 job，并给 `+page.svelte` 的安装成功分支接 `tauri-plugin-process` 的 `relaunch()`（Windows 上 NSIS 装完会自己把应用拉起来，无需 relaunch，所以现在没引这个插件）。
- 更新检查没有"忽略这个版本"（用户点「稍后」只是关掉弹窗，下次启动仍会提示）；要加的话得再存一个 `skippedVersion`。

**和这位用户协作的偏好（上一轮的实测经验）**

- 他会**自己跑桌面版**验证（WSL 里 `npm run tauri dev`），反馈通常是一句话现象或一张截图；**先复现、再改**——这一轮 5 个 bug 里有 4 个是靠"复现 + 抓异常原文"定位的（Chromium 里复现不出来时，就加防御性兜底 + 让错误可见，别硬猜）。
- **他不喜欢等慢测试**：日常改动跑 `npm run check` + 相关单测（几秒级）就够；`scripts/browser-check/` 那套（约 1 分钟）只在改到编辑器/装饰/布局这类易回归的地方才跑，而且不必每次都盯着结果等它绿。
- **绝不阻塞等 GitHub workflow（2026-09-14 连着强调三次，原文见红线 9）**：推 main、打 tag、接着做下一步，都**不要**等 CI / Release 跑完，也**不要**挂"等 run 结束再执行"的后台轮询任务。该做的动作直接做完，报告状态时最多**查一次** `gh run list`（单次查询可以，轮询不行）。
  - 连带效果（他知道并接受）：`ci.yml` 的 concurrency 会 **cancel 掉 main 上正在跑的 run**，被 cancel 的 run 不保存 rust-cache（红线 8 说的缓存代价仍在）。所以"推 main 可能打断正在跑的构建"**不再是推迟推送的理由**——但他要的是"别为了等 workflow 停手"，不是"鼓励反复 cancel"：能一次推完的提交就一次推完。
- **发版两步要分清（2026-09-14 他先后说了两句，别只记前半句）**：① **要不要发、发哪个版本号，由他说**（「等我说过了才能开新版本」——我自行把 0.7.5 发出去那次他很不满）；② 一旦他说了要发，**草稿 Release 一建好就直接 Publish，不用再问**（「草稿 Release 好了直接 Publish」，理由是草稿资产客户端拿不到、自动更新等于没上线）。
- **"不要阻塞"包括一切"等外部流程"的等待（2026-09-14 他为同一件事第二次发火）**：不光是别写轮询循环，`job_output(wait: true)` 等 CI/Release、`gh run watch`、"等构建完再看结果"都不行。后台 job 就让它自己在后台跑，我继续干别的；**不许让回合停在等 workflow 上**。
- **他要的是"能直推 main"（2026-09-14）**：转公开后 ruleset 逼着走 PR，他选了「只保留禁 force push / 禁删分支」——**保留保护意图，但不要给日常推送加流程**。所以：发现推送被规则拦住时，先问一句"是要放宽规则还是走 PR"，别默认改成 PR 工作流，也别偷偷绕。
- **他的机器上有他自己的东西：清理现场时只动自己创建的对象**（2026-09-14：我用 `taskkill /IM chrome.exe /F` 收尾，把他在 Windows 上开着的所有 Chrome 窗口一起杀了，他立刻发火）。收尾只杀自己启动的进程（记 PID），只删自己建的文件，别碰用户正在用的程序、窗口、端口与编辑器会话。
- **重大外部动作先问一句、机械动作别问**：仓库从私有转公开、放宽分支规则这类**不可逆或改仓库设置**的事他都希望先确认（他两次都选了推荐的稳妥项）；而"打完 tag 后把草稿 Publish""删掉临时文件"这类**由既有约定覆盖**的动作直接做，不要回来问。
- 明确的产品偏好：仿 Typora 的观感（**不要工具条**、菜单 + 快捷键）；"不要改变当前编辑位置"（Alt/菜单不许夺焦）；界面不要出现多余色块与凸出（选区底色要对齐文字列）。

**最近的提交脉络**（想知道某处改动从哪来的，按这个顺序 `git show`）

| 提交 | 内容 |
| --- | --- |
| `fc3ef56` | 所见即所得（编辑器内联渲染）落地 |
| `aa6674f` | 仿 Typora 两套 UI（写作/源码）+ 公式显示修复 → 0.7.0 |
| `816b16a` | 字体目录搬出 `static/`（安装包瘦 3.5MB） |
| `88b258b` / `4efe8bd` | 切换模式丢未保存内容的修复 / 启动恢复上次内容 → 0.7.1 |
| `38a5c98` | Alt 激活菜单不再夺走编辑区焦点 |
| `1f4c5e0` | 装饰/widget 异常兜底 + 脚本错误上报到状态栏 |
| `701e722` | 空正文标记构造崩溃的根因修复（`==` 时所有标题被展开） |
| `ec0bd2e` | 整行选区底色不再比文字列凸出（阅读边距改挂 scroller） |
| `424d3f6` | 版本号 0.7.2 |
| `cf364f6` | 自动更新（tauri-plugin-updater）：静默检查 + 弹窗确认下载安装 + `latest.json` 发版链路（**引入签名密钥约束**，见红线 10） |
| `a43bcad` | 版本号 0.7.2 → 0.7.3（首个带自动更新的版本） |
| `68c8df7` / `adab021` | Ctrl+滚轮调整分栏比例（`pane-ratio.ts` + 第 24 组验收）；`adab021` 是修正：手势原写成 Ctrl+Shift+滚轮，**头less 全绿但真机没反应**（Shift 把纵向滚动转成横向），改成 Ctrl+滚轮并同时读 deltaY/deltaX。0.7.4 的内容 |
| `f2d6e17` | 正文字体 / 额外字体目录设置 + 中文回退修复（**上一轮会话遗留的未提交改动**，本轮原样收进一个独立提交；要回退 revert 它即可） |
| `400be1f` | **Ctrl+滚轮 改成缩放整个界面**（`zoom.ts` + webview `setZoom`；第 24 组验收重写为缩放，92 项）。上一轮理解错了需求：做成了"改分栏宽度"（`68c8df7`/`adab021`），而用户要的是「字太小 → 字变大」，`pane-ratio.ts` 随之删除 |
| `1e9f6e4` | 更新失败文案先点明「仓库还是私有」（当时确实是真因），并纠正 CLAUDE.md 里把它误判成网络过滤的记载 |
| `fd271f7` | PR #59（squash）：仓库转公开后把文案成因排序改成「草稿没 Publish」领头，记下转公开的原因与匿名可达性验证命令。**这一笔之所以走 PR，是因为转公开让仓库上那条 ruleset「protect main」第一次真正生效**（见「CI / 发布约定」） |
| `afa9112` | 版本号 0.7.3 → 0.7.4 + CHANGELOG（界面缩放 / 正文字体 / 仓库转公开使自动更新首次可用）。tag `v0.7.4` |
| `778cad3` | 两条红线：`job_output(wait: true)` 等 CI/Release 也算"阻塞"；**不许自行开新版本**（用户原话「等我说过了才能开新版本」——我自行发了 0.7.5 那次他不满） |
| `7904fb7` | 大缩放下状态栏不再折行（nowrap + 单行省略号；`:not(.spacer)` 别漏）+ 引擎的 `ResizeObserver loop` 提示不再报成脚本错误（`BENIGN_SCRIPT_ERRORS` 过滤 + 重算推到 rAF） |
| `3fe8a3d` | **公式下标不再被 SVG 视口裁掉**：typst 把上下标画到帧外，贴边页的视口就是裁剪框 → `ink_bounds_of_frame` 量墨迹（字形包围盒）后撑画布；视觉验收第 4 组对全部真实产物做 `getBBox()` 几何体检 |
| `66645b2` | 版本号 0.7.5 → 0.7.6（三处 + Cargo.lock）。tag `v0.7.6` |

**文档地图**

| 想了解 | 看哪节 |
| --- | --- |
| 整体架构与模块清单 | 架构（含配置与辅助目录） |
| 编译链路 / 诊断 / 导出 PDF | 编译数据流（核心链路） |
| 所见即所得怎么实现、有哪些坑 | 所见即所得（编辑器内联渲染）数据流 |
| 自动更新怎么工作、密钥怎么管、发版要注意什么 | 自动更新（tauri-plugin-updater）数据流、CI / 发布约定 |
| 字体从哪来、为什么不放 static | 字体、原生编译后端 |
| 文件操作与路径安全 | 文件操作与路径安全 |
| 启动耗时的观测方式 | 启动耗时观测 |
| 怎么跑验收、验收到什么程度 | 测试 |
| 怎么发版、缓存怎么坏、怎么修 | CI / 发布约定 |
| 本机 WSL 特有的坑（端口、SSH、headless Chrome） | 环境备忘（本机 WSL） |

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 仅前端 UI（无预览/文件功能；非 Tauri 环境显示"请使用桌面应用版本"提示页）
npm run tauri dev    # 桌面应用（需 Rust；Vite 固定端口 1420）
npm run check        # 类型检查（svelte-kit sync + svelte-check）
npm test             # 单元测试（vitest + jsdom：src/**/*.test.ts + scripts/**/*.test.mjs）
npm test -- src/lib/typst-engine.test.ts   # 跑单个测试文件
npm run build        # 前端生产构建（输出 build/）
npm run tauri build  # 打包桌面安装程序（需 Rust；**需要更新签名私钥**，见"CI / 发布约定"）
cargo check --manifest-path src-tauri/Cargo.toml   # 只查 Rust 壳
cargo test --manifest-path src-tauri/Cargo.toml    # Rust 单测（typst_world/packages：编译/字体/诊断/include/包解析下载）
node scripts/check-fonts.mjs    # 校验 src-tauri/fonts 字体有效性
node scripts/generate-latest-json.mjs --tag v0.8.0 --out latest.json   # 生成更新清单（发版用，CI 里自动跑）
npm run fixtures:math           # 导出真实公式产物到 .browser-check/（浏览器视觉验证用）
BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg.mjs   # 浏览器交互验收（另起 `npm run dev -- --port 1425`）
```

## 架构

```
src/routes/+page.svelte     # 唯一页面：全部状态与调度中枢（菜单/文件/编译/持久化/快捷键）
src/lib/Editor.svelte       # CodeMirror 6 封装：受控 doc、主题 Compartment、诊断波浪线、所见即所得接线
src/lib/typst-lex.ts        # 源码区域扫描：markup / code / raw / comment / string（标记识别的前提，纯函数）
src/lib/math-ranges.ts      # 公式范围扫描（$...$ / $ ... $）+ 缓存键 + 选区相交判定（纯函数）
src/lib/math-context.ts     # 公式编译上下文：前缀 + 文档内单行顶层 #let 定义（纯函数）
src/lib/markup-ranges.ts    # 常用标记拆解（标题/粗体/斜体/行内代码/围栏代码块/列表符号/链接 → 标记 + 正文/块级范围，纯函数）
src/lib/live-preview.ts     # 所见即所得 CM6 扩展：公式 replace widget + 标记隐藏 + 选区进出展开 + 渲染请求
src/lib/typst-engine.ts     # 编译引擎：Tauri invoke 包装（compile_doc/compile_math/export_pdf）+ 结构化诊断
src/lib/file-ops.ts         # Tauri dialog + invoke 封装（isTauri() 门控）
src/lib/persistence.ts      # localStorage（key: "typst-pad:state"）
src/lib/MenuBar.svelte      # 菜单栏（Alt 激活 + 字母快捷键；**不夺编辑区焦点**，见下方「菜单不夺焦」）
src/lib/pdf-export.ts       # PDF 导出文件名推导（文档标题 → "报告.pdf"，纯函数可单测）
src/lib/svg-paginate.ts     # 多页 SVG 页间分隔线（类名固定 page-separator，可单测）
src/lib/diagnostics-utils.ts # 编译源位置 → 文档位置映射（mapCompiledPosToDoc）与波浪线区间（squiggleRanges）
src/lib/doc-utils.ts        # 文档纯函数：isEffectiveDirty（空文档视为未修改）、ensureTrailingNewline（前缀末行补换行）
src/lib/startup-timing.ts   # 启动打点：首次编译完成后输出 [startup] 报告（见"启动耗时观测"）
src/lib/write-commands.ts   # 写作模式格式命令的纯逻辑：planForCommand → EditPlan（不碰 CodeMirror，可单测）
src/lib/error-list.ts       # 编译错误列表数据组装 + 前缀行定位（纯函数）
src/lib/preview-scale.ts    # 预览画布等宽缩放：pt → px（1pt = 4/3px），字号对齐编辑区
src/lib/zoom.ts             # 界面缩放纯逻辑：Ctrl+滚轮的档距 / 方向 / 上下限收敛 / 浮点圆整 / 横向位移退回（可单测）
src/lib/context-menu-utils.ts # 右键菜单纯逻辑：区域判定 / 菜单项 enabled / 弹出位置收边
src/lib/ContextMenu.svelte  # 自定义右键菜单 UI（命令映射在 +page.svelte）
src/lib/menu-keys.ts        # 菜单栏按键决策纯函数（Alt / accessKey / Ctrl+单键快捷键匹配）
src/lib/updater.ts          # 自动更新包装层：check → 可判别结果、下载进度事件流、句柄释放（只包 Tauri）
src/lib/update-utils.ts     # 自动更新纯逻辑：检查节流 / 进度换算 / 字节格式化 / 错误文案（可单测）
src/lib/update-notes.ts     # 更新说明的 Markdown 渲染（受控子集 → 安全 HTML，先整体转义再生成标签；可单测）
src/lib/debug.ts            # 调试日志通道 dbg（dev 默认开；--debug / ?debug=1 / localStorage 可开）
src/lib/browser-dev-stub.ts # 浏览器开发桩：假 __TAURI_INTERNALS__ + 假编译，供 ?browserdev=1 用（仅开发）
src/routes/+layout.ts       # SPA 模式（ssr = false），配合 adapter-static 的 index.html fallback
src-tauri/src/lib.rs        # Rust 壳：read/write/write_binary/list_dir_typ/take_pending_files/compile_doc/compile_math/export_pdf 命令 + opener/dialog 插件
src-tauri/src/packages.rs   # 包系统：@local 本地包读取 / @preview 自动下载缓存（目录规范与 CLI 一致 + 安全解压）
src-tauri/src/typst_world.rs # 内嵌编译世界：字体加载（FontBook）/ 相对 include 磁盘解析 / 包解析接线 / 诊断转换（SVG/PDF）
src-tauri/src/main.rs       # 桌面入口（调用 lib.rs 的 run）
src-tauri/fonts/            # 打包字体（见"字体"：**不放 static/**）
```

配置与辅助目录：
- `vite.config.js`：SvelteKit + wasm 插件 + **dev 白屏修复三件套**（见"原生编译后端"末尾，勿动）；Tauri 开发用 `TAURI_DEV_HOST`。
- `vitest.config.ts`：jsdom + `include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"]` + `server.fs.allow: [".."]`（scripts 那条是发布脚本的测试：脚本是普通 JS + node 内置模块，不参与 svelte-check，见"测试"）。
- `svelte.config.js`：`@sveltejs/adapter-static`（SPA，`fallback: index.html`）。
- `.github/workflows/`：`ci.yml`（test + build-bundles）、`release.yml`（tag 发草稿 Release），约定见"CI / 发布约定"。
- `scripts/`：`check-fonts.mjs`（字体魔数校验）、`download-fonts.mjs`（重新下载字体）、`browser-check/`（CDP 验收）、`install-vs-buildtools.bat`/`verify-app.bat`（Windows 辅助）。
  **历史遗留（wasm 时代，依赖已移除的 `@myriaddreamin/typst.ts`，跑不起来、也无人引用）**：`debug-math*.mjs`、`debug-svg.mjs`、`debug-fontinfo.mjs`、`verify-sanitize.mjs`。
- `docs/`：`WYSIWYG-调研.md`（所见即所得的方案调研）；`CHANGELOG.md` 按 Keep a Changelog 维护；`.browser-check/` 为验收产物（已 gitignore）。

### 编译数据流（核心链路）

`+page.svelte` 监听内容变化 → `scheduleCompile()` **立即**编译（无防抖）→ `runCompile` 拼接编译源（`ensureTrailingNewline(prefixCode) + doc`，前缀末行自动补换行）→ `compileToSvg(source, filePath)` invoke `compile_doc { src, documentPath }`（`documentPath` = 已保存文档绝对路径 / null = 未保存）→ Rust 侧在 `spawn_blocking` 中编译（命令层互斥锁串行化，typst 引擎进程内一次一个）→ 返回结构化 `CompileOutput { ok, pages, diagnostics, warnings }`（serde `rename_all = "camelCase"`）。

前端用 `compileSeq` 代次令牌：每次编译前自增并记录 `mySeq`，结果返回时若 `mySeq !== compileSeq` 则**丢弃过期结果**。成功：`previewHost.innerHTML = composePages(pages)`（页间 `page-separator` 分隔线）；失败：**保留最后一次成功预览**（不隐藏不报错面板），`errorLocations` 转成编辑器红色波浪线，状态栏显示错误个数。invoke/IPC 异常也收敛为错误结果（`errors` 为空，`error` 带原始消息）。首次编译完成触发一次 `reportStartup()`。

PDF 导出链路：`pdf-export.ts` 由文档标题推导文件名（"报告.pdf"）→ 前端弹原生"另存为"对话框 → `compileToPdf` invoke `export_pdf { src, documentPath, targetPath }`，Rust 侧编译 PDF 字节直接落盘（走 `validate_write_path`）。

**诊断为 Rust 侧结构化对象**（`{ message, severity, line, column, endLine, endColumn, path }`，1-based 行列，`end` 为独占终点；`path` 空/缺失 = 主文档，include 文件给出其路径）——**不再有前端 range 字符串解析**（旧 `parseDiagnosticRange` 已随 wasm 编译移除）。`diagnostics-utils.ts` 现在的职责：编译源（前缀+文档）位置 → 用户文档位置映射（`mapCompiledPosToDoc`，前缀区错误跳过）与波浪线区间计算（`squiggleRanges`）。

### 所见即所得（编辑器内联渲染）数据流

形态 = Typora / Obsidian Live Preview：**源码仍是唯一真相**，编辑器在非选区处把可渲染范围换成渲染结果，光标/选区进入即展开源码。

- **范围识别**：`typst-lex.ts` 先把文档切成 markup / code / raw / comment / string 区域（`#let a = b*c*d`、`#let s = "$5"`、`// $x$`、`` `$x$` `` 都不参与标记识别；代码里成对 `[...]` 是内容块，内部回到 markup）；`math-ranges.ts` 在 markup 区里认 `$...$`（内侧两侧空白 = 行间公式），`markup-ranges.ts` 拆标题/粗斜体/行内代码/列表符号/链接。**保守优先：宁可漏渲染，不可误渲染。**
- **公式渲染**：`live-preview.ts` 视口内出现未缓存公式 → `onRequest` 回调父组件（`+page.svelte`）→ 去重 + 120ms 防抖 → `compileMath()` invoke **`compile_math { body, display, context, documentPath }`**（与 compile_doc 共用命令层互斥锁，一次一个）→ 结果进 `mathCache`（键 = 风格 + 前缀 + 公式文本，前缀参与键）→ `mathVersion++` → 编辑器 dispatch `refreshLivePreview` 重整装饰。
- **渲染契约（`MathOutput`）**：`{ ok, svg, widthPt, heightPt, baselinePt, error }`。svg 是**贴边**（`#set page(width/height: auto, margin: 0pt)`）且**透明底**（`fill: none`）的单页 SVG；尺寸单位 pt。**基线**用「两页探针」测得：`page.frame.baseline()` 实测返回盒底（`has_baseline=false`），故第 2 页放同一公式 + 一个挂在基线下 100pt 的零宽盒，页高 = ascent + 100pt → `ascent = H2 - 100`；外层 `#box(...)` 不可省（行间公式不加盒时探针会另起段落，实测 ascent 由 11.75pt 变 31.67pt）。
- **画布必须按「墨迹」而不是帧尺寸裁**（2026-09-14 用户反馈「`a_0 = 0` 的下半部分没有渲染」）：typst 允许把上下标画到**帧外**，帧尺寸只是"排版尺寸"——实测 `$a_0$` 帧高 8.196pt（基线就在帧底），下标基线在 **11.16pt**，比帧底低 2.96pt。我们的公式页是 `height: auto` 的**贴边页**，导出 SVG 后**视口就是裁剪框**，帧外的墨迹（下标的下半截、上标的顶部、`y`/`g` 的降部）全被裁。`compile_math` 现在先量**墨迹包围盒**（`ink_bounds_of_frame`：递归 group 的仿射变换、文本用**字形包围盒** `FontInstance::edges(…, TextEdgeBounds::Glyph(gid))`、图形用 `Shape::bbox(true)`），溢出时用「显式页面尺寸 + `#pad(top:)`」重编一遍，把内容整体挪进画布（**只有溢出才走第二遍**）。两条注意：① 字形墨迹要用 `edges` 而不是字体度量（度量的 descender 比 Libertinus 的 `y` 尾巴浅约 1pt，用度量还会再裁一次）；② 在 `#pad(top: …)` 这类**代码模式**的参数里不能再写 `#box(...)`，要写成 `#pad(top: …)[#box(...)]`（否则报 "the character `#` is not valid in code"，实测踩过）。验收在**视觉**那一套（第 4 组，`getBBox()` vs `viewBox`，对全部真实产物做一次性几何体检）。
- **字号**：`MATH_TEXT_PT = 10.5`（Rust）/ 编辑器正文 14px = 10.5pt，故 SVG 的 pt 与编辑器 CSS 的 pt **1:1**，前端直接写 `width/height: Npt` + `vertical-align: -(height-baseline)pt`。改字号要两侧同步。
- **暗色主题**：typst 产物是黑字透明底，暗色下看不见 → widget 带 `cm-math-dark` 类整体 `filter: invert(1)`。**不要用 `&dark` 选择器**：`EditorView.theme` 不支持该前缀（实测抛 `RangeError: Unsupported selector: &dark`，SvelteKit 会整页渲染成 500 错误页，表现为"应用没渲染"）。
- **展开规则**：`selectionTouchesRange`（光标落在区间内含两端即展开，非空选区相交即展开）。标记类构造的展开范围必须是**标记 + 正文的并集**——标题/列表只有前导标记，只取标记范围会导致光标落在正文里时 `= ` 不露出（实测踩过）。
- **块级 widget**：**独占整行**的行间公式（`$ ... $`，含跨行书写）整行替换为居中的块级 widget（`blockRangeFor` 判定"前后只有空白"）；```` ``` ```` 围栏代码块同样整段替换为等宽代码块 widget（`rawBlockFor`：围栏必须独占整行，代码按 typst 语义剔除公共缩进；纯文本展示，不需要编译）；与文字同行的 `$ x $` 仍走行内 widget（整行替换会把旁边正文一起盖掉）。块级/跨行替换**只能由 StateField 提供**——ViewPlugin 提供会抛 `Block decorations may not be specified via plugins`（实测确认：CM6 只对"函数型"动态装饰置 disallow 标记）。
- **公式编译上下文**：`math-context.ts` 把「前缀」与「文档内**单行顶层** `#let` 定义」拼成 context（多行语句、含 `[...]` 内容块的语句、`=` 后无值的半截语句一律跳过——后者若拼进去会让所有公式一起编译失败）。同名定义保留最后一次。文档定义本身有错/与前缀重名 → 父组件退回「仅前缀」重试一次。
- **性能（三处热点，都已被实测锁住，勿回退）**：
  1. `scanNonMarkupRegions` 带**单条记忆化**：编辑器一次更新里它会被用三处（StateField 装饰重建、ViewPlugin 请求收集、`buildMathContext` 的 `#let` 提取）。加缓存前 40k 字符文档每次按键要扫三遍；返回的数组被 `Object.freeze`，调用方只读。
  2. `markup-ranges` 的"是否与公式/代码区相交"判定用**二分**（`overlapsSorted`），不是 `some(...)` 线性扫描——区域表上千条时线性是 O(候选 × 区域)，实测一次重建 47ms，改二分后 2.6ms。
  3. 编译上下文在**扩展内部**算（`prefix` 选项 + 当前 doc），不要挪回页面做 `$derived`：那会让每次按键多一遍全文档扫描。
  合计：40k 字符文档一次更新 6.4ms（4k 字符 ~1.5ms）。
- **两套 UI（仿 Typora）**：`viewMode: "write" | "source"`（取代旧的 `livePreview` 布尔，旧存档自动迁移）。
  - **写作模式**（默认，单栏）：灰底 + 居中纸张（`.panes.single .editor-pane .pane-body` 上用 `--bg-backdrop`/`--bg-paper`）、衬线正文（Noto Serif CJK SC，与预览/PDF 输出同字体）、16px/行距 1.9、**隐藏行号槽**与当前行高亮（都在 `Editor.svelte` 的 `.editor-host.write` 样式里）、状态栏显示「写作」且不显示行列。公式/标记就地排版。
    - **字体必须写在 `.cm-content` 上**：CodeMirror 基础主题给 `.cm-content` 自己钉了 `font-family: monospace`，只改 `.cm-editor` 不生效（实测：写作模式正文仍是等宽）。
    - **暗色下必须照常挂 oneDark**：CM6 基础主题自带**白底黑字**；若写作模式不挂主题，编辑器仍是白底，而公式 widget 已被 `filter: invert(1)` 反成白色 → **白底白字，公式"消失"**（实测被反馈的就是这个）。主题变量 `--bg-paper` 同时给 `.cm-editor/.cm-scroller/.cm-gutters`，避免深色纸与编辑器底色两块色。
    - **公式字号必须等于正文字号**：写作模式 16px → `MATH_SIZE_PT = 12`（`typst-engine.ts`），随 `compile_math` 的 `size_pt` 参数传给 Rust（缺省 10.5pt = 源码模式 14px）。字号参与缓存键。曾经写死 10.5pt，写作模式下公式比正文小一圈（实测被反馈）。
  - **源代码模式**（`Ctrl+/`，双栏）：等宽 14px + 行号 + oneDark（暗），右侧整页预览；此模式下 live-preview 整体关闭（看到的是真正的 Typst 源码）。
  - **界面缩放（Ctrl+滚轮）**：整个界面等比放大/缩小（**不是**分栏宽度——用户反馈「字太小看不清」要的是字变大；分栏宽度那套手势已移除）。范围 **50%~250%**、一次一格 10%，默认 100%。纯逻辑在 `zoom.ts`（可单测），页面侧是 `handleZoomWheel`/`setUiZoom`/`applyUiZoom`，**走 Tauri 的 webview 缩放 `setZoom`**（权限 `core:webview:allow-set-webview-zoom`）。
    - **为什么不用 CSS `zoom`**：webview 缩放不改 CSS 像素、由引擎等比放大，所以 CodeMirror 的行高测量（`getBoundingClientRect`）与 SVG 预览的尺寸计算全部继续正确；换成 CSS `zoom` 会让「设置的 px」与「量到的 px」单位错位，CM6 会算错行高与滚动高度。
    - **监听挂在 `window` 的捕获阶段**（`onMount` 里 `addEventListener("wheel", …, { capture: true, passive: false })`）：① 鼠标在菜单栏/状态栏上滚也能缩放（以前只有 `.panes` 那一块有效）；② 捕获阶段早于编辑器/预览区自己的滚动处理。**`passive: false` 不可省**——window 上的 wheel 监听默认被当被动监听，`preventDefault` 会失效。
    - **调档后要"再确认一次"**（2026-09-14 实机反馈「放大根本没用，缩小有用」）：WebView2 在 Ctrl+滚轮这类手势进行中/结束时可能用自己那套处理把宿主设的 `ZoomFactor` 还原回手势开始时的值（WebView2Feedback #1022），手势里立刻 `setZoom` 会被抹掉。所以每次调档 = 立刻设一次 + 约 250ms 无新滚轮事件后再设一遍同一个系数（`ZOOM_CONFIRM_DELAY_MS`）；值没被抹掉时是空操作。**现象只在真机（WebView2）上出现，Chromium 里两个方向都正常——别指望无头验收能复现这类问题。**
    - **引擎不接受的档位不许记进状态**（2026-09-14 两轮实机反馈「放大根本没用，缩小有用」→「最大后无法用滚轮缩小」是**同一个机制**：引擎没接受放大，而 `uiZoom` 照旧涨到上限 250%，于是从 250% 往下滚要滚十几档才有反应，看着就是「缩小也坏了」）。`verifyZoomApplied` 的做法：① 首次应用缩放前 `ensureZoomCalibration` 校准 100% 基线（先设 100% 再读 dpr，顺带排掉 WebView2 记住上次站点缩放的干扰）；② 每次调档（含"再确认一次"那一拍）后读 `devicePixelRatio ÷ 基线` 得到**引擎实际接受的档位**（Chromium 的 dpr = 显示器缩放 × 页面缩放）；③ 与请求值不一致就把 `uiZoom` **拉回引擎给的档位**，状态栏写明「界面缩放未生效：引擎把 120% 限制在 100%」。放大被拒时档位原地不动、界面与状态一致，缩小立刻有效；`uiZoom` 被赋值会再触发一次 `$effect`，但那时 `applied == target` 会直接返回，不会循环。
    - **复核必须 fail-open**（这是本仓库对"不能复现的真机问题"的通用态度：兜底可以激进，判断必须保守）：① 首次发现「请求了缩放但 dpr 不动」时，先用 **50% 档反证**一次 dpr 到底跟不跟随缩放——跟随才继续复核，否则本次会话整体关掉复核（**绝不拿不可信的读数去改用户状态**）；② 校准失败 / 读不到 dpr 就完全不复核。
    - **桩与验收怎么覆盖这条**：浏览器开发桩的 `setZoom` 没有真实副作用，桩在 `app.html` 里挂 `window.__browserDevStub = { fakeZoom: true }`，页面据此跳过复核——**用标记而不是 import 桩**（import 会把 dev-only 的桩打进生产包）。验收要真跑这条逻辑时用 `?browserdev=1&zoomsim=1`：桩给 `window.devicePixelRatio` 装假 getter（dpr = 1.25 × 引擎接受的缩放），于是 `setZoom` 有了真副作用；再加 `&zoomcap=1` 就得到「放大一律按 100% 处理」的那台真机（第 27 组）。
    - **别想把 CSS `zoom` 换上来**（2026-09-14 实测过一次）：在 `<html>` 上打 `zoom: 1.5` 后 `document.documentElement.scrollHeight` 从 802 变 1203（`height: 100%` 被一起放大）、状态栏被推到视口下方 401px；而且 `getBoundingClientRect()` 返回**放大后**的 px 而 `window.innerWidth` 仍是**未放大**的 px——两套单位混用会打烂右键菜单/popover 的定位（`computeMenuPosition` 就是拿 rect 和 innerWidth 一起算的）。webview 缩放发生在 CSS 层之下，这些单位都不动，这才是选它的真正理由。
    - **状态栏在大缩放下不许折行**（2026-09-14 用户截图反馈「放大到 190% 之后界面像烂了」）：状态栏是 flex 行，视口变窄（= 缩放变大）时每个 `<span>` 都会被压缩并各自折行 —— 一条长报错 + 右侧一堆标签就能把 27px 的状态栏顶成 40px+ 的竖排文字块。现在：状态栏 `flex-wrap: nowrap`；**左侧第一个 span**（状态文字）`flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis`；**其余 span**（徽标/标签/计数）`flex: none; white-space: nowrap`。注意选择器要写成 `.statusbar > span:not(:first-child):not(.spacer)` —— 漏掉 `:not(.spacer)` 会因为优先级更高把撑开右侧的 spacer 压没。验收第 28 组用 CDP 的 `Emulation.setDeviceMetricsOverride` 压视口来锁这条。
    - **Chromium 自己的 `ResizeObserver loop completed with undelivered notifications.` 不算脚本错误**：那是引擎在"RO 回调里改了布局、同一帧又要再触发"时发的提示（规范允许、只会把通知推迟到下一帧），而预览画布正好是"量宽度 → 设宽度"的模式，缩放/改分栏时会偶发。以前它会被报成状态栏的「脚本错误：…」，用户以为应用坏了（实测被反馈）。现在 `reportScriptError` 里用 `BENIGN_SCRIPT_ERRORS` 过滤掉（只写 dbg 日志），并且把 RO 回调里的重算推到 `requestAnimationFrame`（`previewScaleFrame` 去重），从源头减少它出现。
    - **手势必须是无 Shift 的 Ctrl+滚轮**，且**命中时必须 `preventDefault()`**（否则这次滚动会继续滚动编辑器，WebView2 还会用它自己那套系数缩放页面，两套系数打架）。位移量**同时读 `deltaY` 与 `deltaX`**：按着 Shift 滚轮时 Chromium 把纵向滚动转成横向（`deltaY = 0`、`deltaX` 有值）——最初写成 Ctrl+Shift+滚轮时，头less 验收用 CDP 注入 `deltaY` 全绿、**真机上却完全没反应**，就是栽在这里。
    - 滚轮「一格」的判定分三种 deltaMode（像素/行/页），像素模式按 ≈100 折算并在 `< 50` 时视为触摸板小步长（下限 0.2 档）——否则触摸板一划就窜到顶；单次事件最多 3 档。
    - 缩放**持久化**（`uiZoom`）并在启动时重新应用（`$effect` → `applyUiZoom` → `setZoom`）；到上下限后继续滚只提示不变化；非 100% 时状态栏右侧常驻一个「缩放 xx%」徽标；视图菜单有「放大 / 缩小 / 重置缩放」（菜单项右侧灰字写的就是「Ctrl+滚轮」，`shortcut` 字段在这里只当提示用，MenuBar 匹配器不会命中它）。
    - 桌面版若发现 Ctrl+滚轮仍触发页面缩放（我们已 preventDefault，正常不会），可在 `DisableBrowserAccelerators`（lib.rs）里补关 `IsZoomControlEnabled`——**那是 Windows-only 代码，本机 Linux 编不到也验不了**。
  - **格式操作走菜单 + 快捷键，不做工具条**（Typora 没有工具条）。纯逻辑在 `write-commands.ts`（`planForCommand` → `EditPlan`），编辑器侧只有一个 `runWriteCommand` 把它们落成事务。**块级命令的选区语义**：无选区 → 替换光标所在行（该行内容成为块内容，不丢字）；有选区 → 只替换选区。**包装命令把选区首尾空白留在定界符外侧**：`*文字\n*` 在 Typst 里是跨行强调、我们自己的标记扫描也不识别 → 会退化成字面星号（实测：Ctrl+A 后按 Ctrl+B）。**引用必须用 `#quote(block: true)[...]`**——Typst 没有 Markdown 的 `>` 语法，写 `>` 只会留字面字符。
  - 快捷键分两处：无 Shift 的（Ctrl+B/I/K/1/2/3/0/M）放菜单项的 `shortcut` 由 MenuBar 统一匹配；**带 Shift 的**（Ctrl+Shift+` 行内代码、Ctrl+Shift+M 公式块、Ctrl+Shift+[ / ] 列、Ctrl+Shift+Q 引用、Ctrl+Shift+C 代码块）由 `+page.svelte` 的 window keydown 处理——MenuBar 的匹配器只支持「Ctrl+单键」，这是既有约定（见 menu-keys.ts）。
  - `showPreview` 与模式联动：写作模式单栏、源码模式双栏；预览栏隐藏时容器仍在 DOM（`display:none`），`compile_doc` 写入链路不受影响。
- **编辑器文档的受控契约（丢过内容，勿回退）**：`+page.svelte` 的 `doc`（页面状态）与 `editorDoc`（传给 `Editor` 的受控文档）是**实时镜像**——`handleDocChange` 里两个一起写，`initialDoc={editorDoc}`。原因：`editorDoc` 曾经只在打开/新建/重读时更新，是个陈旧镜像，一旦 Editor 重挂载（或 props 重新生效），旧值就被当成"外部文档"推回编辑器，把未保存的新输入覆盖成上次打开/保存的版本（用户反馈的"切换模式时未保存内容消失"）。Editor 侧另加**「同一外部值只推一次」守卫**（`appliedExternalDoc`）与替换日志（`dbg` 的 `editor` 通道）。**绝不能让 `editorDoc` 落后于编辑器内容。**
- **打开/重读的安全底线**：`openPath` 只要有未保存修改就确认（**同路径也不例外**——此前 `filePath !== path` 的豁免会让"把当前 .typ 拖进窗口"这类操作静默丢弃未保存修改）；`reloadFile`（Ctrl+R）同样确认。
- **菜单不夺焦（用户明确要求：「不要改变当前编辑位置」）**：Alt 激活菜单栏时**不再**让编辑区失焦——失焦会让光标消失、下一个非 accessKey 字母还会被菜单吃掉。菜单栏只依赖 window 上的 keydown（accessKey / 方向键 / Esc / Enter 都照常），不需要 DOM 焦点；只有「取消选中」一侧把焦点交回编辑器（鼠标点过菜单项后焦点落在按钮上，必须还回去，见 `handleMenuFocusChange`）。**别把 `el.blur()` 加回去。**
- **写作模式的左右阅读边距必须挂在 `.cm-scroller` 上，不能是 `.cm-content` 的 `padding`**（用户反馈「两边不应该凸出来」）：CodeMirror 画整行选区的底色时会把内容盒的**内边距一起铺满** → 一按 Ctrl+A 就是一条比文字列两侧各宽 48px 的色带。留白放 scroller：内容盒 == 文字列，高亮自然对齐。（`.pane-body` 只管白纸宽度 900px；文字列 804px 由 scroller 的 48px 内边距得到。）
- **回退**：渲染失败 / 未就绪 / 行内跨行公式 → 不挂 widget，保持源码显示（不出现空占位、不弹错误）。
- **空正文不能建 mark 装饰（真实 bug 的根因）**：`== `（标题标记刚敲下、文字还没写）、`**` 这类**正文长度为 0** 的构造会生成 `Decoration.mark().range(x, x)`，CM6 直接抛 `RangeError: Mark decorations may not be empty`。以前它冒泡进 `StateField.update` → 事务整体失败 → 编辑区**卡死**（用户报的「输入 `= 1 = 2` 后无法再打字/删除/换行」）；加了 try/catch 兜底后则表现为「输入 `==` 时所有标题都被展开成源码」（整套装饰被丢弃）。修法：`buildMarkupDecorations` 只在 `content.to > content.from` 时加样式装饰（标记隐藏那侧本来就有 `from >= to` 守卫）。`live-preview.test.ts` 有两条回归用例。
- **装饰/widget 的异常绝不允许冒泡进 CodeMirror 的事务**：StateField 的 `update` 或 widget 的 `toDOM` 一旦抛异常，这次事务整体失败 → 文档不再更新，表现为编辑区**卡死**。所以 `collect()` 整体包了 try/catch（失败即返回 `Decoration.none`，退化成源码显示），三个 widget 的 `toDOM` 也都包了 try/catch（失败退回纯文本 + `cm-widget-fallback` 类）。**改动 live-preview 时不要在 try 之外新增可能抛异常的代码；新增 `Decoration.*.range(a, b)` 前先确认 `b > a`。**
- **脚本错误可见**：`+page.svelte` 挂 `window.onerror` / `unhandledrejection` → 状态栏显示「脚本错误：…」+ 调试日志（桌面 WebView 没有可见控制台，否则用户只能看到"应用坏了"）。排查桌面版疑难杂症时先看状态栏这句话。
- **持久化**：`viewMode`（+ `showPreview`）与主题一起存 localStorage；旧的 `livePreview` 布尔自动迁移为 `viewMode`；视图菜单（`Ctrl+/`）切换。

### 自动更新（tauri-plugin-updater）数据流

形态 = 「静默检查 + 用户确认」（不自动下载、不偷偷重启）：启动后延迟约 4 秒检查一次，发现新版本就状态栏提示 + 弹窗询问，用户点「下载并安装」才下载；菜单「帮助 → 检查更新…」随时可手动检查，设置里可关掉自动检查。

- **配置在 `tauri.conf.json` 的 `plugins.updater`**：`endpoints`（默认 `https://github.com/Z3O1/Typst-pad/releases/latest/download/latest.json`）+ `pubkey`（签名公钥，**编译进应用**）+ `windows.installMode: passive`。Rust 侧只加一行 `.plugin(tauri_plugin_updater::Builder::new().build())`；前端权限 `updater:default` 在 `capabilities/default.json`。
- **清单（latest.json）**：静态 JSON 格式 `{ version, notes, pub_date, platforms: { "windows-x86_64": { url, signature } } }`。由 `scripts/generate-latest-json.mjs` 生成（Tauri CLI 不生成它，那是 tauri-action 的活，本仓库自己发 Release 所以自己生成）：从 `bundle/nsis/*-setup.exe.sig` 读签名、按 tag 拼下载 URL、`notes` 默认取 `CHANGELOG.md` 里该版本的正文。**优先 NSIS 而不是 MSI**（Windows 上 updater 默认走 NSIS，MSI 静默装要管理员）。
- **客户端取的是 `releases/latest/download/latest.json`** = 最新一个**已发布** Release 的资产 → **草稿 Release 不算**，必须 Publish 之后客户端才看得到（这是"发版要记得 Publish"的又一重后果）。平台键由插件自己算：`updater_os()` + `updater_arch()` → `windows-x86_64`（本仓库只发 Windows）。
- **签名校验**：安装包由 CI 用私钥签（`TAURI_SIGNING_PRIVATE_KEY`），客户端用 `pubkey` 校验（Rust 侧 `minisign`），签名不符直接拒绝安装——这是"更新通道被换包"的唯一防线。`pub_date` 客户端按 **RFC3339** 解析（`new Date().toISOString()` 正好合规）。
- **前端状态机（`+page.svelte` 的 `updateFlow`）**：`idle | checking | latest | available | downloading | installing | error` 七态**放在一个对象里**，状态栏提示（`updateNotice`，`$derived`）、弹窗内容、按钮都由它派生——不要拆成多个布尔量（会出"弹窗开着但状态 idle"这类自相矛盾的组合）。`updateHandle`（plugin 的 `Update`，持有 Rust 侧 rid）是**普通变量**（模板不渲染它），换版本前 `closeUpdate()` 释放。
- **失败反馈分两种**：手动检查失败 → 状态栏写明原因（`describeUpdateError` 把英文原文翻成"网络/清单没发出来/签名不符"这类可行动的话）；**自动检查失败保持安静**（只写 `dbg` 调试日志），否则网络一断每次启动都在状态栏刷红字。
- **节流**：`lastUpdateCheckAt` 持久化 + `isCheckDue`（默认 6 小时），反复开关应用不会反复请求；关掉设置里的「启动时自动检查更新」就完全不检查。
- **Windows 上 `downloadAndInstall` 成功后会退出应用**（NSIS 装完自己把应用拉起来），所以那个 promise 可能不返回——`{ ok: true }` 只代表"走到安装那步之前没报错"。
- **更新说明（notes）的渲染**：`notes` 是 `CHANGELOG.md` 该版本的 Markdown 正文，弹窗里由 `update-notes.ts` 渲染成**受控子集**的安全 HTML（先整体转义再只生成自己的标签）——**别再退回 `<pre>` 显示原文**（用户反馈过「更新说明无法渲染」，就是看到 `### Fixed`、`**粗体**` 的原文）。故意不支持斜体/链接/原始 HTML；长度硬上限 8KB（超了明说已截断）。
- **浏览器开发模式**：桩对 `plugin:updater|check` 返回 `null`（= 没有新版本，见 `browser-dev-stub.ts`），所以这条链路在浏览器验收里是安静走通的；**真实的下载/签名校验/装包只能在桌面版验证**。例外是 `?browserdev=1&fakeupdate=1`——桩会返回一个**假的可用更新**，让「发现新版本」弹窗（含更新说明渲染）也能被验收覆盖（第 26 组），否则这条 UI 只有真发版时才看得到。

### 启动耗时观测

`startup-timing.ts`：启动关键阶段打点（O(1) 无阻塞），首次编译完成后向控制台输出 `[startup]` 报告（各阶段耗时 + navigation timing 页面加载段）；Rust 侧（**仅 debug 构建**）另有 `[startup] rust phase:*` 打点（窗口创建 → webview 就绪 → 前端加载完成）。两侧同前缀，便于统一抓取对比启动性能回归。

### 原生编译后端（typst_world.rs）

typst crate（0.15.x）内嵌进 Rust 壳，`TypstWorld` 实现 `typst::World`。要点：

- **一次编译一个实例**：命令层 `CompileState` 互斥锁保证串行（避免并发 CPU 竞争与共享状态错乱），编译在 `spawn_blocking` 执行（不阻塞 UI）。
- **字体**：`load_fonts` 从字体目录全量加载 `.ttf/.otf` 注册进 `FontBook`；目录不可读时返回空集（typst 给出缺字诊断）。`resolve_fonts_dir`：优先打包产物 `resource_dir/fonts`（`bundle.resources` 映射 `fonts → fonts/`），退回仓库 `src-tauri/fonts`（开发与 cargo test 路径）。
- **文件语义**：主文档源码由前端传入（未保存也可编译）；项目根 = `document_path` 所在目录，相对 include 从磁盘按 typst 语义解析（相对路径基于引用文件所在目录）；`document_path = None`（未保存）时 `check_relative_imports` 预检 `#include`，给出"需要先保存文档"的明确诊断。
- **包支持（packages.rs）**：`@local/{name}:{version}` 从本地数据目录读取、`@preview/{name}:{version}` 从缓存目录读取（miss 时自动下载 packages.typst.org 的 tar.gz 并解压进缓存）——目录规范/环境变量覆盖（`TYPST_PACKAGE_PATH`/`TYPST_PACKAGE_CACHE_PATH`）/URL 格式均与 typst CLI 一致，见 `src-tauri/src/packages.rs` 模块文档；下载为同步调用但编译整体在 `spawn_blocking` 内，不阻塞 UI；404 与网络失败分别产出 `package not found` / `failed to download package` 引擎同款诊断（可区分）。
- **接口契约**：`compile_doc → CompileOutput { ok, pages, diagnostics, warnings }`；`compile_math → MathOutput { ok, svg, widthPt, heightPt, baselinePt, error }`（所见即所得的公式渲染，见上一节）；`export_pdf → PdfResult { ok, error }`。`Err` 仅用于编译/导出任务本身异常终止（正常编译失败仍走 `Ok(ok:false)`）。
- 无 wasm 注入/插件联动：vite 保留的 `vite-plugin-wasm` + `vite-plugin-top-level-await` 两个插件**仅为 codemirror-lang-typst 的语法高亮服务**（其 typst() 扩展是 wasm-bindgen bundler 产物，删掉插件 build 会报 "ESM integration proposal for Wasm is not supported"，勿误删）。
- **Linux/WSLg dev 白屏根因与修复（2026-09-01 实测，勿动）**：WebKitGTK 的模块求值在模块图含**顶层 await**（vite-plugin-wasm 给 codemirror-lang-typst 生成的 wasm 胶水模块是 `const __vite__wasmModule = await __vite__initWasm(...)`）时会崩掉 SvelteKit boot——`get_navigation_result_from_branch`（kit/client.js:799）在求值完成前访问节点模块的活绑定触发 TDZ（"Cannot access 'component' before initialization"），boot 整体拒绝 → 窗口纯白（无任何 UI，外观像"应用没渲染"）。Chromium 求值顺序不同无此问题（已用 Windows 无头 Chrome 对照：同一页面正常渲染）。修复三件套（均在 `vite.config.js`，**只影响 dev**）：
  1. `syncWasmInit` 插件（`apply: "serve"`）：把胶水的 `?url` 引入内联为 data:URL、`__vite__initWasm` helper 换成同步实例化（`new WebAssembly.Instance(new WebAssembly.Module(...))`，两引擎验证可用）→ 模块图无顶层 await。
  2. `optimizeDeps.exclude: ["codemirror-lang-typst"]` **不可删**：依赖预构建的 esbuild 阶段只走 `load` 不走 `transform`，插件改写不到；删了会退回带 TLA 的旧 bundle 重新白屏。清 `node_modules/.vite` 可强制重新预构建。
  3. 匹配是**按内容/字符串形状**做的（helper 是箭头函数 `export default async (opts = {}, url) =>`、胶水行尾无分号）——升级 vite-plugin-wasm 后若修复失效，先核对这两个形状。
  - 排查 WebKit 内部问题的利器：`WEBKIT_INSPECTOR_SERVER` 在新版 WebKitGTK 已废（只剩 `inspector://` 协议，普通 HTTP/WS 连不上，都是空响应）；webview 侧日志可用临时在 `src/app.html` 里挂 `window.onerror`/`unhandledrejection` + `window.__TAURI_INTERNALS__.invoke("write_file", ...)` 把日志写到 `/tmp/xxx.typ`（write_file 要求 .typ 后缀）桥接出来，用完即删。若 WSLg 下 WebKit 仍无法用 GL（libEGL DRI3 报错、白屏但有窗口），用 `GDK_BACKEND=x11 GDK_GL=disable WEBKIT_DISABLE_DMABUF_RENDERER=1` 强制软件渲染可解。

### 字体

**两条管线**：① **typst 渲染**（预览/公式/PDF）用 Rust `FontBook`，产物 SVG 是字形轮廓；② **编辑器界面文字**用纯 CSS 字体栈（无 `@font-face`，即系统字体）——所以界面的中文与预览/PDF 的思源宋体**不保证一致**（想一致得把打包字体经 Tauri asset 协议喂给 webview，未做）。

- **打包字体**：`src-tauri/fonts/`（7 个：思源宋体 / NewCMMath×3 / LibertinusSerif×2 / DejaVuSansMono）。**不放 `static/`**（会被拷进前端产物，安装包白胖 5.7MB）。新增字体同步 `download-fonts.mjs`、Rust 单测 `fonts_all_registered`、README 清单。
- **字体集 = 打包目录 + 系统目录 + 用户额外目录**（`FontConfig.dirs`，设置 → 额外字体目录，对齐 typst CLI 的 `--font-path`）。缓存**按目录列表做 key**（`Mutex<HashMap<..>>`）——增删目录必须重新加载，别退回 `OnceLock` 单值缓存。
- **必须注入默认字体族（`build_library`，勿删）**：不注入时中文全交给 typst 的**自动回退**，而回退打分是「先比衬线标记（`Libertinus Serif` 的 panose 全 0 → 被判**无衬线** → 宋体全被扣分）→ 再比**家族名谁短**」→ **实测（typst 0.15.1，2026-09-14 双侧 CLI 复现）**：Windows 渲染成 `KaiTi`+`LiSu`（楷体/隶书）、Linux 成 `NotoSansCJKjp`（日文字形黑体）。`DEFAULT_FONT_FAMILIES` = Libertinus Serif → 打包思源宋体 → 系统宋体兜底（打包那份是**子集**：4382 码位、CJK 基本区缺 83%，生僻字靠系统字体接住）→ 雅黑收尾。注入走 `Library.styles`（基础层，`typst-eval` 是 `base.chain(&target)`）→ **文档里的 `#set text(font:)` 仍然优先**，且不改编译源、不动诊断行号。
- **设置 → 正文字体**：选项来自 `list_font_families`（真实族名，结构上写不错）；`default_font_families` 给内置列表，前端 `font-settings.buildFontFamilies` 拼「拉丁基准 + 选中项 + 其余兜底」（拉丁基准必须留最前）。
- **字体族名写错 = 静默回退**：typst 对不存在的族名只发 `unknown font family` 警告（族名只认**英文名**，写"微软雅黑"必然不匹配）。所以 warnings 必须显示（状态栏警告徽标 + `font-warnings.ts` 的中文提示）——**删了它，"改了字体没生效"就没人知道了**。
- **正文/公式/PDF 三处同一份配置**（三个命令都收 `fontFamilies`/`fontDirs`，共用 `build_library`）→ 设置里改字体三处一起变；而**文档里**的 `#set text(font:)` 只管正文（公式上下文只含「前缀 + 文档内 `#let`」）。`saveSettings()` 会 `resetMathCache()` 并**立即重编译**——否则预览停在上一次结果，看起来就是"改了没生效"。

### 文件操作与路径安全（src-tauri/src/lib.rs）

- 前端用 `isTauri()`（检测 `__TAURI_INTERNALS__`）区分桌面/浏览器；浏览器（非 Tauri）环境只显示"请使用桌面应用版本"提示页，不渲染应用 UI。
- Rust 侧 `validate_typ_path`：必须绝对路径、`.typ` 扩展名（大小写不敏感）、拒绝 `..` 穿越；`read_file` 先 canonicalize 复检符号链接；`write_file` 拒绝写入符号链接；`write_binary`（PDF 落盘，bytes 以 JSON 数字数组传来）与 `export_pdf` 走 `validate_write_path`——不限制扩展名，其余安全模型一致（`..`/符号链接同样拒绝）；`list_dir_typ` 递归列 `.typ`：深度 ≤ 8、最多 500 个、跳过隐藏条目、符号链接目录不递归（防环），返回 canonicalize 后路径。
- 无 single-instance 插件（每次启动独立实例）。`.typ` 文件打开走 `PendingFiles` 队列 + `emit("open-file")`：前端**先注册监听再取队列**（`take_pending_files`），避免事件落在两者之间丢失；macOS 的 Finder "打开方式" 走 `RunEvent::Opened`。
- **浏览器直开会看到"请使用桌面应用版本"**：这是刻意的 desktop gate（`+page.svelte` 的 `{#if isDesktopApp}` 分支）。开发模式下该页面额外给了一键入口（跳到 `?browserdev=1`），避免把"没带参数"误判成"应用坏了"（实测被反馈过一次）；生产构建不显示该入口。
- `capabilities/default.json` 的 `windows` 覆盖 `"main"` 与 `"editor-*"`（Ctrl+N 新窗口），权限含 `core:window:allow-create/close/destroy/set-title` + opener/dialog。**新增窗口功能时需同步此文件**——曾因 capability 未覆盖新窗口导致窗口内文件功能被 ACL 拒绝（#32）。

### 安全模型

`tauri.conf.json` 的 `csp` 保持 `null`（wasm 编译管线已移除、wasm 限制解除，但 CSP 未实测启用）。纵深防御 = **SVG 产物来自进程内可信编译**（`sanitizeSvg` 模块已随 wasm 移除，不再需要）+ Rust 路径约束（read/write/export 命令统一校验绝对路径、拒绝 `..` 穿越、拒绝符号链接）。若改动 csp，必须在 `npm run tauri build` 后实机测试。

### 持久化与版本

- `persistence.ts`：300ms 防抖写 localStorage（含正文 `content`、`filePath`/`fileTitle`、`dirty`、`restoreSession`）。
- **启动恢复（会话安全网）**：主题/前缀/界面模式总是恢复；**上次的正文**按设置恢复（设置弹窗「启动时恢复上次内容」，默认开）——editorDoc 陈旧推送、误触重读、WebView 重载这类"内容没了"都能被它兜住。恢复时 `filePath`/`fileTitle`/`dirty` 一并还原，所以「存过盘又没再改」的文档不会平白带上未保存圆点；恢复出来的未保存内容会让打开新文件 / 关闭窗口照常追问。关掉开关即回到「每次全新开始」。**新建（Ctrl+N）会 `clearState()`**，清掉存档后下次启动自然恢复出空文档。
- 版本号约定（0.4.0 起）：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的 `version` **三处一致**修改（Cargo.toml 参与发版）。CI Rust 缓存（Swatinem/rust-cache）key 基于 Cargo.lock 哈希——**改动依赖会使 Cargo.lock 变化、缓存失效全量重编**（引入 typst 依赖树时已付出一次）。**实测（2026-08-10）：rust-cache 的 key 不受根 crate 的 version 字段影响**（改 lock 根 version 为 `"1"` 后 key 不变、精确命中旧缓存）——因此只改版本号发版时缓存必然命中，无需为版本号做任何占位 hack；Cargo.lock 内 version 必须保持合法三段式 semver（写 `"1"` 会致 cargo "failed to parse lock file"，实测踩过）。
- 关于弹窗版本号运行时读取：`getVersion()`（@tauri-apps/api/app）返回 tauri.conf.json 的 version（关于弹窗显示"版本 x.y.z"），发版改版本号后前端无需改动。

## 环境备忘（本机 WSL）

- **`git push` 走 22 端口偶发被掐**（`Connection closed by 20.205.243.166 port 22`）：改走 GitHub 的 443 入口即可 ——
  `GIT_SSH_COMMAND="ssh -p 443 -o StrictHostKeyChecking=accept-new" git push git@ssh.github.com:Z3O1/Typst-pad.git HEAD:main`（已实测可用；先 `ssh -T -p 443 git@ssh.github.com` 验证认证）。
  - **`-o StrictHostKeyChecking=accept-new` 不可省**：agent 的沙箱不允许写 `~/.ssh/known_hosts`（报 `Failed to add the host to the list of known hosts`），缺了这条会直接 `Host key verification failed` 而看起来像权限问题。同理 `git fetch origin` 也常失败（走 22），要刷 `origin/main` 就显式用 443 的 URL 并指定 tracking ref：
    `git fetch git@ssh.github.com:Z3O1/Typst-pad.git main:refs/remotes/origin/main`（不用改 `remote.origin.url`）。
- **转公开后 main 与 `origin/main` 同步的手感没变**，但**推送规则变了**：仓库上那条 2026-08-02 建的 ruleset「protect main」在私有仓库（免费账户）里**从未真正执行**，仓库一转公开就被 GitHub 强制生效——第一次直推 main 会收到 `GH013: Repository rule violations found for refs/heads/main … Changes must be made through a pull request`。**2026-09-14 已按用户选择把该规则集改成只保留 `deletion` + `non_fast_forward`**（去掉必须走 PR），所以直推 main 照旧可用；跨域改这条规则用 `gh api -X PUT repos/Z3O1/Typst-pad/rulesets/<id> --input <完整 JSON>`（PUT 是整体替换，不是增量）。
- **端口归属**：`1420` = `npm run tauri dev` / `npm run dev` 的 Vite 端口；`9333` = 验收用 headless Chrome 的 CDP 端口。
  两者都可能被上一次没退干净的进程占着（"Port 1420 is already in use"）；查占用：WSL `ss -ltnp | grep :1420`、Windows `/mnt/c/Windows/System32/netstat.exe -ano | findstr :1420`（镜像网络下 Windows 侧监听同样会挡住 WSL 绑定）。
- 无显示器环境：GUI 跑不了桌面端，验收一律用 `scripts/browser-check/`（Windows 的 headless Chrome + CDP）；`gh` 用 Windows 版 `/mnt/c/Program Files/GitHub CLI/gh.exe`（需 `--repo Z3O1/Typst-pad`，WSL 路径会触发 dubious ownership）。

## CI / 发布约定

- `ci.yml`：`test` job（ubuntu）push main/PR 跑 类型检查 → 单测 → 前端构建 → `cargo check`（**首次编译 typst 依赖树较慢**，之后命中缓存）；`build-bundles`（windows）**main push 或 workflow_dispatch 触发**（PR 不构建），Rust 缓存用 `shared-key: tauri-build-windows`（必须与 `release.yml` 相同，否则 release job 读不到缓存）。
- `release.yml`：`v*` tag 触发，自行 checkout + 构建 + 发草稿 Release（不依赖 ci.yml 的 artifact）。发布构建吃 main 分支写入的缓存。
- **自动更新与签名密钥（2026-09-14 接入）**：
  - 私钥/密码存在仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY`（`tauri signer generate` 的 `.key` 文件内容）+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。**本机备份有两份（2026-09-14 补的第二份）**：仓库内的 `.updater-keys/`（已 gitignore，但**它在工作区里**——`git clean -xfd` 或误删仓库就一起没了）与 `~/.tauri/`（`typst-pad.key` / `.key.pub` / `password.txt`，0600）。丢了就再也发不出更新，所以别只留工作区那一份；本地打包用 `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/typst-pad.key`。
  - **pubkey 已写入 `tauri.conf.json` → 所有 `tauri build` 都必须有私钥**：缺了会直接失败（CLI 原文 "A public key has been found, but no private key"），所以 `ci.yml` 的 `build-bundles` 与 `release.yml` 的构建步骤都传了这两个 env。**推论：Secrets 缺失时 main 的 CI 会红**，别当成缓存问题排查；PR 不跑 `build-bundles`，fork PR 也不需要密钥。
  - 构建后由 `node scripts/generate-latest-json.mjs` 生成 `latest.json`（`ci.yml` 里只验证"生成得出来"，`release.yml` 里与安装包一起作为 Release 资产上传）。脚本坏了要在 main 上就发现，别等到发版。
  - 生成的清单以 **NSIS** 的 `*-setup.exe` 为更新包（`bundle/**` 里同时上传 `.sig` 签名文件）。
  - **草稿 Release 客户端拿不到**：`releases/latest/download/latest.json` 只认已发布的最新 Release，所以"发版要 Publish"从"对外可见"升级成"自动更新能不能生效"。
- **缓存纪律（2026-08-10 事故后固化，勿回退）**：
  - rust-cache **禁止加 `cache-on-failure`**：被 cancel 的 run 即使编译已完成，post 上传缓存仍会被截断（实测 588MB 只传了 542MB），后续 run 精确命中同 key 不覆盖 → 半成品缓存永续，每次构建重编 55 个 crate（13 分钟）。只有成功完成的 run 才允许保存缓存。
  - **run 运行中不要 push main**：concurrency `cancel-in-progress` 会打断正在构建的 run，预热/发版构建被打断即前功尽弃。
  - 缓存损坏后的修复流程：`gh cache delete <key>` → 用 **workflow_dispatch 手动触发**（不是 push，push 会 cancel）→ 等 run 自然完成 → 再手动触发一次验证（预期仅 2 个 Compiling、~3 分钟）。
  - `tauri-bundle-tools` 缓存 key 含 `hashFiles('package-lock.json')`：依赖升级（tauri-cli 打包逻辑变化）自动失效重建，锁文件不变则稳定命中。
  - 健康缓存命中时构建 ~3 分钟（2 个 Compiling），全量 ~16 分钟（78 个 Compiling）——数字异常即缓存失效信号。
  - **rust-cache 的 key 含「Rust 工具链版本哈希」**（`add-rust-environment-hash-key` 默认开）：`dtolnay/rust-toolchain@stable` 跟到新的 Rust 稳定版后 key 整片失效、全量重编（2026-09-11 实测：Rust 1.98.1 令 restore key 变为 `v0-rust-tauri-build-windows-Windows_NT-x64-2113753f`，日志 "No cache found" → 78 个 crate、30 分钟）。这是**一次性**重建、不是回归，下一次 push 即恢复 ~3 分钟；排查时先看 "Cache Rust build" 步骤里的 Restore Key 与 "No cache found"，别急着动缓存配置。
- **action 版本约定（Node 24 运行时，2026-09-11）**：`actions/checkout@v5`、`actions/setup-node@v5`、`actions/cache@v5`、`actions/upload-artifact@v6`（v5 只是预备支持、默认仍跑 Node 20，必须 v6）、`softprops/action-gh-release@v3`，两个 workflow 保持一致——消除 GitHub 的 "Node.js 20 is deprecated（被强制跑在 Node 24 上）"告警。`Swatinem/rust-cache@v2` 已是 node24、`dtolnay/rust-toolchain` 是 composite 类型，无需升级。**升级 action 不影响任何缓存 key**（rust-cache 的 key 只由 shared-key/平台/Rust 版本/Cargo.lock 决定，见上）。
- **仓库可见性与推送规则（2026-09-14，转公开的连带后果）**：
  - 仓库已是**公开**（`gh api repos/Z3O1/Typst-pad --jq .private` → `false`）——这是自动更新能工作的前提，别改回私有（一改回去客户端立刻全部「检查更新失败」）。
  - 仓库上有一条 ruleset「protect main」（id `20191962`，`~DEFAULT_BRANCH`）：**私有 + 免费账户时它不生效**（所以 2026-08-02 建了以后一直能直推 main），转公开那天被强制生效，直推 main 报 `GH013 … Changes must be made through a pull request`。按用户选择**已改成只保留 `deletion` + `non_fast_forward`**（禁删分支 / 禁 force push，不要求走 PR）→ 直推 main 恢复正常。
  - 万一将来又冒出「必须走 PR」类规则：要么按用户偏好再放宽该 ruleset，要么走 `git push HEAD:refs/heads/<分支>` → `gh pr create` → `gh pr merge --squash --delete-branch`（实测三条命令即可，零审核要求）。**不要**为了绕开它去 force push 或改 remote。
- 版本升级流程：**先得到用户的明确指令（"发 0.7.6"之类）**——见红线 11，不许自行开新版本；他点头之后：改版本号（三处一致）→ 合并 main（自动构建）→ 打 tag → **草稿 Release 一建好就直接 Publish，这一步不必再问**（`gh release edit v<版本> --draft=false`）。
  - 依据（2026-09-14 用户原话）：「草稿 Release 好了直接 Publish」。Publish 是自动更新生效的**前提**——草稿资产客户端拉不到 `latest.json`（见上一条），所以留在草稿等于这版没上线。
  - 需要"等构建完再发"时用**一次性延时动作**（睡一会儿 → 查一次 → 有草稿就发），不要写轮询循环（红线 9）。实现上挂成**后台 job**（有界重试：每 ~40s 查一次 `gh release view <tag> --json isDraft`，看到 `true` 就 `gh release edit --draft=false`，上限 45 次）——它不占回合，构建好了自动补发，超时则自己结束并留一行说明。

## 测试

- 前端 vitest + jsdom，`include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"]`（第二条是发布脚本的测试：脚本是普通 JS + node 内置模块，进了 TS program 就得给每个参数写 JSDoc 或装 `@types/node`——仓库刻意没装，见 `vite.config.js` 里的 `@ts-expect-error`，所以让它们留在类型检查之外）；vite 的 `server.fs.allow: [".."]` 覆盖仓库上级目录（junction 场景下 node_modules 解析被拒的教训，见 #33，配置仍保留）。现有覆盖：`typst-engine`（invoke 契约映射 + 诊断转换纯函数，invoke/dialog 以 vi.mock 断言入参与消费）、`diagnostics-utils`、`error-list`、`context-menu-utils`、`doc-utils`、`editor-keymap`、`menu-keys`、`popover-utils`（#46 Popover 视口溢出的回归守卫）、`persistence`、`svg-paginate`、`pdf-export`、`preview-scale`、`write-commands`、`zoom`（滚轮档距/方向/上下限收敛/浮点圆整/横向位移退回）、`update-utils`（检查节流 / 进度换算 / 字节格式化 / 错误文案翻译）、`update-notes`（更新说明的 Markdown 渲染：转义/XSS、标题/嵌套列表/粗体/行内代码、不闭合成对符号时保持原文、链接不做成 `<a>`），脚本侧 `scripts/generate-latest-json.test.mjs`（平台键映射、semver 校验、NSIS 优先挑选、清单结构、CHANGELOG 提取、CLI 端到端）。
  **已删除的低价值测试（勿凭"补覆盖"再加回来）**：`file-ops.test.ts`（只测 `.typ` 后缀匹配这种一眼可见的判断，真路径安全在 Rust `validate_typ_path`，留着会造成"文件安全已测"的错觉）、`debug.test.ts`（调试日志通道，坏掉无用户可见后果）、`context-menu-utils.test.ts` 的 `computeMenuPosition` 收边 5 项（3 行 clamp，失败肉眼可见；更复杂的限宽分支由 popover-utils 覆盖）。
- Rust 单测（`typst_world.rs`/`packages.rs` 内 `cargo test`，用 `CARGO_MANIFEST_DIR` 定位 `src-tauri/fonts`）：中文+数学文档端到端编译（每页含 `<svg>`，PDF 字节非空）、字体注册（7 个文件 + 族名断言）、语法错误诊断（1-based 行列 + endLine）、相对 include（成功 / 缺失文件诊断带 path / 未保存文档提示）、JSON 序列化契约（camelCase 键名 `endLine`/`endColumn`）、@local/@preview 包（缓存命中不下载 / miss 下载与 URL 格式 / 404 与网络失败诊断区分 / 数据目录优先 / 路径穿越与损坏归档防御 / 端到端导入编译，均用临时目录注入环境变量，不触真实用户目录与网络）。
- 所见即所得链路测试：`typst-lex.test.ts`（区域扫描：注释/raw/字符串/代码/`[...]` 内容块）、`markup-ranges.test.ts`（标记拆解，含"代码与公式里的 `*` `_` 不算标记"、有序列表编号、围栏代码块）、`typst-scan-fuzz.test.ts`（**鲁棒性网**：120 份固定种子随机文档 + 15 组病态输入，断言不抛异常、区间有序不越界不重叠、区域无缝覆盖全文）、`math-context.test.ts`（`#let` 提取的保守规则）、`live-preview.test.ts`（jsdom 里真挂 EditorView，断言 widget 替换 / 块级 vs 行内 / 光标进出展开 / 失败回退 / 开关关闭 / 样式类）。**坑**：jsdom 下挂视图时光标默认在 offset 0，会落在构造内部而触发"展开"，测隐藏效果必须把光标放到构造之外。
- 前端测试不接触真实编译——依赖引擎的逻辑保持"核心逻辑独立可测"（纯函数 + mock invoke）。
- **浏览器端交互验证（无显示器环境下的验收手段）**：`scripts/browser-check/`（零依赖 CDP 驱动）
  - **端口**：验收脚本默认打 `http://localhost:1420/?browserdev=1`，而 **1420 也是 `npm run tauri dev` 的 Vite 端口**——用户自己开着桌面应用时，验收脚本会被 "Port 1420 is already in use" 挡住（实测被反馈过）。换端口跑即可：`npm run dev -- --port 1425` 起服务 + `BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg.mjs`（1420 是 `vite.config.js` 里写死的 `server.port` + `strictPort: true`，CLI `--port` 可覆盖，不覆盖时宁可报错也不自动换端口；脚本侧由 `cdp.mjs` 导出的 `DEV_URL` 读取 `BROWSER_CHECK_PORT` / `BROWSER_CHECK_URL`，`probe.mjs` 仍可传 URL 参数）。
  - `cdp.mjs`：连接 Windows headless Chrome 的 CDP（WSL 里直接跑 `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe --headless=new --remote-debugging-port=9333 --remote-debugging-address=0.0.0.0 --user-data-dir=... 'http://localhost:1420/?browserdev=1'`；镜像网络下 WSL 可直连 localhost:9333）；提供 evaluate / 真实点击 / 真实输入（`Input.insertText`）/ 截图。
  - `probe.mjs`：排障小工具（导航到页面 → 打印渲染结果/页面内错误），"页面是不是坏了"先用它看。
  - `wysiwyg.mjs`：所见即所得 + 自动更新入口 + 界面缩放 + 字体设置 + 更新说明渲染 + 缩放死区 + 窄视口状态栏的 **110 项验收**（输入公式 → widget 出现 → 光标进入展开 → 移出恢复 → 视图菜单开关 → 标记隐藏/标题字号/字重/圆点替换 → 光标进标题露标记 → 链接只留文字 → 跨行行间公式块级居中 → 光标进入整行展开 → 文档内 `#let` 确实进了编译上下文（桩把最近一次 `compile_math` 入参记在 `window.__browserDevLastMath`）→ 有序列表编号 → 围栏代码块渲染与光标展开 → 写作模式单栏形态 → 菜单调出预览栏 → 源代码模式自动回双栏 → 仿 Typora 写作界面（write 类、无行号槽、衬线/16px/行高 1.9、纸张限宽、状态栏「写作」无行列）→ Ctrl+B 加粗 / Ctrl+1 标题的插入与字号放大 → 启动恢复会话 → Alt 不夺焦 → **第 23 组自动更新入口**：帮助菜单有「检查更新…」、点它后状态栏显示"已是最新版本"（桩返回无更新）、没更新时不弹窗不留状态栏提示、检查不抢焦点、设置里有「启动时自动检查更新」且默认勾选 → **第 24 组界面缩放**：启动即把恢复的缩放交给 webview（桩把 `setZoom` 的入参记在 `window.__browserDevLastZoom`）、默认不显示缩放徽标、Ctrl+滚轮向上 5 档 → 请求 150%、状态栏实时反馈 + 常驻徽标、写进存档、**重载后恢复并重新应用**、不带 Ctrl 的滚轮不响应、**在状态栏上滚也能缩放**（监听挂在 window）、**调档后会再确认一次**（防 WebView2 手势结束时还原系数）、正常路径不误报「缩放未生效」、**横向位移（deltaY=0 + deltaX）也能缩放**、向下滚到底收敛在 50%、菜单三项齐全 + 提示、重置回 100% 且徽标消失（16 项） → **第 25 组正文字体设置**（12 项）：字体下拉（首项「默认」）+ 额外字体目录 UI；保存后**立即重编译**且字体族/目录透传（桩记 `__browserDevCompileCount`/`__browserDevLastCompile`）；写错的中文族名以警告徽标出现并给中文提示） → **第 26 组更新说明渲染**（6 项，用 `&fakeupdate=1` 让桩返回假的可用更新把弹窗打开）：小标题渲染成 `h4` 元素、文本里不再有 `###`/`**` 原文、行内代码是 `code` 元素、列表是 `li` 且两空格缩进形成嵌套、说明里的 `<img onerror=…>` 只当文本（断言页面里没有 `img` 元素）。 → **第 27 组缩放死区**（5 项，桩用 `&zoomsim=1` / `&zoomcap=1` 模拟真机引擎）：引擎接受时不误伤、引擎拒绝放大时档位被拉回它给的 100%、状态栏说明是引擎限制、被拒之后立刻往下滚就能缩小。 → **第 28 组窄视口状态栏**（4 项，用 `Emulation.setDeviceMetricsOverride` 把 CSS 视口压到 660×460，等价于 1258px 窗口里缩放到 ~190%）：引擎的 ResizeObserver 提示不再报成「脚本错误」、真正的脚本错误仍然显示、长状态文字不把状态栏顶高（≤30px，一行）、右侧徽标/标签/计数在窄视口下也不折行（每项 ≤20px）。**2026-09-14 已在本机跑通**（`npm run dev -- --port 1425` + Windows headless Chrome，110 项全绿）；顺带修掉了两个卡点：桩读 dialog 参数时漏了 `options` 那层包装（「添加字体目录」点了没反应）、以及保存设置后的状态栏确认被重编译的「就绪」顶掉。
  - **实测坑（都踩过）**：① `Page.navigate` 对**相同 URL** 不重新加载，上一次停在 500 错误页时会一直复现 → `goto()` 先跳 `about:blank`；② 截图必须由 Node 写进**工作区**（写 `/mnt/c/...` 会被文件沙箱拒绝，报 EROFS），别交给 Chrome 写；③ **Windows 的 headless Chrome 必须加 `--no-proxy-server`**，否则 localhost 会被系统代理吞掉、页面报"无法访问此网站"，看起来像"WSL 端口转发坏了"（判断连通性更干净的判据是 Windows 自带 `curl.exe`：`/mnt/c/Windows/System32/curl.exe -s -o NUL -w '%{http_code}' http://localhost:1420/`）；④ 验收脚本开始前**必须清 localStorage 再重新加载**，否则上一轮遗留的「源代码模式」会让页面不渲染公式，第一条断言莫名超时；⑤ 找菜单项要限定在 `.menu-dropdown .menu-item` 里，别在全页找同名文字（状态栏会显示"源代码模式"这类同名状态文字）。
  - ⑥ **收尾绝不要跑 `taskkill /IM chrome.exe /F` 这种全量杀进程**（2026-09-14 犯过：把用户自己开着的 Chrome 窗口全部杀掉，用户直接炸了）。只杀**我启动的那一个 headless 实例**：启动时用 PowerShell 拿到 PID 并存到 `.browser-check/chrome.pid`（`powershell.exe -Command "Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--headless=new','--remote-debugging-port=9333',... -PassThru | Select-Object -ExpandProperty Id"`），收尾时**按 user-data-dir 精确挑出自己那几个 PID**（实测可行的写法，`powershell.exe` 不在 PATH 上，必须用绝对路径）：`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*dsh-chrome-typstpad*' } | Select-Object -ExpandProperty ProcessId"` → 再逐个 `taskkill /PID <pid> /T /F`。（`Start-Process -PassThru` 那条路在本机没跑通：拿不到 PID。CDP 的 `/json/version` 也不暴露 PID，所以按 user-data-dir 反查最稳。）**同理适用于任何"清理现场"的动作：只动自己创建的东西**（进程、文件、端口、git 暂存）。
  - `wysiwyg-visual.mjs`：**真实排版的视觉验证**。先用 `npm run fixtures:math`（Rust 侧 `dump_math_fixtures`，`#[ignore]` 的按需测试）把真实 `compile_math` 产物导出到 `.browser-check/math-fixtures.json`（**两种字号各一份**：12pt 写作模式 / 10.5pt 源码模式，桩按 body+display+**sizePt** 匹配，字号对不上宁可退回假 SVG），再用 `Page.addScriptToEvaluateOnNewDocument` 注入页面；桩的 `compile_math` 命中夹具时返回**真实产物**。实测四件只有浏览器/桌面端才看得出来、单测覆盖不到的事：行内公式基线与同行文字基线齐平（零宽 inline-block 探针量基线，误差 < 1px）、渲染尺寸 = 真实 pt × 4/3、块级公式居中且独占整行、暗色主题反色后可见（12 项检查）。**坑**：夹具 json 里没有 `ok` 字段，桩返回时必须补 `{ ok: true, ...fixture }`，否则前端按"渲染失败"处理，页面里公式一直停在源码（实测踩过）。
  - 浏览器开发模式（`?browserdev=1`，见 `src/lib/browser-dev-stub.ts`）里的 `compile_doc` 是假实现（假分页 SVG），`compile_math` 在没有注入夹具时也是假 SVG；文件/PDF 等 Tauri 命令同样是假的。**真实 typst 排版可用夹具链路上浏览器验证**，只有 Tauri IPC / WebView2 那一层必须桌面端（Windows）确认。
