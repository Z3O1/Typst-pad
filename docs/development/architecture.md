# 架构

[返回文档索引](../README.md)

## 层次与依赖方向

应用是 SvelteKit 静态 SPA，由 Tauri 承载，CodeMirror 管理编辑状态，Rust 进程内 Typst 负责排版。前端没有 Typst wasm 编译链路；包下载与更新检查是独立的网络能力。

| 位置 | 职责与边界 |
| --- | --- |
| `src/routes/` | 页面持有响应式状态，装配依赖和生命周期；不把领域算法持续堆进页面 |
| `src/lib/core/` | 文档会话、编译调度/产物状态、段落间距扫描等纯模型与原生能力包装；不 import editor/ui/dev |
| `src/lib/editor/` | Editor、CodeMirror 扩展、输入语义、公式队列；依赖 core |
| `src/lib/ui/` | 菜单、弹窗、预览、状态栏及展示模型；依赖 core |
| `src/lib/dev/` | 浏览器桩与只读测试钩子，仅开发链路加载，不被生产模块引入 |
| `src-tauri/src/lib.rs` | 插件、setup、IPC 注册与应用事件装配 |
| `src-tauri/src/*_commands.rs` | 文件、字体、编译等原生命令与状态 |
| `src-tauri/src/typst_world/` | World、字体、项目路径、诊断、SVG/公式/PDF |
| `src-tauri/src/block_geometry/` | 源块划分、帧几何、裁剪、命中与探针 |
| `src-tauri/src/packages.rs` | 包解析、下载缓存与安全解压 |

流程拆分采用依赖注入：例如 `document-session` 接收读写与确认回调，便于测试业务决策，不反向依赖 Svelte 页面。`editor/math-queue.ts` 归编辑器层，不因它可单测就放入 core。

## 数据流

源码编辑 → 页面同步文档与受控镜像 → 编译调度 → `core/typst-engine.ts` 包装 IPC → Rust 编译通道 → 带诊断的结果 → 预览与编辑器装饰。

写作模式把持续可编辑文字、公式装饰与复杂块切片组合呈现，详见[写作渲染](writing-rendering.md)；源码模式显示原文与整页预览。源码是唯一编辑真相，不从 SVG 反推文档结构。

编译产物、CodeMirror 文本与磁盘内容有不同生命周期。编译不能写回源码；会话恢复不能冒充显式保存。文件流程与窗口隔离见[文件与安全](files-and-security.md)。

## 配置与资源

- `svelte.config.js` 与 `src/routes/+layout.ts` 配置静态 SPA；`vite.config.js` 管开发服务器和 WebView 兼容处理。
- `vitest.config.ts` 管前端与脚本测试；格式规则见 `.editorconfig`、`.prettierrc.json`，Rust 使用默认 rustfmt。
- `src-tauri/tauri.conf.json` 管桌面打包、字体资源与更新配置；`src-tauri/capabilities/` 管窗口和插件权限。
- 打包字体的权威清单在 `scripts/download-fonts.mjs` 与资源配置；技术约束见[编译后端](compiler-backend.md)。
- `src-tauri/app-icon.svg` 是图标源。修改后运行 `npm run tauri icon src-tauri/app-icon.svg` 生成桌面图标，favicon 同源导出；清理生成的移动端目录。已安装应用需重装才能看到嵌入可执行文件的新图标。
- `.browser-check/` 是被忽略的验收产物目录；`.github/workflows/` 职责见 [CI](../maintainers/ci.md)。

按具体任务继续阅读[前端](frontend.md)、[编译后端](compiler-backend.md)、[所见即所得](wysiwyg.md)与[测试](testing.md)，无需维护一份逐文件复制的模块清单。
