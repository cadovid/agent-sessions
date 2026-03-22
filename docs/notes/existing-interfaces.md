# Existing Codebase Interface Analysis

## Critical Finding: process/claude.rs is Already Cross-Platform

The process discovery module uses `sysinfo` (cross-platform crate) exclusively.
No macOS-specific APIs. `ClaudeProcess` has no TTY field — TTY lookup is separate.

**`process/claude.rs` will work on Linux without modification.**
We do NOT need a separate `process/linux.rs`. This simplifies the PR significantly.

The only Linux-specific work is in the `terminal/` module.

---

## ClaudeProcess Struct (process/claude.rs:8-14)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaudeProcess {
    pub pid: u32,
    pub cwd: Option<PathBuf>,
    pub cpu_usage: f32,
    pub memory: u64,
}
```

**Note:** NO `tty` field. TTY is looked up separately in `terminal/mod.rs`.

---

## Process Module (process/mod.rs)

```rust
mod claude;
pub use claude::{ClaudeProcess, find_claude_processes, is_orphaned_process};
```

Unconditional — no `#[cfg]` guards needed since claude.rs is cross-platform.

---

## Terminal Module (terminal/mod.rs)

### Public API (called from commands/handlers.rs)

```rust
// Primary entry point — called with the PID of a Claude process
pub fn focus_terminal_for_pid(pid: u32) -> Result<(), String>

// Fallback — tries to match terminal session by project path name
pub fn focus_terminal_by_path(path: &str) -> Result<(), String>
```

**Called from `commands/handlers.rs:19-21`:**
```rust
pub fn focus_session(pid: u32, project_path: String) -> Result<(), String> {
    terminal::focus_terminal_for_pid(pid)
        .or_else(|_| terminal::focus_terminal_by_path(&project_path))
}
```

### Internal Helper

```rust
fn get_tty_for_pid(pid: u32) -> Result<String, String>
// Uses: ps -p <pid> -o tty=
// macOS returns: "ttys003"
// Linux returns: "pts/0"
```

### macOS Backend Functions

```rust
// terminal/tmux.rs
pub fn focus_tmux_pane_by_tty(tty: &str) -> Result<(), String>
// NOTE: NOT cross-platform! Imports applescript, iterm, terminal_app

// terminal/iterm.rs
pub fn focus_iterm_by_tty(tty: &str) -> Result<(), String>
// Uses AppleScript

// terminal/terminal_app.rs
pub fn focus_terminal_app_by_tty(tty: &str) -> Result<(), String>
// Uses AppleScript

// terminal/applescript.rs
pub fn execute_applescript(script: &str) -> Result<(), String>
// Calls osascript — macOS only
```

### macOS Orchestration Flow

```
focus_terminal_for_pid(pid)
  → get_tty_for_pid(pid)         # ps -p <pid> -o tty=
  → tmux::focus_tmux_pane_by_tty(&tty)  # try tmux first
  → iterm::focus_iterm_by_tty(&tty)     # try iTerm2
  → terminal_app::focus_terminal_app_by_tty(&tty)  # fallback to Terminal.app
```

---

## Linux Implementation Strategy

### What changes in terminal/mod.rs

Wrap all macOS modules and functions with `#[cfg(target_os = "macos")]`.
Add `#[cfg(target_os = "linux")]` block that imports `zellij` and `linux` modules.

Both platforms export the same public API:
- `focus_terminal_for_pid(pid: u32) -> Result<(), String>`
- `focus_terminal_by_path(path: &str) -> Result<(), String>` (no-op on Linux, returns Err)

### What process/mod.rs needs

Nothing. Leave it as-is. `claude.rs` works on Linux.

### Linux Orchestration Flow

```
focus_terminal_for_pid(pid)
  → linux::focus_terminal_for_pid(pid)
    → try tmux: tmux list-panes → match TTY → tmux select-window + select-pane
    → try zellij: zellij action focus-pane --name claude-<pid>
```

### TTY normalization

On Linux, `ps -o tty=` returns `pts/N`. For tmux matching (tmux returns `/dev/pts/N`),
normalize by prepending `/dev/`: `pts/0` → `/dev/pts/0`.

---

## Cargo.toml Dependencies

sysinfo = "0.31" (already present, cross-platform)

No additional dependencies needed for Linux support.
