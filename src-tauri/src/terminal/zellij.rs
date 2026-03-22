use std::process::Command;

/// Returns the pane name used for a Claude process with the given PID.
/// The shell hook uses $$ (the shell's PID), so we need the parent PID
/// of the Claude process (which is the shell) to match the pane name.
pub fn pane_name_for_pid(pid: u32) -> String {
    format!("claude-{}", pid)
}

/// Get the parent PID of a process by reading /proc/<pid>/stat
fn get_parent_pid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    // /proc/<pid>/stat format: pid (comm) state ppid ...
    // The comm field can contain spaces and parens, so find the last ')' first
    let after_comm = stat.rfind(')')? + 2; // skip ') '
    let fields: Vec<&str> = stat[after_comm..].split_whitespace().collect();
    // fields[0] = state, fields[1] = ppid
    fields.get(1)?.parse().ok()
}

/// Focus a Zellij pane by PID, using the pane's name convention "claude-{shell_pid}"
/// The shell hook names panes using $$ (the shell's PID), so we look up Claude's
/// parent PID (the shell) and use that to construct the pane name.
/// Tries `zellij action focus-pane --name <name>` first,
/// falls back to `zellij action go-to-tab-name <name>` if that fails.
/// Returns Ok(()) on success, Err(reason) on failure.
pub fn focus_zellij_pane_by_pid(pid: u32) -> Result<(), String> {
    // The shell hook uses $$ which is the shell's PID (Claude's parent)
    let shell_pid = get_parent_pid(pid)
        .ok_or_else(|| format!("Could not determine parent PID for {}", pid))?;
    let name = pane_name_for_pid(shell_pid);

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
    fn test_pane_name_for_pid() {
        assert_eq!(pane_name_for_pid(1234), "claude-1234");
        assert_eq!(pane_name_for_pid(0), "claude-0");
        assert!(pane_name_for_pid(42).starts_with("claude-"));
    }

    #[test]
    fn test_get_parent_pid_self() {
        // Our own process should have a valid parent
        let our_pid = std::process::id();
        let ppid = get_parent_pid(our_pid);
        assert!(ppid.is_some());
        assert!(ppid.unwrap() > 0);
    }

    #[test]
    fn test_get_parent_pid_invalid() {
        // Non-existent PID should return None
        assert_eq!(get_parent_pid(999999999), None);
    }
}
