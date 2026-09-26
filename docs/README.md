# 文档索引

文档描述当前仓库。安装包的历史行为以 [CHANGELOG](../CHANGELOG.md) 为准，实际版本与依赖以项目配置和锁文件为准。

## 用户

| 文档 | 内容 |
| --- | --- |
| [安装与更新](user/installation.md) | 平台、下载、升级 |
| [入门](user/getting-started.md) | 写第一份文档、保存、导出、会话 |
| [编辑模式](user/editing-modes.md) | 写作与源码模式、预览、格式操作 |
| [快捷键](user/shortcuts.md) | 键盘操作速查 |
| [字体与包](user/fonts-and-packages.md) | 选择字体、导入与离线使用 |
| [限制与排障](user/troubleshooting.md) | 呈现缺口、文件/字体/更新问题 |

## 开发者

从[贡献指南](../CONTRIBUTING.md)开始；coding agent 另读 [AGENTS](../AGENTS.md)。

| 文档 | 内容 |
| --- | --- |
| [开发设置](development/setup.md) | 依赖、启动、构建 |
| [架构](development/architecture.md) | 层次、数据流、代码归属 |
| [前端](development/frontend.md) | 页面、窗口、输入、布局与缩放 |
| [编译后端](development/compiler-backend.md) | IPC、诊断、项目根、字体与包实现 |
| [写作渲染](development/writing-rendering.md) | 文本/切片、调度、坐标与交互 |
| [可编辑子集](development/writable-subset.md) | 直接编辑资格、文字对应证明、行内原子与结构化编辑设计 |
| [所见即所得](development/wysiwyg.md) | 标记识别、公式、装饰与揭示 |
| [文件与安全](development/files-and-security.md) | 写盘、会话、原生路径与权限 |
| [测试](development/testing.md) | 验证选择、命令、证据与覆盖边界 |
| [排障](development/debugging.md) | 日志、WebView、浏览器夹具 |

## 维护者

- [CI](maintainers/ci.md)：流水线职责与缓存。
- [发布](maintainers/release.md)：版本、签名、资产与匿名验收。
- [更新器](maintainers/updater.md)：客户端状态机、协议与故障定位。

## 设计与研究

- [渲染模型](design/rendering-model.md)：真实排版与可编辑文本的取舍。
- [编辑设计与研究](design/wysiwyg-research.md)：源码映射边界和未实施方案。
- [结构化编辑设计](design/structured-editing.md)：行内原子与表格/图片/图注/引用的可改子集与拆分。

## 维护文档

一个概念只维护一个权威位置：产品定位在根 README，agent 执行规则在 AGENTS，当前实现分领域放在 development，操作性发布流程在 maintainers/release，长期决策在 design，版本历史在 CHANGELOG。其他页面可以给面向读者的摘要，并链接详情，不复制算法、规则清单或命令矩阵。

新文档使用中文正文与 ASCII kebab-case 路径。相近短主题优先合并。修改实现时更新所属页面及必要导航；不要记录“当前测试 N 项”、当前版本快照、个人机器参数或一次性交接过程。旧实现与开发过程通过 Git history / PR 查询，研究设想必须与已实现行为区分。
