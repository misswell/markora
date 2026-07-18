use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedDocument {
    path: String,
    title: String,
    contents: String,
}

#[derive(Default)]
struct PendingDocuments(Mutex<VecDeque<OpenedDocument>>);

#[derive(Default)]
struct OpenDocuments(Mutex<HashSet<PathBuf>>);

#[derive(Default)]
struct OpenWorkspaces(Mutex<HashSet<PathBuf>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    path: String,
    relative_path: String,
    title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    root: String,
    name: String,
    files: Vec<WorkspaceFile>,
}

fn markdown_dialog() -> rfd::FileDialog {
    rfd::FileDialog::new().add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "txt"])
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "mdown" | "mkd" | "txt"
            )
        })
        .unwrap_or(false)
}

fn scan_workspace(root: &Path) -> Result<Workspace, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("工作区路径不是文件夹".to_owned());
    }
    let mut pending = vec![root.clone()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        let entries = std::fs::read_dir(&directory).map_err(|error| error.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if !name.starts_with('.') && !matches!(name.as_ref(), "node_modules" | "target") {
                    pending.push(path);
                }
            } else if file_type.is_file() && is_markdown_path(&path) {
                let relative = path.strip_prefix(&root).unwrap_or(&path);
                files.push(WorkspaceFile {
                    path: path.to_string_lossy().into_owned(),
                    relative_path: relative.to_string_lossy().into_owned(),
                    title: path
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or("未命名文稿")
                        .to_owned(),
                });
                if files.len() >= 10_000 {
                    return Err("工作区包含超过 10000 个文稿，请选择更小的文件夹".to_owned());
                }
            }
        }
    }
    files.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("工作区")
        .to_owned();
    Ok(Workspace {
        root: root.to_string_lossy().into_owned(),
        name,
        files,
    })
}

fn document_from_path(path: PathBuf) -> Result<OpenedDocument, String> {
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let contents = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名文稿")
        .to_owned();
    Ok(OpenedDocument {
        path: path.to_string_lossy().into_owned(),
        title,
        contents,
    })
}

const EXTERNAL_DOCUMENT_CHANGED: &str = "EXTERNAL_DOCUMENT_CHANGED";

fn ensure_document_revision(
    path: &Path,
    expected_contents: Option<&str>,
    force: bool,
) -> Result<(), String> {
    if force {
        return Ok(());
    }
    let current =
        std::fs::read_to_string(path).map_err(|_| EXTERNAL_DOCUMENT_CHANGED.to_owned())?;
    if expected_contents != Some(current.as_str()) {
        return Err(EXTERNAL_DOCUMENT_CHANGED.to_owned());
    }
    Ok(())
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "文件没有父目录".to_owned())?;
    let mut temporary = None;
    for attempt in 0..100 {
        let candidate = parent.join(format!(".typedown-{}-{attempt}.tmp", std::process::id()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let (temporary_path, mut file) = temporary.ok_or_else(|| "无法创建临时保存文件".to_owned())?;
    let result = (|| {
        file.write_all(contents.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        #[cfg(target_os = "windows")]
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        std::fs::rename(&temporary_path, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

fn publish_document(app: &tauri::AppHandle, document: OpenedDocument) {
    register_document(app, &document.path);
    add_recent(app, &document.path);
    if let Ok(mut pending) = app.state::<PendingDocuments>().0.lock() {
        pending.push_back(document.clone());
    }
    let _ = app.emit("open-document", document);
}

fn register_document(app: &tauri::AppHandle, path: &str) {
    let Ok(path) = PathBuf::from(path).canonicalize() else {
        return;
    };
    if let Ok(mut documents) = app.state::<OpenDocuments>().0.lock() {
        documents.insert(path);
    }
}

#[tauri::command]
async fn open_markdown(app: tauri::AppHandle) -> Result<Option<OpenedDocument>, String> {
    let document = tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = markdown_dialog().pick_file() else {
            return Ok(None);
        };
        document_from_path(path).map(Some)
    })
    .await
    .map_err(|error| error.to_string())??;
    if let Some(document) = &document {
        register_document(&app, &document.path);
        add_recent(&app, &document.path);
    }
    Ok(document)
}

#[tauri::command]
fn take_pending_documents(state: tauri::State<'_, PendingDocuments>) -> Vec<OpenedDocument> {
    state
        .0
        .lock()
        .map(|mut documents| documents.drain(..).collect())
        .unwrap_or_default()
}

#[tauri::command]
async fn open_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, OpenWorkspaces>,
) -> Result<Option<Workspace>, String> {
    let Some(root) = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let workspace = scan_workspace(&root)?;
    let canonical_root = PathBuf::from(&workspace.root);
    state
        .0
        .lock()
        .map_err(|_| "无法登记工作区".to_owned())?
        .insert(canonical_root);
    let _ = app.emit("workspace-opened", workspace.clone());
    Ok(Some(workspace))
}

#[tauri::command]
fn refresh_workspace(
    root: String,
    state: tauri::State<'_, OpenWorkspaces>,
) -> Result<Workspace, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let is_open = state
        .0
        .lock()
        .map(|workspaces| workspaces.contains(&root))
        .unwrap_or(false);
    if !is_open {
        return Err("工作区尚未由 Markora 打开".to_owned());
    }
    scan_workspace(&root)
}

#[tauri::command]
fn read_workspace_document(
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, OpenWorkspaces>,
) -> Result<OpenedDocument, String> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let allowed = state
        .0
        .lock()
        .map(|workspaces| workspaces.iter().any(|root| path.starts_with(root)))
        .unwrap_or(false);
    if !allowed || !is_markdown_path(&path) {
        return Err("文稿不在已打开的工作区内".to_owned());
    }
    let document = document_from_path(path)?;
    register_document(&app, &document.path);
    add_recent(&app, &document.path);
    Ok(document)
}

#[tauri::command]
fn read_external_document(
    path: String,
    state: tauri::State<'_, OpenDocuments>,
) -> Result<String, String> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let allowed = state
        .0
        .lock()
        .map(|documents| documents.contains(&path))
        .unwrap_or(false);
    if !allowed {
        return Err("文稿尚未由 Markora 打开".to_owned());
    }
    std::fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_markdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, OpenDocuments>,
    path: Option<String>,
    suggested_name: String,
    contents: String,
    expected_contents: Option<String>,
    force: bool,
) -> Result<Option<String>, String> {
    let registered_path = if let Some(path) = &path {
        let requested = PathBuf::from(path);
        if !requested.is_absolute() {
            return Err("只能保存由 Markora 打开的文稿".to_owned());
        }
        let resolved = requested.canonicalize().unwrap_or(requested);
        let allowed = state
            .0
            .lock()
            .map(|documents| documents.contains(&resolved))
            .unwrap_or(false);
        if !allowed {
            return Err("只能保存由 Markora 打开的文稿".to_owned());
        }
        Some(resolved)
    } else {
        None
    };
    let saved_path =
        tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
            let target = match registered_path {
                Some(path) => {
                    ensure_document_revision(&path, expected_contents.as_deref(), force)?;
                    path
                }
                None => {
                    let safe_name = suggested_name
                        .chars()
                        .map(|character| match character {
                            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
                            value => value,
                        })
                        .collect::<String>();
                    let file_name = if safe_name.ends_with(".md") {
                        safe_name
                    } else {
                        format!("{safe_name}.md")
                    };
                    let Some(path) = markdown_dialog().set_file_name(file_name).save_file() else {
                        return Ok(None);
                    };
                    path
                }
            };

            atomic_write(&target, &contents)?;
            let target = target.canonicalize().map_err(|error| error.to_string())?;
            Ok(Some(target.to_string_lossy().into_owned()))
        })
        .await
        .map_err(|error| error.to_string())??;
    if let Some(path) = &saved_path {
        register_document(&app, path);
        add_recent(&app, path);
    }
    Ok(saved_path)
}

#[tauri::command]
fn authorize_local_image(
    app: tauri::AppHandle,
    document_path: String,
    source: String,
) -> Result<String, String> {
    let document = PathBuf::from(&document_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let is_open = app
        .state::<OpenDocuments>()
        .0
        .lock()
        .map(|documents| documents.contains(&document))
        .unwrap_or(false);
    if !is_open {
        return Err("文稿尚未由 Markora 打开".to_owned());
    }
    let path = resolve_local_image(&document_path, &source)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn resolve_local_image(document_path: &str, source: &str) -> Result<PathBuf, String> {
    let document = PathBuf::from(document_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let directory = document
        .parent()
        .ok_or_else(|| "文稿没有父目录".to_owned())?;
    let source_without_suffix = source.split(['?', '#']).next().unwrap_or(&source);
    let requested = if source_without_suffix.starts_with("file:") {
        tauri::Url::parse(source_without_suffix)
            .map_err(|error| error.to_string())?
            .to_file_path()
            .map_err(|_| "无效的本地图片 URL".to_owned())?
    } else {
        let path = PathBuf::from(source_without_suffix);
        if path.is_absolute() {
            path
        } else {
            directory.join(path)
        }
    };
    let path = requested
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.starts_with(directory) {
        return Err("图片路径超出当前文稿目录".to_owned());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    const IMAGE_EXTENSIONS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "heif",
    ];
    if !path.is_file() || !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("路径不是受支持的图片文件".to_owned());
    }
    Ok(path)
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let parent = Path::new(&path)
        .parent()
        .ok_or_else(|| "文件没有父目录".to_owned())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(parent)
        .spawn()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(parent)
        .spawn()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(parent)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

// === 原生菜单栏 ===

#[derive(Default)]
struct RecentDocuments(Mutex<VecDeque<String>>);

#[derive(Default)]
struct RecentMenu(Mutex<Option<Submenu<tauri::Wry>>>);

#[derive(Default)]
struct RecentItems(Mutex<Vec<MenuItem<tauri::Wry>>>);

#[derive(Default)]
struct ThemeChecks(Mutex<HashMap<String, CheckMenuItem<tauri::Wry>>>);

fn menu_item<M: tauri::Manager<R>, R: tauri::Runtime>(
    app: &M,
    id: &str,
    text: &str,
    accel: Option<&str>,
) -> MenuItem<R> {
    // 若快捷键字符串无法解析，降级为不带快捷键的菜单项，避免启动失败。
    if let Some(accelerator) = accel {
        if let Ok(item) = MenuItem::with_id(app, id, text, true, Some(accelerator)) {
            return item;
        }
    }
    MenuItem::with_id(app, id, text, true, None::<&str>).expect("failed to build menu item")
}

fn check_item<M: tauri::Manager<R>, R: tauri::Runtime>(
    app: &M,
    id: &str,
    text: &str,
    checked: bool,
) -> CheckMenuItem<R> {
    CheckMenuItemBuilder::with_id(id, text)
        .checked(checked)
        .build(app)
        .expect("failed to build check menu item")
}

fn sep<M: tauri::Manager<R>, R: tauri::Runtime>(app: &M) -> PredefinedMenuItem<R> {
    PredefinedMenuItem::separator(app).expect("failed to build separator")
}

fn recent_store_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("recent.json"))
}

fn load_recent(app: &tauri::AppHandle) -> VecDeque<String> {
    let Some(path) = recent_store_path(app) else {
        return VecDeque::new();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return VecDeque::new();
    };
    contents
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

fn save_recent(app: &tauri::AppHandle, paths: &VecDeque<String>) {
    let Some(path) = recent_store_path(app) else {
        return;
    };
    let body = paths.iter().cloned().collect::<Vec<_>>().join("\n");
    let _ = std::fs::write(path, body);
}

fn add_recent(app: &tauri::AppHandle, path: &str) {
    let normalized = PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    let normalized = normalized.to_string_lossy().into_owned();
    let snapshot = if let Ok(mut guard) = app.state::<RecentDocuments>().0.lock() {
        guard.retain(|item| item != &normalized);
        guard.push_front(normalized);
        while guard.len() > 10 {
            guard.pop_back();
        }
        guard.clone()
    } else {
        return;
    };
    save_recent(app, &snapshot);
    rebuild_recent_submenu(app);
}

fn rebuild_recent_submenu(app: &tauri::AppHandle) {
    let paths: Vec<String> = match app.state::<RecentDocuments>().0.lock() {
        Ok(guard) => guard.iter().cloned().collect(),
        Err(_) => return,
    };
    let Some(submenu) = (match app.state::<RecentMenu>().0.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    }) else {
        return;
    };
    let old_items: Vec<MenuItem<tauri::Wry>> = match app.state::<RecentItems>().0.lock() {
        Ok(mut guard) => guard.drain(..).collect(),
        Err(_) => Vec::new(),
    };
    for item in &old_items {
        let _ = submenu.remove(item);
    }
    let mut new_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    if paths.is_empty() {
        if let Ok(item) =
            MenuItem::with_id(app, "recent_empty", "（无最近文件）", false, None::<&str>)
        {
            let _ = submenu.append(&item);
            new_items.push(item);
        }
    } else {
        for path in &paths {
            let title = Path::new(path)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("未命名文稿");
            let id = format!("recent::{path}");
            if let Ok(item) = MenuItem::with_id(app, &id, title, true, None::<&str>) {
                let _ = submenu.append(&item);
                new_items.push(item);
            }
        }
    }
    if let Ok(mut guard) = app.state::<RecentMenu>().0.lock() {
        *guard = Some(submenu);
    }
    if let Ok(mut guard) = app.state::<RecentItems>().0.lock() {
        *guard = new_items;
    }
}

#[tauri::command]
fn sync_theme_menu(theme: String, state: tauri::State<'_, ThemeChecks>) -> Result<(), String> {
    let checks = state
        .0
        .lock()
        .map_err(|_| "菜单状态锁失败".to_string())?;
    for (name, item) in checks.iter() {
        let _ = item.set_checked(name == &theme);
    }
    Ok(())
}

fn build_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    // 应用菜单（macOS 上第一个子菜单自动成为应用菜单）
    let about = menu_item(app, "about", "关于 Markora", None);
    let settings = menu_item(app, "settings", "设置…", Some("Cmd+Comma"));
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = menu_item(app, "quit", "退出 Markora", Some("Cmd+Q"));
    let app_menu = SubmenuBuilder::new(app, "Markora")
        .item(&about)
        .item(&sep(app))
        .item(&settings)
        .item(&sep(app))
        .item(&hide)
        .item(&hide_others)
        .item(&show_all)
        .item(&sep(app))
        .item(&quit)
        .build()?;

    // 文件
    let new_item = menu_item(app, "new", "新建", Some("Cmd+N"));
    let open_item = menu_item(app, "open", "打开…", Some("Cmd+O"));
    let save_item = menu_item(app, "save", "保存", Some("Cmd+S"));
    let save_as = menu_item(app, "save_as", "另存为…", Some("Cmd+Alt+S"));
    let import_item = menu_item(app, "import", "导入 Markdown…", None);
    let export_html_item = menu_item(app, "export_html", "导出 HTML", Some("Cmd+Shift+J"));
    let export_pdf_item = menu_item(app, "export_pdf", "导出 PDF", Some("Cmd+Shift+P"));
    let open_workspace_item = menu_item(app, "open_workspace", "打开文件夹…", None);
    let reveal_item = menu_item(app, "reveal", "在 Finder 中显示", Some("Cmd+Shift+R"));
    let recent_submenu = SubmenuBuilder::new(app, "最近打开").build()?;
    let close_window = PredefinedMenuItem::close_window(app, None)?;
    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(&new_item)
        .item(&open_item)
        .item(&sep(app))
        .item(&save_item)
        .item(&save_as)
        .item(&sep(app))
        .item(&import_item)
        .item(&export_html_item)
        .item(&export_pdf_item)
        .item(&sep(app))
        .item(&open_workspace_item)
        .item(&reveal_item)
        .item(&recent_submenu)
        .item(&sep(app))
        .item(&close_window)
        .build()?;
    if let Ok(mut guard) = app.state::<RecentMenu>().0.lock() {
        *guard = Some(recent_submenu);
    }
    if let Ok(mut guard) = app.state::<RecentItems>().0.lock() {
        *guard = Vec::new();
    }

    // 编辑
    let undo = menu_item(app, "undo", "撤销", Some("Cmd+Z"));
    let redo = menu_item(app, "redo", "重做", Some("Cmd+Shift+Z"));
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let find_item = menu_item(app, "find", "查找", Some("Cmd+F"));
    let replace_item = menu_item(app, "replace", "替换", Some("Cmd+Alt+F"));
    let clear_format = menu_item(app, "clear_format", "清除格式", None);
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&undo)
        .item(&redo)
        .item(&sep(app))
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&select_all)
        .item(&sep(app))
        .item(&find_item)
        .item(&replace_item)
        .item(&sep(app))
        .item(&clear_format)
        .build()?;

    // 段落
    let paragraph_menu = SubmenuBuilder::new(app, "段落")
        .item(&menu_item(app, "h1", "一级标题", Some("Cmd+1")))
        .item(&menu_item(app, "h2", "二级标题", Some("Cmd+2")))
        .item(&menu_item(app, "h3", "三级标题", Some("Cmd+3")))
        .item(&menu_item(app, "h4", "四级标题", Some("Cmd+4")))
        .item(&menu_item(app, "h5", "五级标题", Some("Cmd+5")))
        .item(&menu_item(app, "h6", "六级标题", Some("Cmd+6")))
        .item(&sep(app))
        .item(&menu_item(app, "paragraph", "正文", Some("Cmd+0")))
        .item(&sep(app))
        .item(&menu_item(app, "blockquote", "引用", Some("Cmd+Alt+Q")))
        .item(&menu_item(app, "codeblock", "代码块", Some("Cmd+Shift+C")))
        .item(&sep(app))
        .item(&menu_item(app, "bullet_list", "无序列表", Some("Cmd+Shift+8")))
        .item(&menu_item(app, "ordered_list", "有序列表", Some("Cmd+Shift+9")))
        .item(&menu_item(app, "task_list", "任务列表", Some("Cmd+Shift+B")))
        .item(&sep(app))
        .item(&menu_item(app, "hr", "分隔线", None))
        .item(&menu_item(app, "table", "表格", Some("Cmd+T")))
        .item(&menu_item(app, "math", "数学公式", Some("Cmd+Shift+M")))
        .build()?;

    // 格式
    let format_menu = SubmenuBuilder::new(app, "格式")
        .item(&menu_item(app, "bold", "加粗", Some("Cmd+B")))
        .item(&menu_item(app, "italic", "斜体", Some("Cmd+I")))
        .item(&menu_item(app, "underline", "下划线", Some("Cmd+U")))
        .item(&menu_item(app, "strike", "删除线", Some("Cmd+Shift+S")))
        .item(&sep(app))
        .item(&menu_item(app, "code", "代码", None))
        .item(&menu_item(app, "highlight", "高亮", Some("Cmd+Shift+H")))
        .item(&sep(app))
        .item(&menu_item(app, "superscript", "上标", None))
        .item(&menu_item(app, "subscript", "下标", None))
        .item(&sep(app))
        .item(&menu_item(app, "link", "插入链接", Some("Cmd+K")))
        .item(&menu_item(app, "image", "插入图片", Some("Cmd+Shift+I")))
        .item(&menu_item(app, "emoji", "插入表情", None))
        .build()?;

    // 主题（单选勾选）
    let theme_auto = check_item(app, "theme:auto", "自动", true);
    let theme_github = check_item(app, "theme:github", "GitHub", false);
    let theme_newsprint = check_item(app, "theme:newsprint", "新闻纸", false);
    let theme_night = check_item(app, "theme:night", "夜间", false);
    let theme_pixyll = check_item(app, "theme:pixyll", "Pixyll", false);
    let theme_menu = SubmenuBuilder::new(app, "主题")
        .item(&theme_auto)
        .item(&theme_github)
        .item(&theme_newsprint)
        .item(&theme_night)
        .item(&theme_pixyll)
        .build()?;
    if let Ok(mut guard) = app.state::<ThemeChecks>().0.lock() {
        guard.insert("theme:auto".to_string(), theme_auto);
        guard.insert("theme:github".to_string(), theme_github);
        guard.insert("theme:newsprint".to_string(), theme_newsprint);
        guard.insert("theme:night".to_string(), theme_night);
        guard.insert("theme:pixyll".to_string(), theme_pixyll);
    }

    // 视图
    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(&menu_item(app, "focus", "专注模式", Some("F8")))
        .item(&menu_item(app, "typewriter", "打字机模式", Some("F9")))
        .item(&menu_item(app, "source", "源码模式", Some("Cmd+Slash")))
        .item(&sep(app))
        .item(&menu_item(app, "sidebar", "侧栏", Some("Cmd+Shift+F")))
        .item(&menu_item(app, "outline", "大纲", None))
        .item(&menu_item(app, "files", "文稿", None))
        .item(&menu_item(app, "workspace", "文件夹", None))
        .item(&sep(app))
        .item(&menu_item(app, "zoom_in", "放大", None))
        .item(&menu_item(app, "zoom_out", "缩小", None))
        .item(&menu_item(app, "zoom_reset", "实际大小", None))
        .item(&sep(app))
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    // 帮助
    let help_menu = SubmenuBuilder::new(app, "帮助")
        .item(&menu_item(app, "help", "Markora 帮助", None))
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&paragraph_menu)
        .item(&format_menu)
        .item(&view_menu)
        .item(&theme_menu)
        .item(&help_menu)
        .build()?;
    Ok(menu)
}

fn sanitize_export_name(name: &str, extension: &str) -> String {
    let safe: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            value => value,
        })
        .collect();
    let extension = extension.trim_start_matches('.');
    if safe.to_lowercase().ends_with(&format!(".{extension}")) {
        safe
    } else {
        format!("{safe}.{extension}")
    }
}

fn open_path_in_default_app(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/C", "start", "", path.to_string_lossy().as_ref()])
        .spawn()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn export_html_file(suggested_name: String, contents: String) -> Result<Option<String>, String> {
    let saved_path = tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let file_name = sanitize_export_name(&suggested_name, "html");
        let Some(path) = rfd::FileDialog::new()
            .add_filter("HTML", &["html", "htm"])
            .set_file_name(file_name)
            .save_file()
        else {
            return Ok(None);
        };
        atomic_write(&path, &contents)?;
        let path = path.canonicalize().map_err(|error| error.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(saved_path)
}

#[tauri::command]
async fn open_export_in_browser(title: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let temp_dir = std::env::temp_dir();
        let file_name = sanitize_export_name(&title, "html");
        let path = temp_dir.join(file_name);
        atomic_write(&path, &contents)?;
        open_path_in_default_app(&path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(PendingDocuments::default())
        .manage(OpenDocuments::default())
        .manage(OpenWorkspaces::default())
        .manage(RecentDocuments::default())
        .manage(RecentMenu::default())
        .manage(RecentItems::default())
        .manage(ThemeChecks::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;
            // 恢复持久化的最近文件列表并填充子菜单。
            let persisted = load_recent(&handle);
            if let Ok(mut guard) = handle.state::<RecentDocuments>().0.lock() {
                *guard = persisted;
            }
            rebuild_recent_submenu(&handle);
            // 通过命令行参数打开文稿（文件关联 / open -a）。
            if let Some(path) = std::env::args()
                .skip(1)
                .map(PathBuf::from)
                .find(|path| path.is_file())
            {
                if let Ok(document) = document_from_path(path) {
                    publish_document(&handle, document);
                }
            }
            app.on_menu_event(move |handle, event| {
                let id = event.id().0.as_str().to_owned();
                if let Some(path) = id.strip_prefix("recent::") {
                    match document_from_path(PathBuf::from(path)) {
                        Ok(document) => publish_document(handle, document),
                        Err(_) => {
                            let _ = handle.emit("toast", "文件已被移动或删除，无法打开");
                        }
                    }
                    return;
                }
                let _ = handle.emit("menu", id);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_markdown,
            save_markdown,
            reveal_in_folder,
            authorize_local_image,
            take_pending_documents,
            open_workspace,
            refresh_workspace,
            read_workspace_document,
            read_external_document,
            export_html_file,
            open_export_in_browser,
            sync_theme_menu
        ])
        .build(tauri::generate_context!())
        .expect("error while building Markora");

    app.run(|app, event| match event {
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            // Closing the window should quit the whole app, matching how a
            // single-window editor is expected to behave on every platform.
            app.exit(0);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if let Ok(document) = document_from_path(path) {
                        publish_document(app, document);
                    }
                }
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{atomic_write, ensure_document_revision, resolve_local_image, scan_workspace};

    #[test]
    fn local_images_are_limited_to_the_document_directory() {
        let root = std::env::temp_dir().join(format!("typedown-image-test-{}", std::process::id()));
        let notes = root.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let document = notes.join("guide.md");
        let image = notes.join("logo.png");
        let outside = root.join("outside.png");
        std::fs::write(&document, "![logo](logo.png)").unwrap();
        std::fs::write(&image, b"png").unwrap();
        std::fs::write(&outside, b"png").unwrap();

        assert_eq!(
            resolve_local_image(document.to_str().unwrap(), "./logo.png").unwrap(),
            image.canonicalize().unwrap()
        );
        assert!(resolve_local_image(document.to_str().unwrap(), "../outside.png").is_err());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_scan_finds_markdown_and_skips_hidden_or_generated_folders() {
        let root =
            std::env::temp_dir().join(format!("typedown-workspace-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("guide")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("README.md"), "# Readme").unwrap();
        std::fs::write(root.join("guide/start.markdown"), "# Start").unwrap();
        std::fs::write(root.join("guide/image.png"), b"png").unwrap();
        std::fs::write(root.join(".hidden/secret.md"), "hidden").unwrap();
        std::fs::write(root.join("node_modules/pkg/noise.md"), "noise").unwrap();

        let workspace = scan_workspace(&root).unwrap();
        let paths = workspace
            .files
            .iter()
            .map(|file| file.relative_path.replace('\\', "/"))
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["guide/start.markdown", "README.md"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conditional_save_rejects_external_changes_and_missing_files() {
        let root = std::env::temp_dir().join(format!("typedown-save-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("note.md");
        std::fs::write(&path, "saved").unwrap();

        ensure_document_revision(&path, Some("saved"), false).unwrap();
        std::fs::write(&path, "external").unwrap();
        assert!(ensure_document_revision(&path, Some("saved"), false).is_err());
        ensure_document_revision(&path, Some("saved"), true).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(ensure_document_revision(&path, Some("saved"), false).is_err());

        atomic_write(&path, "replacement").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "replacement");
        std::fs::remove_dir_all(root).unwrap();
    }
}
