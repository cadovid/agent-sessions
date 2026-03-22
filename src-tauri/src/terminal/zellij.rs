use std::process::Command;

/// Returns the pane name used for a Claude process with the given PID
pub fn pane_name_for_pid(pid: u32) -> String {
    format!("claude-{}", pid)
}

/// Focus a Zellij pane by PID, using the pane's name convention "claude-{pid}"
/// Tries `zellij action focus-pane --name <name>` first,
/// falls back to `zellij action go-to-tab-name <name>` if that fails.
/// Returns Ok(()) on success, Err(reason) on failure.
pub fn focus_zellij_pane_by_pid(pid: u32) -> Result<(), String> {
    let name = pane_name_for_pid(pid);

    // Try focus-pane --name first
    let focus_result = Command::new("zellij")
        .args(["action", "focus-pane", "--name", &name])
        .output()
        .map_err(|e| format!("Failed to run zellij: {}", e))?;

    if focus_result.status.success() {
        return Ok(());
    }

    // Fall back to go-to-tab-name
    let tab_result = Command::new("zellij")
        .args(["action", "go-to-tab-name", &name])
        .output()
        .map_err(|e| format!("Failed to run zellij: {}", e))?;

    if tab_result.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&tab_result.stderr);
    Err(format!(
        "Failed to focus Zellij pane '{}': {}",
        name,
        stderr.trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pane_name_for_pid_basic() {
        assert_eq!(pane_name_for_pid(1234), "claude-1234");
    }

    #[test]
    fn test_pane_name_for_pid_zero() {
        assert_eq!(pane_name_for_pid(0), "claude-0");
    }

    #[test]
    fn test_pane_name_for_pid_large() {
        assert_eq!(pane_name_for_pid(99999), "claude-99999");
    }

    #[test]
    fn test_pane_name_for_pid_format_prefix() {
        let name = pane_name_for_pid(42);
        assert!(name.starts_with("claude-"));
        assert!(name.ends_with("42"));
    }
}
