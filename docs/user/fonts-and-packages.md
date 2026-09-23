# 字体与包

[返回文档索引](../README.md)

## 字体

应用打包思源宋体、Libertinus Serif、New Computer Modern Math 和 DejaVu Sans Mono，可直接排版中文与公式。打包中文字体是子集，生僻字可能需要系统字体补充。

在「设置 → 正文字体」选择字体；额外字体目录可添加本地字体文件所在目录。应用会扫描打包、系统与额外目录，支持 TTF/OTF 和 TTC/OTC 字体集合。族名使用字体内部的英文名称，不一定等于系统设置中的中文显示名。

文档中的 `#set text(font: ...)` 优先于应用默认设置。设置应用于文档编译、独立公式与 PDF；独立公式只能取得有限文档上下文，详见[限制](troubleshooting.md)。状态栏出现 `unknown font family` 时检查族名和目录，而不是假设字体已成功切换。

字体管线、默认回退与新增打包字体的维护要求见[编译后端](../development/compiler-backend.md)。

## 本地引用与包

相对 `#import` / `#include` 以保存后的文档路径解析，可引用同一盘/卷中的上级目录；未保存文档需要先保存。跨盘/卷导入不受支持。

- `@local`：从 Typst 本地数据目录读取，包路径使用 `local/包名/版本/` 的层次。
- `@preview`：首次使用自动下载到共享缓存；已有缓存可离线使用。网络不可用或包版本不存在时显示诊断。
- `TYPST_PACKAGE_PATH` 与 `TYPST_PACKAGE_CACHE_PATH` 可覆盖数据和缓存根目录，值包含 namespace 层的父目录；需要在启动应用前设置。

包路径兼容 Typst CLI 的目录约定。缓存和路径安全实现见[编译后端](../development/compiler-backend.md)。
