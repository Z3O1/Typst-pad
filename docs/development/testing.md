# 测试与验证

[返回文档索引](../README.md) · [贡献流程](../../CONTRIBUTING.md)

## 按改动选择验证

| 改动 | 最低验证与补充 |
| --- | --- |
| 纯文档、注释中的引用 | 检查相对链接、锚点、旧路径和完整 diff；不为文档迁移跑应用测试 |
| 前端逻辑 | `npm run check`、相关 Vitest；提交前跑前端 CI 门禁 |
| Rust 编译、字体、路径或 IPC | rustfmt、clippy、相关 Rust 测试；IPC 变化同时验证前端成功/失败响应 |
| 编辑器、装饰、快捷键、布局 | 相关单测 + 对应浏览器套件 |
| 公式、块渲染、锚点、模式切换 | 真实夹具与稳定性套件；不能只用桩或 jsdom |
| Svelte 拆分、样式或布局 | 浏览器交互 + `computed-style.mjs`，关注作用域和窄窗口 |
| 文件对话框、写盘、多窗口、设置接线、更新安装 | 相关单测/静态权限检查 + 桌面验证 |

CI 门禁是类型检查、Vitest、Prettier、前端构建、rustfmt、clippy 与 Rust 测试，具体步骤以 [CI](../maintainers/ci.md) 和 workflow 为准。不要把“相关测试已通过”表述为“全部 CI 已通过”。

```bash
npm run check
npm test
npm run format:check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

运行单文件可用 `npm test -- src/lib/core/typst-engine.test.ts`。Rust 可在 `cargo test --manifest-path src-tauri/Cargo.toml` 后追加测试名过滤器。`clippy --all-targets` 已包含编译检查，无需再机械重复 `cargo check`。

Prettier 的写入命令是 `npm run format`，但应只格式化本次文件以免混入无关变更。`.prettierignore` 排除了 Markdown 和 workflow；它不能代替文档链接检查。仓库没有专门的 Markdown/link checker，文档修改需检查 Markdown 链接和反引号中的文档路径，并搜索脚本、代码、workflow 对旧路径的引用。

## 浏览器验收

准备可用的 Node 全局 WebSocket、Cargo、字体和 Chromium 后：

```bash
npm run verify:browser
# 只运行相关套件（仍会准备夹具）
ONLY=writing-blocks-visual.mjs,writing-stability.mjs npm run verify:browser
# 自行指定浏览器或避开已有端口
CHROME_PATH=/path/to/chromium PORT=1430 CDP_PORT=9336 npm run verify:browser
```

以上环境变量语法用于 POSIX shell。运行器 `scripts/browser-check/run-all.mjs` 启动服务、连接或启动 Chromium、导出夹具、运行套件并汇总，默认 Vite 1425 / CDP 9335，避开桌面开发端口 1420。产物在 `.browser-check/`；它只清理自己启动的进程。`SKIP_DEV=1` 可复用服务；`SKIP_FIXTURES=1` 只在确认夹具与当前代码一致时使用。

单独运行脚本时自行准备服务、CDP 和夹具，通过 `BROWSER_CHECK_PORT` 或完整 `BROWSER_CHECK_URL` 指定页面，通过 `CDP_PORT` 指定浏览器。`run-all` 的服务端口变量是 `PORT`，不要与单套件变量混淆。

| 套件（位于 `scripts/browser-check/`） | 证明的行为 |
| --- | --- |
| `wysiwyg.mjs` | 公式与标记、菜单快捷键、恢复、缩放、字体、诊断和更新 UI；不证明真实编译 |
| `writing-blocks.mjs` | 假切片下的编辑、选择、导航、补渲、输入法、模式往返 |
| `writing-blocks-visual.mjs` | 真实产物的复杂块裁剪几何与链接热区；正文是否保留文本也要断言 |
| `writing-blocks-hit.mjs` | 真实探针的点击到字符映射与 geometryId 校验 |
| `writing-mode-scenes.mjs` | 标题、中文、列表、公式、表格、默认段距、连续空行与文末输入等场景的真实呈现及截图；防空数组假绿 |
| `wysiwyg-visual.mjs` | 真实公式的基线、pt 尺寸、居中、暗色与墨迹边界 |
| `writing-stability.mjs` | 点击/键盘进入公式与复杂块、模式往返、过期命中、调度、输入法与逐帧几何 |
| `computed-style.mjs` | 作用域 box-sizing、窄视口溢出、CSS 源序与原有 content-box 边界 |

## 真实夹具与覆盖边界

`npm run fixtures:blocks` / `npm run fixtures:math` 从 Rust 的 ignored 探针提取真实产物。Cargo 必须在 PATH 上；过滤器未命中任何用例仍可能返回成功，因此生成器和消费者必须在空夹具/空探针时硬失败，不能跑零次断言而报告通过。公式夹具注入桩时须补 `{ ok: true, ...fixture }`。

块几何验收比较相邻带、纵向位置与比例，不能只检查 widget 存在；直接可编辑正文已经不是切片，不应强求每篇/每块都有 SVG。复杂块集合必须有非零断言下界。公式验收使用多字号真实产物，核对 pt × 4/3 的 CSS 尺寸、行内基线（误差小于 1px）与墨迹范围。

动态稳定性输出在 `.browser-check/writing-stability.json`。每条测量标明 `real-static` 或 `fake`；桩不能提供真实动态重编译 `real-dynamic`，应把它列为未覆盖而非通过。当前点击/模式切换的逐帧最大锚点漂移判据为 8px；改阈值必须给出几何证据，不能靠扩大容忍度掩盖回归。行盒与文字盒的固定差异可解释稳态偏移，不能与意外滚动混为一谈。高 widget 中下部点击与无滚动余量是单独边界，详见[公式与揭示](wysiwyg.md)。

浏览器开发模式的文件系统、IPC、下载与安装均为桩。真文件写盘/PDF、原生确认标题与警告图标、窗口 ACL/焦点/会话隔离、WebView 缩放和更新验签安装需桌面验证。修改设置字段后逐个点控件保存，核对页面配置、应用设置、恢复和持久化快照；单测字段清单不能证明全部接线。

## 断言与隔离纪律

- 先在未修复行为上建立可复现的失败，再验证修复；动态竞态用可控回调或排队放行，不能靠短 sleep 碰运气。
- 合并请求的计数断言同时给上下界，并证明输入确实改变；“重建/重编译”要观察新戳或计数，DOM 没变不能证明后台工作发生。
- 浏览器只读观测入口由 `src/lib/dev/editor-test-hook.ts`、`write-test-hook.ts` 提供，仅在开发桩启用。不要依赖 CodeMirror 私有 DOM 属性取得 EditorView。
- `HIT_CACHE` 是进程级共享状态。并行 Rust 用例凡读写它都先取得 `hit_cache_guard()`；只执行单个 ignored 探针不构成免锁先例。纯 `pick_hit` 与不写缓存的 `probe_blocks` 可独立测试。
- jsdom 的默认光标位于 0，可能自动展开构造；测试隐藏时把光标放在构造外。判断源码/切片用真实文本行结构，不能只查 `textContent`，SVG 也可能有文本节点。
- 浏览器段落间显式重设视口、模式和存储；CDP 设备模拟跨导航保留。逐帧采样有时间和帧数上限、独立 token，排除动作前的无关帧。
- 不恢复只验证 `.typ` 后缀、日志透传或重复收边的低价值测试；路径安全在 Rust 验证，交互风险用对应层的行为证据覆盖。

失败复现、真实文档探针和 WebView 日志见[排障](debugging.md)。
