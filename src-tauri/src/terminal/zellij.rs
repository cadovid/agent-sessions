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

/// Get the first active Zellij session name, or None if no sessions exist.
/// This works even when called from outside Zellij (e.g., from the desktop app).
fn get_zellij_session() -> Option<String> {
    let output = Command::new("zellij")
        .args(["list-sessions", "-n", "-s"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let sessions = String::from_utf8_lossy(&output.stdout);
    sessions.lines().next().map(|s| s.trim().to_string())
}

/// Check if the target pane is already focused by parsing dump-layout output.
/// Returns true if the pane with the given name has focus=true.
fn is_pane_focused(layout: &str, pane_name: &str) -> bool {
    for line in layout.lines() {
        if line.contains(&format!("name=\"{}\"", pane_name)) && line.contains("focus=true") {
            return true;
        }
    }
    false
}

/// Check if the target pane exists in the layout.
fn pane_exists_in_layout(layout: &str, pane_name: &str) -> bool {
    layout.contains(&format!("name=\"{}\"", pane_name))
}

/// Count the number of command panes (non-plugin panes) in the layout.
fn count_command_panes(layout: &str) -> usize {
    layout.lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed.starts_with("pane command=")
        })
        .count()
}

/// Focus the Zellij pane running the Claude process with the given PID.
///
/// Strategy: since Zellij 0.43 has no `focus-pane --name` action,
/// we use `dump-layout` to find the target pane, then cycle through
/// panes with `focus-next-pane` until the target pane is focused.
pub fn focus_zellij_pane_by_pid(pid: u32) -> Result<(), String> {
    let session = get_zellij_session()
        .ok_or_else(|| "No active Zellij session found".to_string())?;

    // Construct the expected pane name (uses shell's PID, not Claude's)
    let shell_pid = get_parent_pid(pid)
        .ok_or_else(|| format!("Could not determine parent PID for {}", pid))?;
    let target_name = pane_name_for_pid(shell_pid);

    // Get current layout
    let layout = get_layout(&session)?;

    // Check if the pane exists at all
    if !pane_exists_in_layout(&layout, &target_name) {
        return Err(format!("Pane '{}' not found in Zellij layout", target_name));
    }

    // Already focused? Just raise the terminal window.
    if is_pane_focused(&layout, &target_name) {
        raise_zellij_terminal_window();
        return Ok(());
    }

    // Cycle focus-next-pane until we land on the target.
    // Limit iterations to avoid infinite loops.
    let max_cycles = count_command_panes(&layout) + 2;

    for _ in 0..max_cycles {
        let _ = Command::new("zellij")
            .args(["--session", &session, "action", "focus-next-pane"])
            .output();

        // Brief pause for Zellij to update state
        std::thread::sleep(std::time::Duration::from_millis(50));

        let new_layout = get_layout(&session)?;
        if is_pane_focused(&new_layout, &target_name) {
            raise_zellij_terminal_window();
            return Ok(());
        }
    }

    Err(format!("Could not focus pane '{}' after cycling", target_name))
}

/// Raise and focus the terminal window running the Zellij client.
///
/// Finds the Zellij client process (not the server), walks up the process
/// tree to find the terminal emulator, and uses xdotool to activate its
/// X11 window. Fails silently if xdotool is not installed or no window is found.
fn raise_zellij_terminal_window() {
    // Find Zellij client PIDs (processes running "zellij" without "--server")
    let output = match Command::new("pgrep").args(["-x", "zellij"]).output() {
        Ok(o) => o,
        Err(_) => return,
    };

    let pids = String::from_utf8_lossy(&output.stdout);
    for pid_str in pids.lines() {
        let pid: u32 = match pid_str.trim().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };

        // Skip the server process (has --server in its cmdline)
        if let Ok(cmdline) = std::fs::read_to_string(format!("/proc/{}/cmdline", pid)) {
            if cmdline.contains("--server") {
                continue;
            }
        }

        // Walk up the process tree to find an ancestor with an X11 window
        if let Some(wid) = find_x11_window_in_ancestors(pid) {
            let _ = Command::new("xdotool")
                .args(["windowactivate", &wid.to_string()])
                .output();
            return;
        }
    }
}

/// Walk up the process tree from `pid` and return the first X11 window ID found.
fn find_x11_window_in_ancestors(start_pid: u32) -> Option<u64> {
    let mut pid = start_pid;
    while pid > 1 {
        // Ask xdotool for windows owned by this PID
        if let Ok(output) = Command::new("xdotool")
            .args(["search", "--pid", &pid.to_string()])
            .output()
        {
            if output.status.success() {
                let wids = String::from_utf8_lossy(&output.stdout);
                if let Some(wid_str) = wids.lines().next() {
                    if let Ok(wid) = wid_str.trim().parse::<u64>() {
                        return Some(wid);
                    }
                }
            }
        }

        // Move to parent
        pid = match get_parent_pid(pid) {
            Some(p) => p,
            None => break,
        };
    }
    None
}

/// Get the current layout from a Zellij session.
fn get_layout(session: &str) -> Result<String, String> {
    let output = Command::new("zellij")
        .args(["--session", session, "action", "dump-layout"])
        .output()
        .map_err(|e| format!("Failed to run zellij dump-layout: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
        let our_pid = std::process::id();
        let ppid = get_parent_pid(our_pid);
        assert!(ppid.is_some());
        assert!(ppid.unwrap() > 0);
    }

    #[test]
    fn test_get_parent_pid_invalid() {
        assert_eq!(get_parent_pid(999999999), None);
    }

    #[test]
    fn test_is_pane_focused() {
        let layout = r#"
        pane command="claude" name="claude-1234" focus=true size="50%" {
        pane command="claude" name="claude-5678" size="50%" {
        "#;
        assert!(is_pane_focused(layout, "claude-1234"));
        assert!(!is_pane_focused(layout, "claude-5678"));
    }

    #[test]
    fn test_pane_exists_in_layout() {
        let layout = r#"
        pane command="claude" name="claude-1234" focus=true size="50%" {
        "#;
        assert!(pane_exists_in_layout(layout, "claude-1234"));
        assert!(!pane_exists_in_layout(layout, "claude-9999"));
    }

    #[test]
    fn test_count_command_panes() {
        let layout = r#"
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane command="claude" name="claude-1234" focus=true size="50%" {
        pane command="claude" name="claude-5678" size="50%" {
        "#;
        assert_eq!(count_command_panes(layout), 2);
    }
}
