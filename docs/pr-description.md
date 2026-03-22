## Linux Support (Process Discovery + Zellij Terminal Focusing)

Adds Linux support to agent-sessions. All changes are additive — zero lines
of existing macOS code are modified.

### What's added

- **`terminal/zellij.rs`** — Zellij focusing backend. Uses a shell hook
  to name panes `claude-<pid>`, then calls
  `zellij action focus-pane --name` to focus them.

- **`terminal/linux.rs`** — Linux orchestrator that tries tmux then Zellij
  in sequence. Extensible: future backends (GNOME Terminal, Kitty, etc.)
  add one entry to the sequence.

- **`terminal/mod.rs`** — Added `#[cfg(target_os)]` guards to separate
  macOS and Linux code paths. All existing macOS function bodies unchanged.

- **`scripts/shell-hook.sh`** — Zsh/Bash hook. One-line install into
  `.zshrc`. No-op outside Zellij (`$ZELLIJ` guard). Required only for
  terminal focusing; session monitoring works without it.

- **`.github/workflows/build-linux.yml`** — CI job producing a verified
  AppImage on Ubuntu.

### Process discovery

`process/claude.rs` is already cross-platform (uses `sysinfo` crate) —
no changes needed. Session monitoring works on Linux out of the box.

### Setup (Linux users)

1. Copy `scripts/shell-hook.sh` to `~/.config/agent-sessions/shell-hook.sh`
2. Add to `~/.zshrc` or `~/.bashrc`:
   ```bash
   source ~/.config/agent-sessions/shell-hook.sh
   ```

### Tested on
- **Update this with your actual environment before submitting**
