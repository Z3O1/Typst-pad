// 字体相关命令：默认族列表 / 打包字体字节（raw IPC）/ 可用族列举。
use crate::compile_commands::{in_compile_channel, CompileState};

/// 返回内置的默认字体族列表（设置里「默认」选项的兜底链）。
/// 前端拿它拼「用户选中项 + 其余默认项」——保证改了正文字体后，生僻字仍由其余字体接住
/// （打包的思源宋体是子集）。列表定义只此一处，避免前后端各写一份走样。
#[tauri::command]
pub fn default_font_families() -> Vec<String> {
    crate::typst_world::DEFAULT_FONT_FAMILIES
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// 打包字体的原始字节（**写作模式的源码透镜要装上同一套字**，见 `typst_world::EDITOR_FONT_FILES`）。
///
/// 为什么不让前端直接读资源目录：没有 fs 插件；而且这份字体本来就随应用分发（`fonts/` 是
/// `bundle.resources` 的一项），从 Rust 读出来交给 webview **不增加安装包体积**。
/// 参数只认白名单里的文件名（防路径穿越）；返回 `tauri::ipc::Response` = raw IPC，
/// 前端拿到的是 ArrayBuffer，不必把 1.3MB 的字体摊成 JSON 数组（那样慢一个数量级）。
#[tauri::command]
pub fn bundled_font(app: tauri::AppHandle, name: String) -> Result<tauri::ipc::Response, String> {
    let dir = crate::typst_world::resolve_fonts_dir(&app);
    crate::typst_world::read_editor_font(&dir, &name).map(tauri::ipc::Response::new)
}

/// 列出可用字体族（设置里「中文字体」下拉的数据源）：打包字体 + 系统字体 + 额外目录。
/// 选项来自真实注册的字体，因此用户选不出不存在的族名——写错族名的后果是 typst 只发
/// warning 然后**静默回退到楷体**，正是"改了字体没用"的根源。
#[tauri::command]
pub async fn list_font_families(
    state: tauri::State<'_, CompileState>,
    font_dirs: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    // 这个命令不需要注入字体族（只借通道拿锁 + 用额外目录），所以 families 传空 vec
    let out = in_compile_channel(
        &state,
        Some(Vec::new()),
        font_dirs,
        move |fonts_dir, fonts| crate::typst_world::list_font_families(fonts_dir, &fonts.dirs),
    )
    .await
    .unwrap_or_default();
    Ok(out)
}
