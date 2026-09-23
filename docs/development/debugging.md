# 开发排障

[返回文档索引](../README.md) · [用户排障](../user/troubleshooting.md)

## 先区分运行环境

`npm run tauri dev` 使用真实 Rust 后端和平台 WebView；修改前端会 HMR，修改 Rust 会重启桌面应用，复现时留意会话恢复和未保存内容。普通浏览器不是产品运行环境。开发时 `?browserdev=1` 加载假 IPC；真实排版需注入 Rust 夹具，见[测试](testing.md)。

状态栏的“脚本错误”来自 `window.onerror` / `unhandledrejection`。先复制诊断、记录模式/缩放/输入动作，最小化 `.typ` 内容；不要把浏览器桩不能复现理解成桌面问题不存在。`src/lib/core/debug.ts` 在 dev 默认记录日志，另支持 `--debug`、`?debug=1` 与 localStorage 开关，具体键名以模块为准。

`src/lib/core/startup-timing.ts` 在首次编译完成后输出 `[startup]` 汇总与 Navigation Timing；`src-tauri/src/startup_timing.rs` 仅 debug 构建输出 `[startup] rust phase:*`，对照窗口创建、WebView 就绪、前端加载与编译阶段定位启动退化。

## WebView 白屏与布局

`vite.config.js` 保留开发模块求值兼容处理：同步 wasm 初始化改写、`optimizeDeps.exclude` 和对依赖胶水内容形状的匹配。前端高亮已改用 Lezer，遗留 wasm 插件没有现行编译职责；删除兼容处理前仍应验证目标 WebKit 的开发启动，不能只靠 Chromium 成功。预构建不经过同一 transform，升级相关依赖时需要核对处理是否仍命中。

Linux/WSLg 图形栈失败时可用 `GDK_BACKEND=x11 GDK_GL=disable WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev` 诊断软件渲染路径。不要把任意 libEGL 提示直接当编译错误，也不要把某一机器的成功参数设成仓库统一要求。

Svelte 拆组件后页面局部 `* { box-sizing: border-box }` 不会作用于子组件，且 box-sizing 不继承。将原有规则迁入相关组件作用域，不要全局改变 Editor/MenuBar 的盒模型。使用 `getComputedStyle` 和窄视口测量确认，见[测试](testing.md)。页面 script 区的注释避免字面嵌入样式/脚本标签，以免工具按字符串识别边界后给出误导的未闭合错误。

## 浏览器与真实文档探针

`node scripts/browser-check/probe.mjs` 可在准备好开发服务和 CDP 后打印页面产物与错误。端口和运行器参数见[测试](testing.md)。Chromium 与服务必须从彼此可访问的地址通信；系统代理影响 localhost 时，可给测试浏览器加 `--no-proxy-server`。只关闭本次启动的进程，不按进程名全量结束浏览器。

对实际文档：

1. 将脱敏内容存为 `.browser-check/real-scene.typ`。
2. 运行 `cargo test --manifest-path src-tauri/Cargo.toml dump_real_doc_fixture -- --ignored --nocapture`。
3. 检查诊断、块几何与最后的 `BLOCKFIXTURE:` 行，将有效 JSON 作为数组存入 `.browser-check/block-fixtures.json`，再走对应场景/几何验收。不要把空结果当正常夹具。

浏览器复现常见陷阱：同 URL 导航未重载时先跳 `about:blank`；清存储前先离开旧页面，防其防抖存档再次写回；清完按 origin 的存储后重新加载；菜单查询限定下拉项；截图与诊断保存在工作区 `.browser-check/`。对比前显式重设 CDP 视口，避免上一套件留下的模拟状态。

## 按领域继续定位

- 诊断行号、项目根、字体不一致：[编译后端](compiler-backend.md)。
- 旧切片、错字命中、输入法与编译竞态：[写作渲染](writing-rendering.md)。
- 公式源码揭示、基线、墨迹裁剪：[所见即所得](wysiwyg.md)。
- 打开/保存/恢复与原生权限：[文件与安全](files-and-security.md)。
- 清单不可达、更新签名或安装：[更新器](../maintainers/updater.md)与[发布](../maintainers/release.md)。
