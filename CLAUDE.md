# CLAUDE.md

Typst-pad = 仿 Typora 的 Typst 桌面编辑器，两套 UI：「写作模式」（默认，单栏整页纸张）与「源代码模式」（`Ctrl+E`）。前端 SvelteKit SPA（adapter-static）+ Tauri 2（Rust）+ 内嵌 typst crate 0.15.x（进程内编译、本地字体），无 wasm、无网络依赖。注释与 README 中文。

**本文档只写规则**；每条规则的实测数据、踩坑经过与完整论证在 `docs/实现细则/`（7 个分册，索引 `docs/实现细则/README.md`）。**动某块之前先读文末「文档地图」里对应的那一册**——本文件不再复制细则。

## 当前状态

- 版本 **0.9.0**；版本历史 `CHANGELOG.md`，提交历史 `git log`，踩坑经过 `docs/实现细则/`。
- **仓库必须保持公开**（否则客户端检查更新全失败）；自动更新只覆盖 Windows。

## 常用命令

```bash
npm run tauri dev    # 桌面应用（Vite 固定 1420；WSL 可跑，libEGL 警告正常）
npm run check        # svelte-check（0 errors / 0 warnings）
npm test             # 单测（46 文件 / 855 项）；npm test -- <文件> 跑单个
npm run format:check # prettier（`npm run format` 是对称的写入版）
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check                  # rustfmt（默认风格，无 rustfmt.toml）
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测（61 passed / 6 ignored）
node scripts/check-fonts.mjs
# 动编辑器 / 装饰 / 布局 / 组件样式时才跑浏览器验收（换端口，别跟 tauri dev 抢 1420）
npm run verify:browser   # **推荐**：自己起 dev server + headless Chromium + 导夹具 + 跑七套 + 汇总
npm run dev -- --port 1425
BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg.mjs                              # 290 项
CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-blocks-visual.mjs   # 改块级渲染必跑
```

打包、发布、全部验收脚本的命令全文：`docs/实现细则/06-命令与发布.md`。

## 改动前的红线（勿回退）

1. 改 `src/` = HMR 到运行中的 `tauri dev`；改 `src-tauri/` = Tauri 重启应用。
2. `editorDoc` 必须是编辑器内容的**实时镜像**（否则丢未保存内容）。
3. `Decoration.*.range(a, b)` 必须 `b > a`；装饰计算与 widget 渲染留在 try/catch 内（抛进 CM 事务 = 编辑区卡死）。
4. 写作模式留白挂 `.cm-scroller`，不是 `.cm-content` 的 padding。
5. 菜单（Alt / 鼠标）不许夺编辑区焦点。
6. `src-tauri/fonts/` 不放 `static/`。
7. `vite.config.js` 的 dev 白屏修复三件套与 `optimizeDeps.exclude: ["codemirror-lang-typst"]` 不许删；前端已无 wasm，那两个 wasm 插件暂无服务对象，要删先在 WSL/WebKit 验启动。
8. 版本号三处一致（`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`）；rust-cache 禁 `cache-on-failure`。
9. **绝不阻塞等 workflow**：推 main / 打 tag / 后续命令一律不等 CI、Release；不挂轮询任务；状态最多**单查**一次 `gh run list`；不要加"别在 CI 运行中 push main"这类限制。
10. 签名密钥不许动：Secrets 删了就构建不了、换了就再也发不出更新。
11. 发版权在用户手里：改版本号 / CHANGELOG 版本段 / 打 tag / 建发 Release，只在他说"发 X.Y.Z"之后做。
12. **五道格式/静态检查门不许摘**（都在 CI 的 `test` job 里，摘一道就等于没有）：`npm run check`、`npm test`、`npm run format:check`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`，另有 `cargo test --manifest-path src-tauri/Cargo.toml`。改完先本地跑齐；`cargo check` 那一步已被 `clippy --all-targets` 取代（两步都跑等于同一份代码编两遍）。

## 细则红线（一句话版；展开与理由见对应分册）

> 下面这组是**规则版**：每条对应分册里的实测数据与踩坑经过，展开与理由见对应分册。它是"入口索引"，**不追求与详版逐字一致**；发现规则被削弱或漏了，就补分册 + 这里补一句（PR #61 瘦身时漏过 3 组，见该 PR 的审查评论）。

- **编译/后端（→02）**：诊断 `path` 主源表示只许一种；项目根跟着**引用**放宽（**别写成"目标文件的公共祖先"**）；`compile_blocks` 失败也要带 `blocks` 键；**必须注入默认字体族**；`CompileState` 一次一编译。
- **块级渲染（→03）**：**别改回全渲**、**单块也要有上限**（`MAX_CROP_SOURCE_BYTES` = 8KB，超过只回几何不渲图，前端必须把 `skipped` 与"缺切片"分开）；**编辑期间块表必须跟着走**（`remapBlocksThroughEdit`）、`planBlockCovers` **绝不抛异常**；块切片 `Decoration.replace` **必须落在整行边界**；块间空行归上一块；竖直移动**别退回"一次跨一整块"**；**别自己写 scrollTop**（用 `scrollIntoView`）；**光标所在那块必须展开**；链接热区 `mousedown` **必须 `preventDefault`**；打字期间不编译（150ms，公式再推 240ms）；缺切片只看块表、**且要排除 `skipped`**（`found && !skipped && svg === ""`）；"铺满全文"是 covers 的事，**别拿 `blocks` 去断言**。
- **所见即所得（→04）**：宁可漏渲染、不可误渲染；`MATH_TEXT_PT = 10.5`、写作模式跟随文档字号（**别写死**）；标题梯度 1.4/1.2/1.0em；`$` 配对**右侧已有 `$` 就跨过去**（且排在"公式内部不配对"之前）、退格整对删；**不要用 `&dark` 选择器**；整块选中不展开但**别套到跨行行间公式**；**别用 CSS zoom**（走 `setZoom`）；**别让观察结果去改档位或回改引擎**；判据用 CSS 布局宽度；格式命令（菜单 + 快捷键，**不做工具条**）**无选区替换整行、不丢字**、有选区只替换选区、包装命令**首尾空白留定界符外侧**、引用**必须 `#quote(block: true)[...]`**（Typst 没有 `>`）；**快捷键分三处**归口（**MenuBar 只认 Ctrl+单键**）；切换模式**保持光标**（**别自己写 scrollTop**）。
- **窗口/更新（→05）**：`decideAppKey` 顺序敏感（Esc → Alt+Z → Ctrl+Shift+N → 格式表）；新建窗口 ACL 两处都要；更新弹窗**只收起来**（**绝不写 `updateDismissedAt`**）；点过「稍后」= 只更新状态栏（**别退回时间窗口版**）；**不许再加"上次检查时间"式节流**；更新说明渲染**别退回 `<pre>`**。
- **文件/安全（→02）**：写盘只有一条路（`document-session` 的 `save() → saveTypFile → write_file`），**没有自动保存**；**绝不能让 `editorDoc` 落后**；`validate_typ_path` / `validate_write_path` 不许绕过；`csp` 保持 `null`；「空文档存进已有文件」**不弹确认窗、直接写空（勿加回）**。
- **测试/审查（→07）**：日常 `check` + 相关单测，动编辑器/装饰/布局才加浏览器验收；`file-ops` / `debug` / `computeMenuPosition` 这几处**不要补测试**；全套绿的 PR 仍要两条腿审（3 个只读子代理 + 主 agent 自己跑）；结论写进 `gh pr comment`。
- **发布（→06）**：`cache-on-failure` 禁；**别 force push / 改 remote**；签名密钥不许动；发版权在用户手里。

## 已知未决 / 可做

- `?browserdev=1` 是假编译（真实排版走 fixtures）；真保存 / 导出 PDF / 系统对话框必须桌面版。
- 「启动时恢复上次内容」默认开。
- 自动更新只覆盖 Windows（上其它平台要补构建 job + `relaunch()`）。
- 点过「稍后」后所有新版本都不再自动弹窗（要"按版本"得比 `skippedVersion`）。
- 写作模式：脚注不显示、表格整块、无每字形文字层、真机手感未验。

## 和这位用户协作的偏好

- 他自己跑桌面版，反馈是一句话/截图；**先复现再改**，复现不出就加兜底 + 让错误在状态栏可见。
- 不等慢测试：日常 `check` + 相关单测；`browser-check` 只在动编辑器/装饰/布局时跑。
- 发版两步：要不要发、发哪个号由他说；说了就"草稿一建好直接 Publish，不用再问"。
- 不可逆 / 改仓库设置的动作先问；既有约定覆盖的机械动作直接做。
- 清理现场只动自己创建的对象（别全量 taskkill）；推送被规则拦住先问"放宽还是走 PR"。
- 产品：仿 Typora（**无工具条**）、不许夺焦、界面无多余色块与凸出。

## 环境备忘（本机 WSL）

- push 22 端口被掐走 443：`GIT_SSH_COMMAND="ssh -p 443 -o StrictHostKeyChecking=accept-new" git push git@ssh.github.com:Z3O1/Typst-pad.git HEAD:main`（`accept-new` 不可省）；fetch 同理显式 443 URL + tracking ref。
- 1420 = Vite，CDP 默认 9333（单跑套件）/ 9335（`npm run verify:browser`）；查占用 `ss -ltnp | grep :1420` / Windows `netstat.exe -ano | findstr :1420`。`gh` 用 Windows 版（`--repo Z3O1/Typst-pad`）。
- headless Chromium 用 Windows Chrome（镜像网络下 WSL 才能连 9333）或 WSL Playwright 的 `chromium_headless_shell-*`；**用托管后台任务起**，收尾按记下的 job/端口关。

## 文档地图（改哪块，先读哪册）

| 要动的东西 | 先读 |
|---|---|
| 模块清单全景、红线、协作偏好 | `docs/实现细则/01-总览与红线.md` |
| 编译链路与诊断、项目根、typst_world、字体、路径安全、持久化 | `docs/实现细则/02-编译与后端.md` |
| 写作模式块级渲染（切片 / 透镜 / 命中 / 鼠标 / 链接） | `docs/实现细则/03-块级渲染.md`＋`docs/文档模式渲染保真-调研.md`、`docs/写作模式块级渲染-现状与交接.md` |
| 所见即所得（范围识别 / 公式 / 标记 / 两套 UI / 缩放 / 状态栏） | `docs/实现细则/04-所见即所得.md`＋`docs/WYSIWYG-调研.md` |
| 按键路由、多窗口与 ACL、自动更新、启动打点 | `docs/实现细则/05-窗口与更新.md` |
| 全部命令与验收脚本、CI 缓存纪律、签名与发版 | `docs/实现细则/06-命令与发布.md` |
| 单测范围与坑、浏览器验收（七套 + 一条命令）、PR 审查两条腿 | `docs/实现细则/07-测试与审查.md` |
