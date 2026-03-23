# Linux & Zellij Support for agent-sessions

**Date:** 2026-03-20
**Status:** Approved
**Branch:** `feature/linux-zellij-support`
**Upstream:** https://github.com/ozankasikci/agent-sessions
**Goal:** Contribute Linux support (process discovery + terminal focusing) back upstream via PR

---

## 1. Overview

`agent-sessions` is a Tauri 2.x desktop application (Rust backend + React/TypeScript frontend) that monitors Claude Code sessions in real-time. It currently runs on macOS only, with terminal focusing implemented via AppleScript for iTerm2 and Terminal.app.

This design adds Linux support by:
- Adapting process discovery for the Linux `/proc` filesystem and PTY conventions
- Implementing a Zellij terminal focusing backend via shell hooks + CLI commands
- Adding a Linux terminal orchestrator that tries backends in sequence (tmux → Zellij → future)
- Keeping all macOS code untouched, using `#[cfg(target_os)]` guards for platform routing

The implementation approach is **additive only** — new files alongside existing ones, minimal diffs to existing files — to maximize upstream PR acceptance.

---

## 2. Repository Strategy

**Fork:** `ozankasikci/agent-sessions` → user's GitHub account
**Branch:** `feature/linux-zellij-support`
**Sync:** `main` stays in sync with upstream; all work on the feature branch
**PR target:** `ozankasikci/agent-sessions` main branch when complete

**Commit discipline:**
- One commit per logical unit (process discovery, Zellij backend, shell hook, CI)
- No reformatting of existing code
- No unrelated cleanups or refactors
- Commit messages follow the existing repo style

---

## 3. Architecture

The original layered structure is preserved and extended:

```
Process Discovery  →  Session Parsing  →  Status Detection  →  Terminal Focusing
  (OS-specific)         (cross-platform)    (cross-platform)      (OS-specific)
```

**Unchanged (cross-platform, zero modifications):**
- `session/parser.rs` — JSONL transcript reading
- `session/status.rs` — status state machine
- `session/model.rs` — data structures
- All React/TypeScript frontend

**New files added:**

```
src-tauri/src/
├── process/
│   └── linux.rs                     # Linux process discovery via sysinfo + /proc
│
└── terminal/
    ├── zellij.rs                     # Zellij focusing backend
    └── linux.rs                      # Linux orchestrator (tmux → zellij → ...)

scripts/
└── shell-hook.sh                     # Zellij shell hook installer
```

**Minimally modified files** (only to wire in new modules under `#[cfg]`):
- `src-tauri/src/process/mod.rs`
- `src-tauri/src/terminal/mod.rs`
- `Cargo.toml` (if any Linux-specific dependencies are needed)
- `.github/workflows/` (add Linux build job)

---

## 4. Linux Process Discovery (`process/linux.rs`)

Adapts the existing `process/claude.rs` logic for Linux conventions:

**TTY normalization:** `ps -p <pid> -o tty=` returns `pts/N` on Linux. This is normalized to `/dev/pts/N` for downstream PTY matching.

**Orphan detection:** Identical logic to macOS — if the parent shell's PPID is `1` (reparented to systemd/init after terminal closure), the Claude process is considered orphaned and skipped.

**Healthy parent chain:**
```
claude → shell → zellij-client (or other terminal emulator)
```

**Sub-agent detection:** Unchanged — scans `~/.claude/projects/**/*.jsonl` for files matching `agent-*.jsonl` modified within 30 seconds. Pure filesystem I/O, identical on Linux.

**Platform routing in `process/mod.rs`:**
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

---

## 5. Shell Hook Mechanism

**Problem:** Zellij's CLI has no command to find which pane owns a given PID or TTY.

**Solution:** A shell hook renames the current Zellij pane to `claude-<pid>` when Claude starts, enabling the desktop app to focus it by name.

**Hook lifecycle:**
```
preexec fires (command starts)  →  if command is 'claude': rename pane to "claude-<pid>"
precmd fires (command exits)    →  rename pane back to original name
```

**Implementation (`scripts/shell-hook.sh`):**
- Zsh (`preexec` / `precmd`) and Bash (`DEBUG` trap / `PROMPT_COMMAND`) variants
- Guarded by `$ZELLIJ` environment variable check — Zellij injects this automatically, so the hook is a no-op outside Zellij
- One-line install instruction: `source ~/.config/agent-sessions/shell-hook.sh`

**User setup cost:** One line added to `.zshrc` or `.bashrc`. Required for the focusing feature; session monitoring works without it.

---

## 6. Zellij Backend (`terminal/zellij.rs`)

Mirrors the structure and return contract of `iterm.rs`.

**Given a Claude process PID:**
1. Construct pane name: `claude-<pid>`
2. Run `zellij action focus-pane --name claude-<pid>`
3. On failure, fall back to `zellij action go-to-tab-name claude-<pid>` (compatibility with older Zellij versions)
4. Return `Ok(())` on success, `Err("not found")` on failure

No AppleScript. No PTY lookup. Two CLI calls.

---

## 7. Linux Terminal Orchestrator (`terminal/linux.rs`)

Mirrors the macOS sequential fallback pattern (macOS already tries tmux → iTerm2 → Terminal.app).

```
focus_terminal(pid):
  1. $TMUX set?    → try tmux.rs   (already cross-platform)
  2. $ZELLIJ set?  → try zellij.rs
  3. (future)      → GNOME Terminal, Kitty, WezTerm, etc.
  Return first Ok(()), or silent failure if all backends fail
```

Backend availability is detected via environment variables (`$TMUX`, `$ZELLIJ`) and binary presence on `$PATH`. This pattern is extensible — future terminal backends are added as new entries in the sequence with no changes to existing code.

**Platform routing in `terminal/mod.rs`:**
```rust
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::focus_terminal;

#[cfg(target_os = "macos")]
// existing code untouched
```

---

## 8. Build & Toolchain

**Rust:** Install via `rustup` (not currently on system). Tauri 2.x requires Rust stable.

**Linux system dependencies (via `apt`):**
```
libwebkit2gtk-4.1-dev
libgtk-3-dev
libayatana-appindicator3-dev
librsvg2-dev
patchelf
```
Standard Tauri 2.x Linux prerequisites, documented upstream.

**Build commands:**
- `cargo tauri dev` — development build with hot reload
- `cargo tauri build` — produces AppImage + `.deb`

**Output artifact:** AppImage (portable, no install required, works across distros). Ideal for initial distribution and for attaching to the upstream PR as a Linux release artifact.

**Frontend:** No changes. `npm install` + Vite build works identically on Linux.

**CI (`github/workflows/`):** Add a Linux build job alongside the existing macOS job. Builds the AppImage and confirms the Linux target compiles cleanly — makes the PR self-evidencing for the upstream maintainer.

---

## 9. What Is Explicitly Out of Scope

- Changes to the React/TypeScript frontend
- Modifications to session parsing, status detection, or data models
- Support for specific Linux terminals beyond Zellij (the orchestrator is designed for future extension, but no other backend is implemented in this PR)
- Bash hook support (Zsh only in initial implementation; Bash variant is a stretch goal)
- Auto-installation of the shell hook (manual setup only)

---

## 10. Success Criteria

- `cargo tauri build` produces a working AppImage on Linux
- Session monitoring (steps 1–3) works on Linux with no shell hook required
- Clicking a session focuses the correct Zellij pane when the shell hook is installed
- Clicking a session fails silently when Zellij is not running or hook is not installed
- All existing macOS tests pass unchanged
- PR diff touches zero lines of existing macOS-specific code
