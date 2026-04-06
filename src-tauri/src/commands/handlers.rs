use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use std::sync::Mutex;

use crate::session::{get_sessions, SessionsResponse};
use crate::session::history;
use crate::terminal;

// Store current shortcut for unregistration
static CURRENT_SHORTCUT: Mutex<Option<Shortcut>> = Mutex::new(None);

/// Get all active Claude Code sessions
#[tauri::command]
pub fn get_all_sessions() -> SessionsResponse {
    get_sessions()
}

/// Focus the terminal containing a specific session
#[tauri::command]
pub fn focus_session(pid: u32, project_path: String) -> Result<(), String> {
    terminal::focus_terminal_for_pid(pid)
        .or_else(|_| terminal::focus_terminal_by_path(&project_path))
}

/// Update the tray icon title with session counts
#[tauri::command]
pub fn update_tray_title(app: tauri::AppHandle, total: usize, waiting: usize) -> Result<(), String> {
    let title = if waiting > 0 {
        format!("{} ({} idle)", total, waiting)
    } else if total > 0 {
        format!("{}", total)
    } else {
        String::new()
    };

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_title(Some(&title))
            .map_err(|e| format!("Failed to set tray title: {}", e))?;
    }
    Ok(())
}

/// Register a global keyboard shortcut to toggle the window
#[tauri::command]
pub fn register_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    // Unregister any existing shortcut first
    if let Some(old_shortcut) = CURRENT_SHORTCUT.lock().unwrap().take() {
        let _ = app.global_shortcut().unregister(old_shortcut);
    }

    // Parse the shortcut string
    let parsed_shortcut: Shortcut = shortcut.parse()
        .map_err(|e| format!("Invalid shortcut format: {}", e))?;

    // Register the new shortcut - toggle window visibility
    app.global_shortcut()
        .on_shortcut(parsed_shortcut.clone(), move |app, _shortcut, event| {
            // Only handle key press, not release
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }

            if let Some(window) = app.get_webview_window("main") {
                let is_visible = window.is_visible().unwrap_or(false);
                let is_focused = window.is_focused().unwrap_or(false);

                // If window is visible AND focused, hide it
                // Otherwise, show and focus it
                if is_visible && is_focused {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .map_err(|e| format!("Failed to register shortcut: {}", e))?;

    // Store the shortcut for later unregistration
    *CURRENT_SHORTCUT.lock().unwrap() = Some(parsed_shortcut);

    Ok(())
}

/// Unregister the current global keyboard shortcut
#[tauri::command]
pub fn unregister_shortcut(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(shortcut) = CURRENT_SHORTCUT.lock().unwrap().take() {
        app.global_shortcut()
            .unregister(shortcut)
            .map_err(|e| format!("Failed to unregister shortcut: {}", e))?;
    }
    Ok(())
}

/// Kill an agent process by PID
#[tauri::command]
pub fn kill_session(pid: u32) -> Result<(), String> {
    use std::process::Command;

    // Use SIGKILL (-9) to forcefully terminate the process
    // SIGTERM often doesn't work for agent processes with child processes
    let output = Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .output()
        .map_err(|e| format!("Failed to execute kill command: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to kill process {}: {}", pid, stderr))
    }
}

/// Get all past Claude sessions grouped by project
#[tauri::command]
pub fn get_session_history() -> history::SessionHistoryResponse {
    history::get_session_history()
}

/// Delete a past Claude session's JSONL file from ~/.claude/projects/
#[tauri::command]
pub fn delete_history_session(session_id: String, project_dir_name: String) -> Result<(), String> {
    history::delete_history_session(&session_id, &project_dir_name)
}

/// Info about a session for the tray menu
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySessionInfo {
    pub pid: u32,
    pub project_name: String,
    pub status: String,
}

/// Rebuild the tray menu with the current session list
#[tauri::command]
pub fn update_tray_menu(app: tauri::AppHandle, sessions: Vec<TraySessionInfo>) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    let active_count = sessions.iter().filter(|s| s.status == "active").count();
    let idle_count = sessions.iter().filter(|s| s.status == "idle").count();

    let mut builder = MenuBuilder::new(&app);

    // Header with counts
    if !sessions.is_empty() {
        let label = format!("{} Active / {} Idle", active_count, idle_count);
        let header = MenuItemBuilder::with_id("header", &label)
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        builder = builder.item(&header).separator();
    }

    // Session items
    for session in &sessions {
        let dot = if session.status == "active" { "●" } else { "○" };
        let label = format!("{} {}", dot, session.project_name);
        let item = MenuItemBuilder::with_id(format!("session-{}", session.pid), &label)
            .build(&app)
            .map_err(|e| e.to_string())?;
        builder = builder.item(&item);
    }

    if !sessions.is_empty() {
        builder = builder.separator();
    }

    // Show Window + Quit
    let show_item = MenuItemBuilder::with_id("show", "Show Window")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit")
        .build(&app)
        .map_err(|e| e.to_string())?;
    builder = builder.item(&show_item).separator().item(&quit_item);

    let menu = builder.build().map_err(|e| e.to_string())?;

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Get all events from a session JSONL file for the Event Inspector
#[tauri::command]
pub fn get_session_events(session_id: String, project_dir_name: String) -> Result<Vec<history::SessionEvent>, String> {
    history::get_session_events(&session_id, &project_dir_name)
}

/// Archive a session by copying it to a safe location
#[tauri::command]
pub fn archive_session(session_id: String, project_dir_name: String) -> Result<(), String> {
    history::archive_session(&session_id, &project_dir_name)
}

/// Open a file in the user's default editor or xdg-open
#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    use std::process::Command;

    // Validate: must be absolute path, no traversal
    if !path.starts_with('/') || path.contains("..") {
        return Err("Invalid path".to_string());
    }

    let editor = std::env::var("EDITOR")
        .or_else(|_| std::env::var("VISUAL"))
        .unwrap_or_else(|_| "xdg-open".to_string());

    Command::new(&editor)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open {}: {}", path, e))?;

    Ok(())
}

/// Resume a past Claude session in a new Zellij tab (Linux only)
#[tauri::command]
pub fn resume_session(session_id: String, project_path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        crate::terminal::zellij::resume_in_new_tab(&session_id, &project_path)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (session_id, project_path);
        Err("Resume session is only supported on Linux with Zellij".to_string())
    }
}
