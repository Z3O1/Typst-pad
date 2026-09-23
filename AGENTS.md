# Coding agent 指南

Typst-pad 是本地 Typst 桌面编辑器：SvelteKit 静态 SPA + TypeScript / CodeMirror 6 前端，Tauri 2 / Rust 内嵌 Typst 编译后端。正文和注释以中文为主。产品入口见 [README](README.md)，详细知识见 [docs](docs/README.md)。

## 目录与边界

- `src/routes/`：页面状态、应用装配和生命周期。
- `src/lib/core/`：领域逻辑、引擎包装、依赖注入的流程；不反向依赖 editor/ui/dev。
- `src/lib/editor/`：CodeMirror 视图、装饰、输入与公式队列；`src/lib/ui/`：界面组件与展示模型。
- `src/lib/dev/`：仅开发和验收使用的桩与观测钩子，不引入生产模块。
- `src-tauri/src/`：原生命令、编译世界、块几何、文件与包；`src-tauri/fonts/`：打包字体。
- `scripts/`：测试、浏览器验收、字体和发布工具；`.github/workflows/`：CI 与发布。

## 常用命令与验证选择

```bash
npm run tauri dev
npm run check
npm test -- <相关测试文件>
npm run format:check
cargo test --manifest-path src-tauri/Cargo.toml
npm run verify:browser
```

按改动风险选择检查，完整矩阵与 Rust 静态检查命令见[测试](docs/development/testing.md)：纯文档查链接与 diff；代码改动跑相关静态检查和单测，提交前完成对应 CI 门禁；编辑器、装饰、布局或组件样式加浏览器验证，原生能力还需桌面验证。不要仅为测试数量添加重复断言，不要移除既有 CI 门禁。

## 关键不变量

- 源码是文档真相，`editorDoc` 必须实时镜像编辑器；保存、会话恢复、窗口隔离遵循[文件与安全](docs/development/files-and-security.md)，不得引入隐式写盘。
- 装饰计算和 widget 异常不得逃逸进 CodeMirror 事务；非空替换/mark 范围合法，渲染不确定时保留源码。菜单不得夺走编辑位置。
- 编译产物必须匹配当前文档与排版输入；过期产物、命中和调度任务不能回写新会话。修改写作链路须遵循[写作渲染](docs/development/writing-rendering.md)的戳、窗口化、输入法与取消契约。
- Rust 路径校验不能绕过；成功与失败的 IPC 形状都要核对，浏览器桩不等于真实后端。
- 不把打包字体复制到 `static/`；开发启动兼容处理的变更须经目标 WebView 验证，见[排障](docs/development/debugging.md)。

## 按任务导航

只阅读本次任务相关页面，无需每次遍历所有文档。

| 修改领域 | 参考 |
| --- | --- |
| 分层、流程归属 | [架构](docs/development/architecture.md) |
| 页面、窗口、快捷键、缩放、组件样式 | [前端](docs/development/frontend.md) |
| 编译、诊断、字体、包 | [编译后端](docs/development/compiler-backend.md) |
| 块渲染、调度、坐标、命中 | [写作渲染](docs/development/writing-rendering.md) |
| 公式、标记、选区揭示 | [所见即所得](docs/development/wysiwyg.md) |
| 打开保存、会话、权限与路径 | [文件与安全](docs/development/files-and-security.md) |
| 测试或复现 | [测试](docs/development/testing.md)、[排障](docs/development/debugging.md) |
| CI、打包、发布、更新 | [CI](docs/maintainers/ci.md)、[发布](docs/maintainers/release.md)、[更新器](docs/maintainers/updater.md) |
| 渲染取舍或新交互设计 | [渲染模型](docs/design/rendering-model.md)、[编辑设计与研究](docs/design/wysiwyg-research.md) |

## 外部操作与发布权限

- 版本变更、CHANGELOG 新版本段、tag、创建或发布 Release，必须有用户明确的发布版本授权；普通重构和审查不包含发版。获得授权后按[发布流程](docs/maintainers/release.md)完成资产检查和发布，无需为已授权步骤重复询问。
- 不擅自替换或删除更新签名密钥，不改变仓库可见性、分支保护、remote 或 force push 来绕过限制。不可逆操作或仓库设置变更须有明确授权。
- 清理只涉及自己创建的文件与进程；保留他人的工作。不要为等待外部 workflow 持续轮询或阻塞当前任务，按实际已完成状态汇报。
