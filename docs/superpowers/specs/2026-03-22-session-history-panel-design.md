# Session History Panel

**Date:** 2026-03-22
**Status:** Approved
**Branch:** `feature/claude-resume-support`
**Goal:** Add a collapsible left panel showing all past Claude sessions grouped by project, with search and click-to-resume in a new Zellij tab.

---

## 1. Overview

The Agent Sessions desktop app currently shows only active/running Claude sessions. This design adds a collapsible side panel that surfaces all past sessions stored in `~/.claude/projects/`, organized by project directory and ordered by date descending. Users can search, browse, and click a session to resume it in a new Zellij tab.

The feature is purely additive — no changes to existing session monitoring, focusing, status detection, or polling logic.

---

## 2. Architecture

Three new components:

| Component | Location | Purpose |
|-----------|----------|---------|
| `get_session_history` command | Rust backend | Scan all JSONL files, return grouped history |
| `resume_session` command | Rust backend | Open new Zellij tab with `claude --resume` |
| `HistoryPanel` component | React frontend | Collapsible panel with search + session list |

Plus a layout adjustment to `App.tsx` to place the panel alongside the existing session grid.

---

## 3. Backend — `get_session_history` Command

**Signature:**
```rust
#[tauri::command]
pub fn get_session_history() -> SessionHistoryResponse
```

**What it does:**
1. Scans all directories under `~/.claude/projects/`
2. For each directory, lists all `*.jsonl` files (excluding `agent-*.jsonl` sub-agent files)
3. For each JSONL file, reads the last ~20 lines to extract: session ID, timestamp, cwd, git branch, last message preview, and last message role
4. Groups sessions by project directory
5. Orders sessions within each group by date descending
6. Orders project groups by their most recent session date descending

**Response shape:**
```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryResponse {
    pub projects: Vec<ProjectHistory>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistory {
    pub project_path: String,
    pub project_name: String,
    pub sessions: Vec<HistorySession>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    pub session_id: String,
    pub cwd: String,  // actual working directory from JSONL (may differ from project path)
    pub last_activity_at: String,
    pub git_branch: Option<String>,
    pub last_message: Option<String>,
    pub last_message_role: Option<String>,
}
```

**Performance constraint:** Only reads the last ~20 lines of each JSONL file (same approach as the existing parser). Not called in the 2-second polling loop — loaded once on app startup and refreshed only when the user clicks the existing refresh button.

---

## 4. Backend — `resume_session` Command

**Signature:**
```rust
#[tauri::command]
pub fn resume_session(session_id: String, project_path: String) -> Result<(), String>
```

**What it does:**
1. Discovers the active Zellij session name via `zellij list-sessions -n -s`
2. Creates a new Zellij tab: `zellij --session <name> action new-tab --cwd <project_path> --name "claude-resume"`
3. Brief pause for tab initialization (~100ms)
4. Types the resume command: `zellij --session <name> action write-chars "claude --resume <session_id>\n"`
5. Calls `raise_zellij_terminal_window()` (existing function) to bring the terminal to the foreground

The `write-chars` approach is used because `new-tab --command` doesn't handle arguments with flags cleanly. Writing keystrokes into the new shell is more reliable.

**Error handling:** Returns `Err` if no Zellij session is found or if any Zellij CLI command fails.

---

## 5. Frontend — `HistoryPanel` Component

### Collapsed state (~36px wide)
A thin rail on the left side showing a hamburger icon and vertical "HISTORY" text. Clicking anywhere on the rail expands the panel.

### Expanded state (~300px wide)

```
[Search bar                    ] [x close]
─────────────────────────────────
~/Projects/app              ▼
  Mar 22  main    Fixed auth bug...
  Mar 20  feat/x  Add tests for...
  Mar 18  main    Refactor login...
─────────────────────────────────
~/Projects/api              ▼
  Mar 21  main    Add endpoint...
─────────────────────────────────
~/Personal/dotfiles         ▼
  Mar 19  HEAD    Update zshrc...
```

### Session entry display (2 lines)
- **Line 1:** Date (e.g., "Mar 22") + git branch
- **Line 2:** Last message preview (truncated)

### Interactions
- **Search bar** — client-side filtering on already-loaded data. Filters by project name, git branch, or message content.
- **Project groups** — collapsible with a chevron. All expanded by default.
- **Click a session** — invokes `resume_session(session_id, cwd)`. Opens a new Zellij tab in the session's actual working directory with the session resumed. If no Zellij session is active, shows an error message in the panel.
- **Collapse button (x)** — returns to the thin rail state.

### State management
- Panel expanded/collapsed state persisted in `localStorage`
- History data loaded once on component mount
- Refreshed when the existing app refresh button is clicked (alongside active sessions)
- No separate polling or refresh mechanism

---

## 6. Layout Changes to `App.tsx`

**Current layout:**
```
[Header: title + badges + settings + refresh]
[SessionGrid: full width]
```

**New layout:**
```
[Header: title + badges + settings + refresh]     ← unchanged
[HistoryPanel (collapsed/expanded) | SessionGrid]  ← flex row
```

The only structural change to `App.tsx` is wrapping the main content area in a flex container. The header remains untouched. The existing refresh button callback is extended to also call `get_session_history()`.

---

## 7. Data Flow

```
App startup
  → get_session_history() called once
  → Response stored in HistoryPanel state
  → Panel renders grouped session list

User clicks refresh button
  → get_all_sessions() called (existing)
  → get_session_history() called (new)
  → Both states updated

User searches in panel
  → Client-side filter on loaded data
  → No backend call

User clicks a session
  → resume_session(session_id, cwd) called
  → New Zellij tab created with claude --resume
  → Terminal window raised to foreground
```

---

## 8. Files Changed

| Action | Path | Purpose |
|--------|------|---------|
| Create | `src-tauri/src/session/history.rs` | History scanning + data structures |
| Create | `src/components/HistoryPanel.tsx` | Collapsible panel component |
| Create | `src/hooks/useSessionHistory.ts` | History state management hook |
| Modify | `src-tauri/src/commands/handlers.rs` | Add `get_session_history` + `resume_session` commands |
| Modify | `src-tauri/src/lib.rs` | Register new commands |
| Modify | `src-tauri/src/terminal/zellij.rs` | Add `resume_in_new_tab()` function |
| Modify | `src/App.tsx` | Flex layout + wire refresh to history |
| Modify | `src/types/session.ts` | Add history TypeScript interfaces |

---

## 9. Out of Scope

- Editing or deleting past sessions
- Previewing session transcripts
- Pagination (search handles discoverability)
- tmux resume support (Zellij only)
- Changes to existing active session cards, polling, or status detection

---

## 10. Success Criteria

- Panel starts collapsed, expands/collapses on click, persists state across restarts
- All past sessions from `~/.claude/projects/` are listed, grouped by project, ordered by date desc
- Search filters sessions by project name, branch, or message content
- Clicking a session opens a new Zellij tab with `claude --resume <id>` in the correct directory
- Terminal window is raised to the foreground after resume
- History loads only on startup and manual refresh — no impact on the 2-second active session polling
- No changes to existing app functionality
