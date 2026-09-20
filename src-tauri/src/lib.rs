// Tauri 后端：窗口 + 文件读写命令 + 文件打开（关联双击/启动参数/拖放）+ 内嵌 typst 编译。
//
// 这个文件只留**模块声明 + 应用装配**（插件、setup、IPC 命令表、事件循环）。各命令按关注点分在：
//   - `file_commands`    —— 读/写文件、待打开队列（含首次启动参数解析）
//   - `dir_listing`      —— 递归列 `.typ`
//   - `compile_commands` —— 编译/导出/点击定位 + **编译通道**（一把互斥锁 + spawn_blocking）
//   - `font_commands`    —— 默认族 / 打包字体字节 / 可用族列举
//   - `paths`            —— 路径安全校验（唯一闸门）
//   - `packages` / `typst_world` / `block_geometry` —— 包系统、编译世界、块级几何
use tauri::Manager;

mod packages;
mod typst_world;

// 源块 ↔ 版面区域的几何映射 + 写作模式的块级渲染（见 docs/文档模式渲染保真-调研.md）。
// 阶段 0 的探针函数只有测试在用，故整体允许"未使用"告警。
#[allow(dead_code)]
mod block_geometry;

mod compile_commands;
mod dir_listing;
mod file_commands;
mod font_commands;
mod paths;

// 启动时序打点：仅 debug 构建编译（release 零输出零开销）
#[cfg(debug_assertions)]
mod startup_timing;

/// 命令行 --debug 开关（调试日志来源之一，仅桌面构建生效）：setup 解析命令行后存入，
/// 前端经 get_debug_flag 命令异步查询
struct CliDebugFlag(bool);

/// 查询命令行 --debug 开关（支持 `--debug` 与 `--debug=1` 两种写法，其余值宽松视为未开启）
#[tauri::command]
fn get_debug_flag(state: tauri::State<'_, CliDebugFlag>) -> bool {
    state.0
}

/// 禁用 WebView2 浏览器加速键（如 Ctrl+R 整页刷新）：
/// WebView2 中加速键在 web 内容之前处理，页面 JS 的 preventDefault 无法拦截，
/// 必须在此禁用，让 Ctrl+R 等快捷键完全交由前端处理
struct DisableBrowserAccelerators;

impl tauri::plugin::Plugin<tauri::Wry> for DisableBrowserAccelerators {
    fn name(&self) -> &'static str {
        "disable-browser-accelerators"
    }

    fn webview_created(&mut self, webview: tauri::Webview<tauri::Wry>) {
        // 打点：webview 初始化完成（此处仅原生 webview 就绪，页面 HTML/JS 尚未加载）
        #[cfg(debug_assertions)]
        startup_timing::set_webview_created();
        #[cfg(target_os = "windows")]
        {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
            use windows_core::Interface;
            // 闭包要求 Send + 'static：只借用入参、不捕获外部可变状态
            let _ = webview.with_webview(|pw| {
                let core = unsafe { pw.controller().CoreWebView2() }.ok();
                if let Some(core) = core {
                    let settings = unsafe { core.Settings() }.ok();
                    if let Some(s3) = settings.and_then(|s| s.cast::<ICoreWebView2Settings3>().ok())
                    {
                        let _ = unsafe { s3.SetAreBrowserAcceleratorKeysEnabled(false) };
                    }
                }
            });
        }
        #[cfg(not(target_os = "windows"))]
        let _ = webview;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 窗口大小/位置/最大化状态记忆（tauri-plugin-window-state）：关闭时保存、启动时恢复
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 禁用浏览器加速键（Ctrl+R 不再触发整页刷新），放在 opener 之后注册
        .plugin(DisableBrowserAccelerators)
        .plugin(tauri_plugin_dialog::init())
        // 自动更新（tauri-plugin-updater）：检查更新 / 下载 / 安装新版本。
        // 端点与签名公钥在 tauri.conf.json 的 plugins.updater（前端权限见 capabilities/default.json
        // 的 updater:default）；更新包的签名校验在 Rust 侧完成，前端拿不到也改不了公钥。
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 注意：不使用 single-instance——每次启动都打开独立实例/新窗口
        .setup(|app| {
            // 打点：setup 入口（窗口创建阶段起点）
            #[cfg(debug_assertions)]
            startup_timing::set_setup_entry();
            // --debug 命令行开关（调试日志来源之一，仅桌面构建生效）：支持 --debug 与
            // --debug=1 两种写法，其余值宽松视为未开启；前端经 get_debug_flag 命令查询
            let cli_debug = std::env::args().any(|a| a == "--debug" || a == "--debug=1");
            app.manage(CliDebugFlag(cli_debug));
            // 首次启动：从命令行参数解析待打开的 .typ 文件
            app.manage(file_commands::initial_pending_files());
            // 内嵌编译状态：字体目录（打包后为 resource_dir/fonts，开发回退 src-tauri/fonts）
            app.manage(compile_commands::CompileState::new(
                typst_world::resolve_fonts_dir(app.handle()),
            ));
            Ok(())
        })
        // **命令表就是 IPC 契约**：增删/改名任何一个 `#[tauri::command]` 都必须同步这里；
        // 漏了不会编译报错，只会在真机上"前端调用没有这个命令"（见 docs/实现细则/02）。
        .invoke_handler(tauri::generate_handler![
            file_commands::read_file,
            file_commands::write_file,
            file_commands::take_pending_files,
            file_commands::write_binary,
            dir_listing::list_dir_typ,
            get_debug_flag,
            compile_commands::compile_doc,
            compile_commands::compile_blocks,
            compile_commands::block_hit_test,
            compile_commands::compile_math,
            compile_commands::export_pdf,
            font_commands::list_font_families,
            font_commands::default_font_families,
            font_commands::bundled_font
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // 打点：前端页面加载完成（RunEvent::Ready = 事件循环首次迭代）；
        // 以引用匹配避免消耗 event（后续 macOS 分支仍需要它）
        #[cfg(debug_assertions)]
        if let tauri::RunEvent::Ready = &event {
            startup_timing::set_ready_and_report();
        }
        // macOS：Finder"打开方式"通过 Apple Events 传路径（命令行参数拿不到）
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            if let Some(path) = urls
                .first()
                .and_then(|u| u.to_file_path().ok())
                .filter(|p| paths::is_typ_file(p))
                .map(|p| p.to_string_lossy().to_string())
            {
                file_commands::queue_open(app, path);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
