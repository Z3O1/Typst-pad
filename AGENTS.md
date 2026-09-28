# Coding agent 指南

Typst-pad 是本地 Typst 桌面编辑器：SvelteKit 静态 SPA + TypeScript / CodeMirror 6 前端，Tauri 2 / Rust 内嵌 Typst 编译后端。正文和注释以中文为主。产品入口见 [README](README.md)，详细知识见 [docs](docs/README.md)。

## 目录与边界

- `src/routes/`：页面状态、应用装配和生命周期。
- `src/lib/core/`：领域逻辑、引擎包装、依赖注入的流程；不反向依赖 editor/ui/dev。
- `src/lib/editor/`：CodeMirror 源码视图、输入与展开高亮；`src/lib/ui/`：界面组件与展示模型。
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

## 实现原则

- 源码是文档真相；编辑、撤销、保存与会话恢复保持一致，不引入隐式写盘。
- 文档模式展示 Typst 的完整编译结果；源码展开也交给 Typst 排版，光标单独叠加；过期结果不能回写当前文档或新会话。
- 保留原生路径与权限校验；浏览器桩不能代替真实后端验证。具体契约见下方对应文档。

## 按任务导航

只阅读本次任务相关页面，无需每次遍历所有文档。

| 修改领域 | 参考 |
| --- | --- |
| 分层、页面、窗口、快捷键与缩放 | [架构与前端](docs/development/architecture.md) |
| 编译、诊断、字体与包 | [编译后端](docs/development/compiler-backend.md) |
| 完整页面、调度、坐标、光标与源码展开 | [整页渲染与交互](docs/development/writing-rendering.md) |
| 打开保存、会话、权限与路径 | [文件与安全](docs/development/files-and-security.md) |
| 环境、验证与排障 | [开发与验证](docs/development/testing.md) |
| CI、打包、发布与更新 | [发布与更新](docs/maintainers/release.md) |

## 文档修改

- 用户可见行为、接口契约、开发命令或工作流程变化时，同步修改对应文档；行为不变的内部重构无需新增说明。
- 优先更新上表中的现有页面，每个主题保留一个权威说明。相近内容合并，失效内容删除；只有现有页面无法容纳的独立主题才新增文档。
- `README.md` 保留产品入口与简要用法，`AGENTS.md` 保留操作指引与导航，`docs/` 说明当前使用、实现与维护流程；版本历史交给 `CHANGELOG.md`，新增版本段仍需发布授权。
- 以当前代码和配置核实内容，避免重复实现细节、堆叠不变量、记录一次性排障过程或保留废弃方案。历史通过 Git 查询。
- 合并、重命名或删除文档时，同步更新索引与所有引用；检查相对链接、锚点、旧路径残留和 diff。纯文档修改无需启动应用或打开窗口。

## Git 操作

- 开始前查看当前分支和工作区状态，保留已有修改；只暂存和提交本次任务的文件，不覆盖或回滚他人的工作。
- 大修或跨模块重构前先建立工作分支；若已在适合本次任务的工作分支上，可继续使用。普通小改动按任务需要决定是否另建分支。
- 按任务需要提交、推送和创建 Pull Request；提交前完成与改动对应的检查。遇到冲突或检查失败时先查明原因，不通过跳过检查或改写历史掩盖问题。
- 未经明确授权，不执行 `reset --hard`、清理他人文件、强制推送、删除远端分支或修改仓库设置。

## 外部操作与发布权限

- 版本变更、CHANGELOG 新版本段、tag、创建或发布 Release，必须有用户明确的发布版本授权；普通重构和审查不包含发版。获得授权后按[发布流程](docs/maintainers/release.md)完成资产检查和发布，无需为已授权步骤重复询问。
- 不擅自替换或删除更新签名密钥，不改变仓库可见性、分支保护、remote 或 force push 来绕过限制。不可逆操作或仓库设置变更须有明确授权。
- 清理只涉及自己创建的文件与进程；保留他人的工作。不要为等待外部 workflow 持续轮询或阻塞当前任务，按实际已完成状态汇报。
