# Linux & Zellij Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linux process discovery, Zellij terminal focusing, and a shell hook to `agent-sessions`, producing a working AppImage and a clean upstream-ready PR.

**Architecture:** Fork the existing Tauri 2.x (Rust + React) project and add Linux support additively — new files only, `#[cfg(target_os)]` guards at the wiring points, zero changes to existing macOS code. A shell hook renames Zellij panes to `claude-<pid>` so the desktop app can focus them by name via the Zellij CLI.

**Tech Stack:** Rust (stable), Tauri 2.x, sysinfo crate, Zellij CLI, Zsh hooks, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-03-20-linux-zellij-agent-sessions-design.md`

**Working directory:** `/home/david/Personal/agent-sessions` (already forked and cloned; branch `feature/linux-zellij-support` already checked out)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src-tauri/src/process/linux.rs` | Linux process discovery via sysinfo + `/proc` |
| Create | `src-tauri/src/terminal/zellij.rs` | Zellij focusing backend |
| Create | `src-tauri/src/terminal/linux.rs` | Linux orchestrator (tmux → zellij → ...) |
| Create | `scripts/shell-hook.sh` | Zellij shell hook for pane naming |
| Create | `.github/workflows/build-linux.yml` | CI Linux AppImage build |
| Modify | `src-tauri/src/process/mod.rs` | Add `#[cfg(target_os = "linux")]` routing |
| Modify | `src-tauri/src/terminal/mod.rs` | Add `#[cfg(target_os = "linux")]` routing |
| Possibly modify | `src-tauri/Cargo.toml` | If Linux-specific crate features needed |

---

## Task 0: Environment Setup & Codebase Exploration

**Files:**
- Read: `src-tauri/src/process/claude.rs`
- Read: `src-tauri/src/process/mod.rs`
- Read: `src-tauri/src/terminal/iterm.rs`
- Read: `src-tauri/src/terminal/tmux.rs`
- Read: `src-tauri/src/terminal/mod.rs`
- Read: `src-tauri/Cargo.toml`

- [ ] **Step 1: Install Rust**

  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source "$HOME/.cargo/env"
  rustc --version   # expect: rustc 1.7x.x
  ```

- [ ] **Step 2: Install Linux system dependencies**

  ```bash
  sudo apt update && sudo apt install -y \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    build-essential
  ```

- [ ] **Step 3: Install Node dependencies**

  ```bash
  npm install
  ```

- [ ] **Step 4: Verify the project compiles (macOS target will warn, that's fine)**

  ```bash
  cargo check --manifest-path src-tauri/Cargo.toml
  ```

  Expected: compilation errors or warnings about missing macOS targets — that's normal on Linux. Note any compile errors and resolve before proceeding.

- [ ] **Step 5: Read existing process discovery code**

  ```bash
  cat src-tauri/src/process/claude.rs
  cat src-tauri/src/process/mod.rs
  ```

  **Note the exact:**
  - Return type of `find_claude_processes()` (or equivalent function name)
  - Struct fields of `ClaudeProcess` (or equivalent) — especially `pid`, `cwd`, `tty`
  - How TTY is obtained (look for `ps -p` call)
  - How parent PID walking works

- [ ] **Step 6: Read existing terminal backend code**

  ```bash
  cat src-tauri/src/terminal/iterm.rs
  cat src-tauri/src/terminal/tmux.rs
  cat src-tauri/src/terminal/mod.rs
  ```

  **Note the exact:**
  - Function signature for focusing (e.g., `focus_terminal(pid: u32) -> Result<(), String>`)
  - How "not found" / failure is returned
  - How the orchestrator selects which backend to try

- [ ] **Step 7: Commit baseline notes**

  Create `docs/notes/existing-interfaces.md` with the exact function signatures and struct definitions you found. This is your reference for Tasks 1–4.

  ```bash
  git add docs/notes/existing-interfaces.md
  git commit -m "docs: capture existing interface signatures for Linux implementation"
  ```

---

## Task 1: Linux Process Discovery

**Files:**
- Create: `src-tauri/src/process/linux.rs`
- Modify: `src-tauri/src/process/mod.rs`
- Test: `src-tauri/src/process/linux.rs` (inline `#[cfg(test)]` module)

> **Before writing any code:** verify the exact return type and struct from Task 0 Step 7. The code below uses `ClaudeProcess` and `find_claude_processes` — adjust names to match the actual codebase.

- [ ] **Step 1: Write the failing test**

  Add to a new file `src-tauri/src/process/linux.rs`:

  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;

      #[test]
      fn test_tty_normalization() {
          assert_eq!(normalize_tty("pts/3"), Some("/dev/pts/3".to_string()));
          assert_eq!(normalize_tty("?"), None);
          assert_eq!(normalize_tty(""), None);
      }

      #[test]
      fn test_find_claude_processes_returns_vec() {
          // Smoke test: function exists and returns without panicking
          let processes = find_claude_processes();
          // Can't assert specific processes in a test env, just verify it runs
          let _ = processes;
      }
  }
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml process::linux
  ```

  Expected: `error[E0425]: cannot find function 'normalize_tty'` — confirms tests are wired and failing.

- [ ] **Step 3: Implement `linux.rs`**

  ```rust
  use sysinfo::{System, ProcessesToUpdate};

  // Re-export the same type as the macOS module so mod.rs can use either
  // transparently. Adjust field names to match what claude.rs actually uses.
  pub use crate::process::claude::ClaudeProcess;

  /// Normalizes Linux TTY names to full /dev paths.
  /// `ps -p <pid> -o tty=` returns "pts/3" on Linux; downstream expects "/dev/pts/3".
  pub fn normalize_tty(raw: &str) -> Option<String> {
      if raw.is_empty() || raw == "?" {
          return None;
      }
      if raw.starts_with('/') {
          Some(raw.to_string())
      } else {
          Some(format!("/dev/{}", raw))
      }
  }

  /// Returns the TTY device path for a given PID using `ps`.
  fn get_tty(pid: u32) -> Option<String> {
      let output = std::process::Command::new("ps")
          .args(["-p", &pid.to_string(), "-o", "tty="])
          .output()
          .ok()?;
      let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
      normalize_tty(&raw)
  }

  /// Returns true if the process whose command is `claude` or ends with `/claude`.
  fn is_claude_binary(cmd: &str) -> bool {
      cmd == "claude" || cmd.ends_with("/claude")
  }

  /// Returns true if the process is a sub-agent (its parent is also a Claude process).
  fn is_sub_agent(sys: &System, parent_pid: Option<sysinfo::Pid>) -> bool {
      parent_pid
          .and_then(|ppid| sys.process(ppid))
          .map(|p| {
              p.exe()
                  .and_then(|e| e.to_str())
                  .map(is_claude_binary)
                  .unwrap_or(false)
          })
          .unwrap_or(false)
  }

  /// Returns true if the parent shell has been reparented to PID 1 (orphaned session).
  fn is_orphaned(sys: &System, parent_pid: Option<sysinfo::Pid>) -> bool {
      parent_pid
          .and_then(|ppid| sys.process(ppid))
          .map(|shell| {
              shell.parent()
                  .map(|grandparent| grandparent.as_u32() == 1)
                  .unwrap_or(false)
          })
          .unwrap_or(false)
  }

  pub fn find_claude_processes() -> Vec<ClaudeProcess> {
      let mut sys = System::new_all();
      sys.refresh_processes(ProcessesToUpdate::All, true);

      sys.processes()
          .values()
          .filter(|p| {
              // Match on executable name
              let cmd = p.exe()
                  .and_then(|e| e.to_str())
                  .unwrap_or("");
              is_claude_binary(cmd)
          })
          .filter(|p| !is_sub_agent(&sys, p.parent()))
          .filter(|p| !is_orphaned(&sys, p.parent()))
          .filter_map(|p| {
              let cwd = p.cwd()?.to_path_buf();
              let pid = p.pid().as_u32();
              Some(ClaudeProcess {
                  pid,
                  cwd,
                  tty: get_tty(pid),
                  // Populate any other fields ClaudeProcess requires —
                  // check docs/notes/existing-interfaces.md from Task 0
              })
          })
          .collect()
  }
  ```

  > **Important:** After writing, compare `ClaudeProcess` field initialization against `docs/notes/existing-interfaces.md`. Add or remove fields to match exactly.

  > **Sub-agent detection clarification:** `is_sub_agent` here filters out Claude sub-agent *processes* from the top-level session list (don't show sub-agents as separate sessions in the UI). This is different from the sub-agent *counter* (how many sub-agents are currently active), which is derived by scanning `agent-*.jsonl` files in `session/parser.rs` — that code is cross-platform and untouched. Both mechanisms exist and serve different purposes.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml process::linux
  ```

  Expected: `test process::linux::tests::test_tty_normalization ... ok`

- [ ] **Step 5: Wire into `process/mod.rs`**

  Open `src-tauri/src/process/mod.rs` and add the Linux routing block. Find where the macOS module is declared (likely `mod claude;`) and add alongside it:

  ```rust
  #[cfg(target_os = "linux")]
  mod linux;
  #[cfg(target_os = "linux")]
  pub use linux::find_claude_processes;

  #[cfg(target_os = "macos")]
  mod claude;
  #[cfg(target_os = "macos")]
  pub use claude::find_claude_processes;
  ```

  If the existing `mod.rs` already has `mod claude;` without a `#[cfg]` guard, wrap it:

  ```rust
  // Before (existing):
  mod claude;
  pub use claude::find_claude_processes;

  // After:
  #[cfg(target_os = "macos")]
  mod claude;
  #[cfg(target_os = "macos")]
  pub use claude::find_claude_processes;
  ```

- [ ] **Step 6: Verify it compiles on Linux**

  ```bash
  cargo check --manifest-path src-tauri/Cargo.toml
  ```

  Expected: no errors related to `process` module.

- [ ] **Step 7: Commit**

  ```bash
  git add src-tauri/src/process/linux.rs src-tauri/src/process/mod.rs
  git commit -m "feat(linux): add Linux process discovery with TTY normalization"
  ```

---

## Task 2: Shell Hook for Zellij Pane Naming

**Files:**
- Create: `scripts/shell-hook.sh`

- [ ] **Step 1: Create `scripts/shell-hook.sh`**

  ```bash
  #!/usr/bin/env bash
  # agent-sessions shell hook
  # Renames the current Zellij pane to "claude-<pid>" when Claude starts,
  # enabling the agent-sessions desktop app to focus it by name.
  #
  # Installation: add this line to your ~/.zshrc or ~/.bashrc:
  #   source ~/.config/agent-sessions/shell-hook.sh
  #
  # This hook is a no-op outside Zellij ($ZELLIJ is unset).

  # ─── Zsh ────────────────────────────────────────────────────────────────────
  if [ -n "$ZSH_VERSION" ]; then

    _agent_sessions_preexec() {
      # Only act inside Zellij
      [ -z "$ZELLIJ" ] && return

      local cmd="${1%% *}"  # first word of the command
      if [ "$cmd" = "claude" ]; then
        # Save original pane name so we can restore it on exit
        _agent_sessions_orig_pane_name=$(zellij action dump-screen 2>/dev/null | head -1 || echo "")
        zellij action rename-pane "claude-$$" 2>/dev/null || true
      fi
    }

    _agent_sessions_precmd() {
      [ -z "$ZELLIJ" ] && return
      # Restore pane name after claude exits (only if we renamed it)
      if [ -n "$_agent_sessions_orig_pane_name" ]; then
        zellij action rename-pane "${_agent_sessions_orig_pane_name}" 2>/dev/null || true
        _agent_sessions_orig_pane_name=""
      fi
    }

    autoload -Uz add-zsh-hook 2>/dev/null
    add-zsh-hook preexec _agent_sessions_preexec
    add-zsh-hook precmd  _agent_sessions_precmd

  # ─── Bash ───────────────────────────────────────────────────────────────────
  elif [ -n "$BASH_VERSION" ]; then

    _agent_sessions_debug_trap() {
      [ -z "$ZELLIJ" ] && return
      local cmd="${BASH_COMMAND%% *}"
      if [ "$cmd" = "claude" ]; then
        # Save original name before renaming so we can restore it on exit.
        # Use the shell's basename as a reliable fallback (e.g. "bash", "zsh").
        _agent_sessions_orig_pane_name="${SHELL##*/}"
        zellij action rename-pane "claude-$$" 2>/dev/null || true
      fi
    }

    _agent_sessions_prompt_command() {
      [ -z "$ZELLIJ" ] && return
      if [ -n "$_agent_sessions_orig_pane_name" ]; then
        zellij action rename-pane "${_agent_sessions_orig_pane_name}" 2>/dev/null || true
        _agent_sessions_orig_pane_name=""
      fi
    }

    trap '_agent_sessions_debug_trap' DEBUG
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }_agent_sessions_prompt_command"

  fi
  ```

- [ ] **Step 2: Make it executable**

  ```bash
  chmod +x scripts/shell-hook.sh
  ```

- [ ] **Step 3: Test the hook manually in Zellij**

  Open a Zellij pane, then:
  ```bash
  source scripts/shell-hook.sh
  # Now open another Zellij pane and watch pane names while running:
  claude --version
  ```

  Expected: the pane name changes to `claude-<your_shell_pid>` while the command runs, then reverts.

- [ ] **Step 4: Commit**

  ```bash
  git add scripts/shell-hook.sh
  git commit -m "feat(linux): add Zellij shell hook for pane naming"
  ```

---

## Task 3: Zellij Terminal Backend

**Files:**
- Create: `src-tauri/src/terminal/zellij.rs`
- Test: `src-tauri/src/terminal/zellij.rs` (inline `#[cfg(test)]` module)

> **Before writing:** re-read `docs/notes/existing-interfaces.md` from Task 0. Confirm the exact return type of the focus function (likely `Result<(), String>`). Match it exactly.

- [ ] **Step 1: Write the failing test**

  Create `src-tauri/src/terminal/zellij.rs`:

  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;

      #[test]
      fn test_pane_name_format() {
          assert_eq!(pane_name_for_pid(12345), "claude-12345");
          assert_eq!(pane_name_for_pid(1), "claude-1");
      }
  }
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml terminal::zellij
  ```

  Expected: `error[E0425]: cannot find function 'pane_name_for_pid'`

- [ ] **Step 3: Implement `zellij.rs`**

  ```rust
  use std::process::Command;

  /// Constructs the Zellij pane name the shell hook uses for a given PID.
  pub fn pane_name_for_pid(pid: u32) -> String {
      format!("claude-{}", pid)
  }

  /// Focuses the Zellij pane associated with the given Claude process PID.
  ///
  /// Requires the shell hook (scripts/shell-hook.sh) to be installed so the
  /// pane was renamed to "claude-<pid>" when Claude started.
  ///
  /// Returns Ok(()) on success, Err with reason on failure.
  pub fn focus_terminal(pid: u32) -> Result<(), String> {
      let name = pane_name_for_pid(pid);

      // Try focus-pane --name (Zellij >= 0.38)
      let result = Command::new("zellij")
          .args(["action", "focus-pane", "--name", &name])
          .output();

      match result {
          Ok(output) if output.status.success() => return Ok(()),
          _ => {}
      }

      // Fallback: go-to-tab-name (older Zellij versions)
      let result = Command::new("zellij")
          .args(["action", "go-to-tab-name", &name])
          .output();

      match result {
          Ok(output) if output.status.success() => Ok(()),
          Ok(output) => {
              let stderr = String::from_utf8_lossy(&output.stderr).to_string();
              Err(format!("not found: {}", stderr))
          }
          Err(e) => Err(format!("zellij not available: {}", e)),
      }
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml terminal::zellij
  ```

  Expected: `test terminal::zellij::tests::test_pane_name_format ... ok`

- [ ] **Step 5: Commit**

  ```bash
  git add src-tauri/src/terminal/zellij.rs
  git commit -m "feat(linux): add Zellij terminal focusing backend"
  ```

---

## Task 4: Linux Terminal Orchestrator

**Files:**
- Create: `src-tauri/src/terminal/linux.rs`
- Modify: `src-tauri/src/terminal/mod.rs`

> **Before writing:** re-read `src-tauri/src/terminal/tmux.rs` to understand its `focus_terminal(pid)` signature. The orchestrator delegates to it directly.

- [ ] **Step 1: Write the failing test**

  Add to a new file `src-tauri/src/terminal/linux.rs`:

  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;

      #[test]
      fn test_detect_zellij_when_env_set() {
          // Simulate $ZELLIJ being set
          std::env::set_var("ZELLIJ", "0");
          assert!(is_zellij_available());
          std::env::remove_var("ZELLIJ");
      }

      #[test]
      fn test_detect_zellij_when_env_unset() {
          std::env::remove_var("ZELLIJ");
          // Without $ZELLIJ, detection returns false
          // (binary check may still find it, so only test env-based detection)
          let _ = is_zellij_available(); // just verify no panic
      }
  }
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml terminal::linux
  ```

  Expected: `error[E0425]: cannot find function 'is_zellij_available'`

- [ ] **Step 3: Implement `linux.rs`**

  ```rust
  use std::env;
  use super::zellij;

  // Import tmux backend — it's already cross-platform in the original codebase.
  // Adjust the path if tmux is exposed differently (check terminal/mod.rs).
  use super::tmux;

  /// Returns true if the process is running inside Zellij.
  /// Zellij sets $ZELLIJ automatically in all child processes.
  pub fn is_zellij_available() -> bool {
      env::var("ZELLIJ").is_ok()
  }

  /// Returns true if the process is running inside tmux.
  pub fn is_tmux_available() -> bool {
      env::var("TMUX").is_ok()
  }

  /// Focuses the terminal window/pane running the Claude process with the given PID.
  ///
  /// Tries backends in order: tmux → Zellij → (future backends).
  /// Fails silently if no backend succeeds.
  pub fn focus_terminal(pid: u32) -> Result<(), String> {
      // 1. Try tmux (already cross-platform in the original codebase)
      if is_tmux_available() {
          if tmux::focus_terminal(pid).is_ok() {
              return Ok(());
          }
      }

      // 2. Try Zellij
      if is_zellij_available() {
          if zellij::focus_terminal(pid).is_ok() {
              return Ok(());
          }
      }

      // 3. Future: GNOME Terminal, Kitty, WezTerm, etc.
      // Add new backends here following the same pattern.

      Err("not found: no supported terminal backend available".to_string())
  }
  ```

  > **Note:** If `tmux::focus_terminal` is not directly accessible, check `terminal/mod.rs` for how the macOS orchestrator calls it and mirror that pattern.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml terminal::linux
  ```

  Expected: `test terminal::linux::tests::test_detect_zellij_when_env_set ... ok`

- [ ] **Step 5: Wire into `terminal/mod.rs`**

  Open `src-tauri/src/terminal/mod.rs`. Find where the macOS terminal focus is exported and add the Linux routing alongside it:

  ```rust
  #[cfg(target_os = "linux")]
  mod zellij;
  #[cfg(target_os = "linux")]
  mod linux;
  #[cfg(target_os = "linux")]
  pub use linux::focus_terminal;

  // Existing macOS declarations stay untouched below:
  // mod applescript;
  // mod iterm;
  // mod terminal_app;
  // mod tmux;
  // pub use <existing_macos_export>;
  ```

  Wrap any unconditional `mod tmux;` declaration so it compiles on both platforms:

  ```rust
  // tmux is cross-platform — keep it available on both
  mod tmux;
  ```

  (No `#[cfg]` needed for tmux since it's already cross-platform.)

- [ ] **Step 6: Full compile check**

  ```bash
  cargo check --manifest-path src-tauri/Cargo.toml
  ```

  Expected: no errors. Warnings about unused macOS imports on Linux are acceptable.

- [ ] **Step 7: Run all tests**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml
  ```

  Expected: all tests pass.

- [ ] **Step 8: Commit**

  ```bash
  git add src-tauri/src/terminal/zellij.rs src-tauri/src/terminal/linux.rs src-tauri/src/terminal/mod.rs
  git commit -m "feat(linux): add Linux terminal orchestrator with Zellij and tmux support"
  ```

---

## Task 5: Full Build Verification

- [ ] **Step 1: Build the full app**

  ```bash
  npm run tauri build
  ```

  Expected: produces `src-tauri/target/release/bundle/appimage/agent-sessions_*.AppImage`

  If the build fails due to missing Linux GTK/WebKit dependencies, re-run Task 0 Step 4.

- [ ] **Step 2: Run the AppImage**

  ```bash
  chmod +x src-tauri/target/release/bundle/appimage/agent-sessions_*.AppImage
  ./src-tauri/target/release/bundle/appimage/agent-sessions_*.AppImage
  ```

  Expected: the app window opens, shows Claude Code sessions if any are running.

- [ ] **Step 3: Test monitoring (no shell hook required)**

  Start a Claude Code session in another Zellij pane:
  ```bash
  claude
  ```

  Expected: the app picks up the session within a few seconds and shows status.

- [ ] **Step 4: Test focusing (shell hook required)**

  Install the hook temporarily:
  ```bash
  source scripts/shell-hook.sh
  claude   # starts Claude in this pane, renames pane to claude-<pid>
  ```

  In the app, click the session row.

  Expected: Zellij jumps to the pane running Claude.

- [ ] **Step 5: Test silent failure (no Zellij)**

  Run the AppImage from a plain terminal (not Zellij). Click a session row.

  Expected: nothing happens (no crash, no error dialog).

- [ ] **Step 6: Commit**

  ```bash
  # Do NOT use git add -A — it will stage build artifacts under src-tauri/target/
  # Stage only source and script changes explicitly:
  git add src-tauri/src/ scripts/ docs/
  git commit -m "build: verify Linux AppImage builds and runs correctly"
  ```

---

## Task 6: CI Linux Build Job

**Files:**
- Create: `.github/workflows/build-linux.yml`

> **Before writing:** read `.github/workflows/` to understand the existing macOS CI structure and mirror it.

- [ ] **Step 1: Read existing CI workflow**

  ```bash
  ls .github/workflows/
  cat .github/workflows/*.yml
  ```

  Note the job name pattern, Node version, and build command used.

- [ ] **Step 2: Create `.github/workflows/build-linux.yml`**

  ```yaml
  name: Build Linux

  on:
    push:
      branches: [feature/linux-zellij-support]
    pull_request:
      branches: [main]

  jobs:
    build-linux:
      runs-on: ubuntu-22.04

      steps:
        - uses: actions/checkout@v4

        - name: Install system dependencies
          run: |
            sudo apt-get update
            sudo apt-get install -y \
              libwebkit2gtk-4.1-dev \
              libgtk-3-dev \
              libayatana-appindicator3-dev \
              librsvg2-dev \
              patchelf

        - name: Setup Node
          uses: actions/setup-node@v4
          with:
            node-version: '22'   # Match the version in the existing macOS workflow (check Task 6 Step 1)
            cache: 'npm'

        - name: Setup Rust
          uses: dtolnay/rust-toolchain@stable

        - name: Cache Rust
          uses: Swatinem/rust-cache@v2
          with:
            workspaces: src-tauri

        - name: Install Node dependencies
          run: npm install

        - name: Build AppImage
          run: npm run tauri build

        - name: Upload AppImage artifact
          uses: actions/upload-artifact@v4
          with:
            name: agent-sessions-linux-appimage
            path: src-tauri/target/release/bundle/appimage/*.AppImage
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add .github/workflows/build-linux.yml
  git commit -m "ci: add Linux AppImage build job"
  ```

- [ ] **Step 4: Push branch and verify CI passes**

  ```bash
  git push -u origin feature/linux-zellij-support
  ```

  Go to `https://github.com/YOUR_USERNAME/agent-sessions/actions` and confirm the Linux build job passes.

---

## Task 7: PR Preparation

- [ ] **Step 1: Verify macOS code is untouched**

  ```bash
  git diff main -- src-tauri/src/terminal/applescript.rs \
                   src-tauri/src/terminal/iterm.rs \
                   src-tauri/src/terminal/terminal_app.rs \
                   src-tauri/src/process/claude.rs
  ```

  Expected: empty diff — zero lines changed in macOS-specific files.

- [ ] **Step 2: Review full diff**

  ```bash
  git diff main
  ```

  Walk through every changed line. Confirm:
  - No reformatting of existing code
  - No unrelated changes
  - All new code is behind `#[cfg(target_os = "linux")]` or in new files

- [ ] **Step 3: Write PR description**

  Create `docs/pr-description.md`:

  ```markdown
  ## Linux Support (Process Discovery + Zellij Terminal Focusing)

  Adds Linux support to agent-sessions. All changes are additive — zero lines
  of existing macOS code are modified.

  ### What's added

  - **`process/linux.rs`** — Linux process discovery using `sysinfo` + `/proc`.
    Handles Linux TTY format (`pts/N` → `/dev/pts/N`) and mirrors the macOS
    orphan detection logic.

  - **`terminal/zellij.rs`** — Zellij focusing backend. Uses a shell hook
    (see below) to name panes `claude-<pid>`, then calls
    `zellij action focus-pane --name` to focus them.

  - **`terminal/linux.rs`** — Linux orchestrator that tries tmux (already
    cross-platform) then Zellij in sequence. Extensible: future backends
    (GNOME Terminal, Kitty, etc.) add one entry to the sequence.

  - **`scripts/shell-hook.sh`** — Zsh/Bash hook. One-line install into
    `.zshrc`. No-op outside Zellij (`$ZELLIJ` guard). Required only for
    terminal focusing; session monitoring works without it.

  - **`.github/workflows/build-linux.yml`** — CI job producing a verified
    AppImage on Ubuntu 22.04.

  ### Setup (Linux users)

  1. Add to `~/.zshrc`:
     ```bash
     source ~/.config/agent-sessions/shell-hook.sh
     ```
  2. Copy `scripts/shell-hook.sh` to `~/.config/agent-sessions/shell-hook.sh`

  ### Tested on
  - **Update this with your actual environment before submitting** (e.g. Ubuntu 24.04, Zellij 0.43.0, Zsh)
  ```

- [ ] **Step 4: PR description is ready**

  `docs/pr-description.md` is now ready. Opening the PR against upstream is a manual step — do it when you are satisfied with the implementation.
