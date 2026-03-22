use std::process::Command;

/// Focus the terminal containing the Claude process with the given PID.
/// Tries tmux first, then Zellij. Detection does not rely on environment
/// variables since the desktop app runs outside the terminal multiplexer.
pub fn focus_terminal_for_pid(pid: u32) -> Result<(), String> {
    // Try tmux — check if tmux is running by attempting list-panes
    if focus_tmux_pane(pid).is_ok() {
        return Ok(());
    }

    // Try Zellij — detection uses `zellij list-sessions` (works from outside)
    if super::zellij::focus_zellij_pane_by_pid(pid).is_ok() {
        return Ok(());
    }

    Err("not found: no supported terminal backend".to_string())
}

/// Stub — window focusing via path is not supported on Linux.
pub fn focus_terminal_by_path(_path: &str) -> Result<(), String> {
    Err("not supported on Linux".to_string())
}

/// Normalize a raw TTY string from `ps`.
/// If the value does not start with `/`, prepend `/dev/`.
/// Returns `None` if `raw` is empty or `"??"`.
fn normalize_tty(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "??" {
        return None;
    }
    if trimmed.starts_with('/') {
        Some(trimmed.to_string())
    } else {
        Some(format!("/dev/{}", trimmed))
    }
}

/// Get the TTY device path for the given PID using `ps`.
fn get_tty_for_pid(pid: u32) -> Result<String, String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "tty="])
        .output()
        .map_err(|e| format!("Failed to get TTY: {}", e))?;

    if output.status.success() {
        let raw = String::from_utf8_lossy(&output.stdout);
        normalize_tty(raw.as_ref()).ok_or_else(|| "Process has no TTY".to_string())
    } else {
        Err("Failed to get TTY for process".to_string())
    }
}

/// Focus the tmux pane whose TTY matches that of `pid`.
fn focus_tmux_pane(pid: u32) -> Result<(), String> {
    let tty = get_tty_for_pid(pid)?;

    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}",
        ])
        .output()
        .map_err(|e| format!("Failed to run tmux: {}", e))?;

    if !output.status.success() {
        return Err("tmux not running or no sessions".to_string());
    }

    let panes = String::from_utf8_lossy(&output.stdout);

    for line in panes.lines() {
        let parts: Vec<&str> = line.splitn(2, ' ').collect();
        if parts.len() == 2 {
            let pane_tty = parts[0];
            let target = parts[1].trim();

            if pane_tty == tty {
                // select-window failure is tolerable (might already be the current window)
                let _ = Command::new("tmux")
                    .args(["select-window", "-t", target])
                    .output();

                // select-pane failure means we couldn't actually focus
                let pane_result = Command::new("tmux")
                    .args(["select-pane", "-t", target])
                    .output()
                    .map_err(|e| format!("Failed to run tmux select-pane: {}", e))?;

                if pane_result.status.success() {
                    return Ok(());
                } else {
                    return Err(format!("tmux select-pane failed for target {}", target));
                }
            }
        }
    }

    Err("Pane not found in tmux".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_tty_already_absolute() {
        assert_eq!(
            normalize_tty("/dev/pts/0"),
            Some("/dev/pts/0".to_string())
        );
    }

    #[test]
    fn test_normalize_tty_relative_prepends_dev() {
        assert_eq!(
            normalize_tty("pts/0"),
            Some("/dev/pts/0".to_string())
        );
    }

    #[test]
    fn test_normalize_tty_tty_name_prepends_dev() {
        assert_eq!(
            normalize_tty("tty1"),
            Some("/dev/tty1".to_string())
        );
    }

    #[test]
    fn test_normalize_tty_empty_returns_none() {
        assert_eq!(normalize_tty(""), None);
    }

    #[test]
    fn test_normalize_tty_whitespace_only_returns_none() {
        assert_eq!(normalize_tty("   "), None);
    }

    #[test]
    fn test_normalize_tty_question_marks_returns_none() {
        assert_eq!(normalize_tty("??"), None);
    }

    #[test]
    fn test_normalize_tty_trims_whitespace() {
        assert_eq!(
            normalize_tty("  pts/1  "),
            Some("/dev/pts/1".to_string())
        );
    }

    #[test]
    fn test_normalize_tty_absolute_with_whitespace() {
        assert_eq!(
            normalize_tty("  /dev/pts/2  "),
            Some("/dev/pts/2".to_string())
        );
    }
}
