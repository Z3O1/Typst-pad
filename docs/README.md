# 文档索引

实现说明以当前行为为准；评估与演进建议明确标注为未实现，不作为现有能力承诺。旧排版方案与开发过程通过 Git 历史查询，版本历史见 [CHANGELOG](../CHANGELOG.md)。

- [使用指南](user/guide.md)：安装、整页编辑、保存、会话、字体、包和常见问题。
- [快捷键](user/shortcuts.md)：键盘操作。
- [架构与前端](development/architecture.md)：分层、源码编辑、页面状态、菜单与缩放。
- [整页渲染与交互](development/writing-rendering.md)：完整编译产物、定位、展开、调度和作废；[可行性与扩展评估](development/writing-rendering.md#可行性与扩展评估)总结实现边界、性能实验与未实现的演进方向。
- [编译后端](development/compiler-backend.md)：IPC、诊断、字体和包。
- [文件与安全](development/files-and-security.md)：保存、恢复、窗口、权限和路径。
- [开发与验证](development/testing.md)：环境、CI 检查、无头浏览器和排障。
- [发布与更新](maintainers/release.md)：签名、CI、Release、更新器和资产校验。

贡献流程见 [CONTRIBUTING](../CONTRIBUTING.md)，agent 操作约束见 [AGENTS](../AGENTS.md)。
