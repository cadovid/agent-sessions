# Session History Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible left panel showing all past Claude sessions grouped by project, with search and click-to-resume in a new Zellij tab.

**Architecture:** New Rust module (`session/history.rs`) scans all JSONL files and returns grouped history. New Zellij function opens a tab and types `claude --resume`. New React component (`HistoryPanel.tsx`) renders the collapsible panel with search. Layout change in `App.tsx` wraps content in a flex row.

**Tech Stack:** Rust (Tauri commands, serde, fs), TypeScript/React (Tailwind CSS, Tauri invoke API), Zellij CLI

**Spec:** `docs/superpowers/specs/2026-03-22-session-history-panel-design.md`

**Working directory:** `/home/david/Personal/agent-sessions`

**Environment:** `. "$HOME/.cargo/env" && export PKG_CONFIG_PATH="/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig"` before any cargo commands.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src-tauri/src/session/history.rs` | History data structures + scanning logic |
| Create | `src/components/HistoryPanel.tsx` | Collapsible panel UI component |
| Create | `src/hooks/useSessionHistory.ts` | History state management hook |
| Modify | `src-tauri/src/session/mod.rs` | Export history module |
| Modify | `src-tauri/src/terminal/zellij.rs` | Add `resume_in_new_tab()` function |
| Modify | `src-tauri/src/commands/handlers.rs` | Add `get_session_history` + `resume_session` commands |
| Modify | `src-tauri/src/lib.rs` | Register new commands |
| Modify | `src/types/session.ts` | Add history TypeScript interfaces |
| Modify | `src/App.tsx` | Flex layout + wire refresh to history |

---

## Task 1: Backend — History Data Structures and Scanning

**Files:**
- Create: `src-tauri/src/session/history.rs`
- Modify: `src-tauri/src/session/mod.rs`

This task creates the Rust module that scans `~/.claude/projects/` and returns all past sessions grouped by project.

- [ ] **Step 1: Create `history.rs` with data structures and scanning logic**

Create `src-tauri/src/session/history.rs`:

```rust
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use log::debug;

use super::model::JsonlMessage;
use super::parser::convert_dir_name_to_path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryResponse {
    pub projects: Vec<ProjectHistory>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistory {
    pub project_path: String,
    pub project_name: String,
    pub sessions: Vec<HistorySession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    pub session_id: String,
    pub cwd: String,
    pub last_activity_at: String,
    pub git_branch: Option<String>,
    pub last_message: Option<String>,
    pub last_message_role: Option<String>,
}

/// Scan all JSONL files under ~/.claude/projects/ and return grouped history.
pub fn get_session_history() -> SessionHistoryResponse {
    let claude_dir = match dirs::home_dir() {
        Some(home) => home.join(".claude").join("projects"),
        None => return SessionHistoryResponse { projects: vec![] },
    };

    if !claude_dir.exists() {
        return SessionHistoryResponse { projects: vec![] };
    }

    let mut projects: Vec<ProjectHistory> = Vec::new();

    // Iterate over project directories
    let entries = match fs::read_dir(&claude_dir) {
        Ok(e) => e,
        Err(_) => return SessionHistoryResponse { projects: vec![] },
    };

    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }

        let dir_name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };

        let project_path = convert_dir_name_to_path(&dir_name);
        let project_name = project_path
            .split('/')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or(&dir_name)
            .to_string();

        // List JSONL files, excluding agent-*.jsonl (sub-agent files)
        let mut sessions: Vec<HistorySession> = Vec::new();
        let jsonl_files = match fs::read_dir(&dir_path) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for file_entry in jsonl_files.flatten() {
            let file_path = file_entry.path();
            let file_name = match file_entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };

            // Only process *.jsonl files, skip agent-*.jsonl
            if !file_name.ends_with(".jsonl") || file_name.starts_with("agent-") {
                continue;
            }

            // Extract session ID from filename (strip .jsonl)
            let session_id = file_name.trim_end_matches(".jsonl").to_string();

            if let Some(session) = parse_history_session(&file_path, &session_id, &project_path) {
                sessions.push(session);
            }
        }

        // Sort sessions by date descending
        sessions.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));

        if !sessions.is_empty() {
            projects.push(ProjectHistory {
                project_path,
                project_name,
                sessions,
            });
        }
    }

    // Sort projects by most recent session date descending
    projects.sort_by(|a, b| {
        let a_latest = a.sessions.first().map(|s| s.last_activity_at.as_str()).unwrap_or("");
        let b_latest = b.sessions.first().map(|s| s.last_activity_at.as_str()).unwrap_or("");
        b_latest.cmp(a_latest)
    });

    debug!("Session history: found {} projects with sessions", projects.len());
    SessionHistoryResponse { projects }
}

/// Parse a single JSONL file to extract history session data.
/// Reads the last ~20 lines for the most recent message and first ~20 lines for cwd.
fn parse_history_session(
    jsonl_path: &PathBuf,
    session_id: &str,
    fallback_cwd: &str,
) -> Option<HistorySession> {
    let metadata = fs::metadata(jsonl_path).ok()?;
    if metadata.len() == 0 {
        return None;
    }

    // Extract cwd from first lines
    let cwd = extract_cwd(jsonl_path).unwrap_or_else(|| fallback_cwd.to_string());

    // Read last ~20 lines for recent message data
    let last_lines = read_last_lines(jsonl_path, 20)?;

    let mut last_activity_at: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut last_message: Option<String> = None;
    let mut last_message_role: Option<String> = None;

    // Process lines in reverse (newest first)
    for line in last_lines.iter().rev() {
        if let Ok(msg) = serde_json::from_str::<JsonlMessage>(line) {
            // Take the first (most recent) timestamp we find
            if last_activity_at.is_none() {
                last_activity_at = msg.timestamp.clone();
            }

            // Take the first git branch we find
            if git_branch.is_none() {
                git_branch = msg.git_branch.clone();
            }

            // Take the first message with actual content
            if last_message.is_none() {
                if let Some(ref message) = msg.message {
                    if let Some(ref role) = message.role {
                        if let Some(ref content) = message.content {
                            let text = extract_text_content(content);
                            if !text.is_empty() {
                                last_message = Some(text.chars().take(100).collect());
                                last_message_role = Some(role.clone());
                            }
                        }
                    }
                }
            }

            // Stop once we have everything
            if last_activity_at.is_some() && git_branch.is_some() && last_message.is_some() {
                break;
            }
        }
    }

    // Need at least a timestamp
    let last_activity_at = last_activity_at?;

    Some(HistorySession {
        session_id: session_id.to_string(),
        cwd,
        last_activity_at,
        git_branch,
        last_message,
        last_message_role,
    })
}

/// Extract cwd from the first ~20 lines of a JSONL file.
fn extract_cwd(jsonl_path: &PathBuf) -> Option<String> {
    let file = File::open(jsonl_path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines().take(20).flatten() {
        if let Ok(msg) = serde_json::from_str::<JsonlMessage>(&line) {
            if let Some(cwd) = msg.cwd {
                if cwd.starts_with('/') {
                    return Some(cwd);
                }
            }
        }
    }
    None
}

/// Read the last N lines from a file efficiently.
fn read_last_lines(path: &PathBuf, n: usize) -> Option<Vec<String>> {
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    let file_size = metadata.len();

    if file_size == 0 {
        return None;
    }

    // Read from the end — start with last 64KB or full file
    let read_size = std::cmp::min(file_size, 65536) as usize;
    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::End(-(read_size as i64))).ok()?;

    let mut lines: Vec<String> = Vec::new();
    for line in reader.lines().flatten() {
        lines.push(line);
    }

    // Take last N
    let start = if lines.len() > n { lines.len() - n } else { 0 };
    Some(lines[start..].to_vec())
}

/// Extract text content from a JSONL message content field.
fn extract_text_content(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => {
            for item in arr {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if let Some(item_type) = item.get("type").and_then(|t| t.as_str()) {
                        if item_type == "text" {
                            return text.to_string();
                        }
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_text_content_string() {
        let content = serde_json::json!("Hello world");
        assert_eq!(extract_text_content(&content), "Hello world");
    }

    #[test]
    fn test_extract_text_content_array() {
        let content = serde_json::json!([
            {"type": "text", "text": "Hello from array"}
        ]);
        assert_eq!(extract_text_content(&content), "Hello from array");
    }

    #[test]
    fn test_extract_text_content_array_with_tool_use() {
        let content = serde_json::json!([
            {"type": "tool_use", "name": "Read"},
            {"type": "text", "text": "Let me read that file"}
        ]);
        assert_eq!(extract_text_content(&content), "Let me read that file");
    }

    #[test]
    fn test_extract_text_content_empty() {
        let content = serde_json::json!(null);
        assert_eq!(extract_text_content(&content), "");
    }

    #[test]
    fn test_get_session_history_returns_response() {
        // Smoke test: function runs without panic
        let response = get_session_history();
        let _ = response.projects;
    }
}
```

- [ ] **Step 2: Wire `history.rs` into `session/mod.rs`**

Open `src-tauri/src/session/mod.rs`. Add the history module and export:

```rust
// Add this line after the existing module declarations:
pub mod history;

// Add to the pub use line:
pub use history::{get_session_history, SessionHistoryResponse};
```

The current content of `mod.rs` is:
```rust
mod model;
pub mod parser;
mod status;

pub use model::{AgentType, Session, SessionStatus, SessionsResponse};
pub use parser::{...};
pub use status::{...};
```

Add `pub mod history;` after `mod status;` and add `pub use history::{get_session_history, SessionHistoryResponse};` after the existing pub use lines.

- [ ] **Step 3: Verify it compiles**

```bash
. "$HOME/.cargo/env" && export PKG_CONFIG_PATH="/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig" && cd /home/david/Personal/agent-sessions && cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored
```

Expected: all tests pass including the new `history::tests` tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/session/history.rs src-tauri/src/session/mod.rs
git commit -m "feat: add session history scanning module"
```

---

## Task 2: Backend — Resume Session via Zellij

**Files:**
- Modify: `src-tauri/src/terminal/zellij.rs`

Adds a function to open a new Zellij tab and run `claude --resume <id>`.

- [ ] **Step 1: Add `resume_in_new_tab` function to `zellij.rs`**

Add this function after `focus_zellij_pane_by_pid` (before `raise_zellij_terminal_window`):

```rust
/// Open a new Zellij tab and resume a Claude session in it.
///
/// 1. Creates a new tab with --cwd set to the project directory
/// 2. Types `claude --resume <session_id>` into the new tab
/// 3. Raises the terminal window to the foreground
pub fn resume_in_new_tab(session_id: &str, project_path: &str) -> Result<(), String> {
    let zellij_session = get_zellij_session()
        .ok_or_else(|| "No active Zellij session found".to_string())?;

    // Create a new tab with the project directory as cwd
    let new_tab_result = Command::new("zellij")
        .args([
            "--session", &zellij_session,
            "action", "new-tab",
            "--cwd", project_path,
            "--name", "claude-resume",
        ])
        .output()
        .map_err(|e| format!("Failed to create Zellij tab: {}", e))?;

    if !new_tab_result.status.success() {
        let stderr = String::from_utf8_lossy(&new_tab_result.stderr);
        return Err(format!("Failed to create Zellij tab: {}", stderr.trim()));
    }

    // Brief pause for the tab shell to initialize
    std::thread::sleep(std::time::Duration::from_millis(150));

    // Type the resume command into the new tab
    let resume_cmd = format!("claude --resume {}\n", session_id);
    let write_result = Command::new("zellij")
        .args([
            "--session", &zellij_session,
            "action", "write-chars",
            &resume_cmd,
        ])
        .output()
        .map_err(|e| format!("Failed to write resume command: {}", e))?;

    if !write_result.status.success() {
        let stderr = String::from_utf8_lossy(&write_result.stderr);
        return Err(format!("Failed to write resume command: {}", stderr.trim()));
    }

    // Raise the terminal window
    raise_zellij_terminal_window();

    Ok(())
}
```

- [ ] **Step 2: Make `get_zellij_session` and `raise_zellij_terminal_window` pub(crate)**

These functions are currently private (`fn`). Change their visibility so the handlers module can access `resume_in_new_tab` (which calls them internally — they stay private, but `resume_in_new_tab` needs to be `pub`):

Actually, `resume_in_new_tab` calls them internally within the same file, so no visibility change needed. Just make `resume_in_new_tab` itself `pub`.

The function signature already has `pub fn resume_in_new_tab(...)` — that's sufficient.

- [ ] **Step 3: Verify it compiles**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/terminal/zellij.rs
git commit -m "feat: add Zellij resume-in-new-tab function"
```

---

## Task 3: Backend — Wire Commands to Tauri

**Files:**
- Modify: `src-tauri/src/commands/handlers.rs`
- Modify: `src-tauri/src/lib.rs`

Registers the two new Tauri commands so the frontend can call them.

- [ ] **Step 1: Add commands to `handlers.rs`**

Add these two functions at the end of `handlers.rs` (before the closing of the file):

```rust
use crate::session::history;

/// Get all past Claude sessions grouped by project
#[tauri::command]
pub fn get_session_history() -> history::SessionHistoryResponse {
    history::get_session_history()
}

/// Resume a past Claude session in a new Zellij tab
#[tauri::command]
pub fn resume_session(session_id: String, project_path: String) -> Result<(), String> {
    crate::terminal::zellij::resume_in_new_tab(&session_id, &project_path)
}
```

Also add the `use crate::session::history;` import at the top of the file, after the existing `use` statements.

> **Note:** On macOS, `resume_session` would fail since it calls `zellij::resume_in_new_tab` which is behind `#[cfg(target_os = "linux")]`. To compile on both platforms, wrap the `resume_session` command:

```rust
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
```

- [ ] **Step 2: Register commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add the new commands to the import line and the `invoke_handler`:

Update the import line (line 20):
```rust
use commands::{get_all_sessions, focus_session, update_tray_title, register_shortcut, unregister_shortcut, kill_session, get_session_history, resume_session};
```

Update the invoke_handler (line 33):
```rust
.invoke_handler(tauri::generate_handler![get_all_sessions, focus_session, update_tray_title, register_shortcut, unregister_shortcut, kill_session, get_session_history, resume_session])
```

- [ ] **Step 3: Verify it compiles**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 4: Run all tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/handlers.rs src-tauri/src/lib.rs
git commit -m "feat: register get_session_history and resume_session commands"
```

---

## Task 4: Frontend — TypeScript Types and Hook

**Files:**
- Modify: `src/types/session.ts`
- Create: `src/hooks/useSessionHistory.ts`

- [ ] **Step 1: Add history types to `session.ts`**

Append these interfaces to the end of `src/types/session.ts`:

```typescript
export interface HistorySession {
  sessionId: string;
  cwd: string;
  lastActivityAt: string;
  gitBranch: string | null;
  lastMessage: string | null;
  lastMessageRole: 'user' | 'assistant' | null;
}

export interface ProjectHistory {
  projectPath: string;
  projectName: string;
  sessions: HistorySession[];
}

export interface SessionHistoryResponse {
  projects: ProjectHistory[];
}
```

- [ ] **Step 2: Create `useSessionHistory.ts` hook**

Create `src/hooks/useSessionHistory.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SessionHistoryResponse } from '../types/session';

export function useSessionHistory() {
  const [history, setHistory] = useState<SessionHistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await invoke<SessionHistoryResponse>('get_session_history');
      setHistory(response);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch session history');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resumeSession = useCallback(async (sessionId: string, cwd: string) => {
    try {
      setResumeError(null);
      await invoke('resume_session', { sessionId, projectPath: cwd });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resume session';
      setResumeError(message);
      // Clear error after 5 seconds
      setTimeout(() => setResumeError(null), 5000);
    }
  }, []);

  // Load once on mount
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return {
    history,
    isLoading,
    error,
    resumeError,
    refresh: fetchHistory,
    resumeSession,
  };
}
```

- [ ] **Step 3: Verify frontend compiles**

```bash
cd /home/david/Personal/agent-sessions && npx tsc --noEmit
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/session.ts src/hooks/useSessionHistory.ts
git commit -m "feat: add session history types and hook"
```

---

## Task 5: Frontend — HistoryPanel Component

**Files:**
- Create: `src/components/HistoryPanel.tsx`

This is the main UI component — the collapsible left panel with search and session list.

- [ ] **Step 1: Create `HistoryPanel.tsx`**

Create `src/components/HistoryPanel.tsx`:

```tsx
import { useState, useMemo } from 'react';
import { ProjectHistory, HistorySession } from '../types/session';

interface HistoryPanelProps {
  history: { projects: ProjectHistory[] } | null;
  isLoading: boolean;
  error: string | null;
  resumeError: string | null;
  onResumeSession: (sessionId: string, cwd: string) => void;
}

const PANEL_KEY = 'agent-sessions-history-panel-expanded';

export function HistoryPanel({ history, isLoading, error, resumeError, onResumeSession }: HistoryPanelProps) {
  const [isExpanded, setIsExpanded] = useState(() => {
    return localStorage.getItem(PANEL_KEY) === 'true';
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleExpanded = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    localStorage.setItem(PANEL_KEY, String(next));
  };

  const toggleGroup = (projectPath: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(projectPath)) {
        next.delete(projectPath);
      } else {
        next.add(projectPath);
      }
      return next;
    });
  };

  // Client-side filtering
  const filteredProjects = useMemo(() => {
    if (!history || !searchQuery.trim()) return history?.projects ?? [];

    const q = searchQuery.toLowerCase();
    return history.projects
      .map(project => ({
        ...project,
        sessions: project.sessions.filter(s =>
          project.projectName.toLowerCase().includes(q) ||
          project.projectPath.toLowerCase().includes(q) ||
          (s.gitBranch && s.gitBranch.toLowerCase().includes(q)) ||
          (s.lastMessage && s.lastMessage.toLowerCase().includes(q))
        ),
      }))
      .filter(project => project.sessions.length > 0);
  }, [history, searchQuery]);

  // Collapsed rail
  if (!isExpanded) {
    return (
      <div
        onClick={toggleExpanded}
        className="w-9 flex-shrink-0 bg-card/50 border-r border-border flex flex-col items-center pt-4 gap-2 cursor-pointer hover:bg-card transition-colors"
        title="Expand session history"
      >
        <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        <span
          className="text-[10px] text-muted-foreground tracking-widest uppercase"
          style={{ writingMode: 'vertical-lr' }}
        >
          History
        </span>
      </div>
    );
  }

  // Expanded panel
  return (
    <div className="w-72 flex-shrink-0 bg-card/50 border-r border-border flex flex-col overflow-hidden">
      {/* Header with search and close */}
      <div className="p-3 border-b border-border flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">History</span>
          <button
            onClick={toggleExpanded}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Collapse"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search sessions..."
          className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Error messages */}
      {resumeError && (
        <div className="mx-3 mt-2 p-2 text-xs text-destructive bg-destructive/10 rounded border border-destructive/20">
          {resumeError}
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">Loading...</div>
        ) : error ? (
          <div className="p-4 text-center text-xs text-destructive">{error}</div>
        ) : filteredProjects.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {searchQuery ? 'No matching sessions' : 'No session history found'}
          </div>
        ) : (
          filteredProjects.map(project => (
            <div key={project.projectPath} className="border-b border-border last:border-b-0">
              {/* Project group header */}
              <button
                onClick={() => toggleGroup(project.projectPath)}
                className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-muted/50 transition-colors"
              >
                <span className="text-xs font-medium text-foreground truncate" title={project.projectPath}>
                  {formatProjectPath(project.projectPath)}
                </span>
                <svg
                  className={`w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform ${
                    collapsedGroups.has(project.projectPath) ? '-rotate-90' : ''
                  }`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Sessions in group */}
              {!collapsedGroups.has(project.projectPath) && (
                <div>
                  {project.sessions.map(session => (
                    <SessionEntry
                      key={session.sessionId}
                      session={session}
                      onClick={() => onResumeSession(session.sessionId, session.cwd)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SessionEntry({ session, onClick }: { session: HistorySession; onClick: () => void }) {
  const date = formatDate(session.lastActivityAt);
  const branch = session.gitBranch || '';

  return (
    <button
      onClick={onClick}
      className="w-full px-3 py-1.5 pl-5 text-left hover:bg-muted/50 transition-colors group"
      title={`Resume session ${session.sessionId}\n${session.cwd}`}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-muted-foreground flex-shrink-0">{date}</span>
        {branch && (
          <span className="text-foreground/70 truncate font-mono text-[10px]">{branch}</span>
        )}
      </div>
      {session.lastMessage && (
        <div className="text-[10px] text-muted-foreground truncate mt-0.5 group-hover:text-foreground/70">
          {session.lastMessage}
        </div>
      )}
    </button>
  );
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function formatProjectPath(path: string): string {
  // Shorten home directory prefix
  const home = '~';
  if (path.startsWith('/home/')) {
    const parts = path.split('/');
    // /home/user/rest -> ~/rest
    if (parts.length > 3) {
      return home + '/' + parts.slice(3).join('/');
    }
  }
  return path;
}
```

- [ ] **Step 2: Verify frontend compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/components/HistoryPanel.tsx
git commit -m "feat: add HistoryPanel collapsible component"
```

---

## Task 6: Frontend — App Layout Integration

**Files:**
- Modify: `src/App.tsx`

Wires the `HistoryPanel` into the app layout and connects the refresh button.

- [ ] **Step 1: Update `App.tsx`**

The current `App.tsx` has this structure:
```tsx
<div className="min-h-screen bg-background flex flex-col">
  <header>...</header>
  <Settings ... />
  <main className="flex-1 overflow-y-auto p-6">
    {/* error | empty | SessionGrid */}
  </main>
</div>
```

Transform it to:
1. Import `HistoryPanel` and `useSessionHistory`
2. Add the `useSessionHistory()` hook call
3. Extend the refresh button to also call `historyRefresh`
4. Wrap the `<main>` content area in a flex row with `HistoryPanel`

The updated `App.tsx` should have these changes:

**Add imports (top of file):**
```tsx
import { HistoryPanel } from './components/HistoryPanel';
import { useSessionHistory } from './hooks/useSessionHistory';
```

**Add hook call (inside App function, after `useSessions()`):**
```tsx
const {
  history,
  isLoading: historyLoading,
  error: historyError,
  resumeError,
  refresh: refreshHistory,
  resumeSession,
} = useSessionHistory();
```

**Update the refresh button handler** — change `onClick={refresh}` to:
```tsx
onClick={() => { refresh(); refreshHistory(); }}
```

**Wrap `<main>` in a flex row** — change:
```tsx
<main className="flex-1 overflow-y-auto p-6">
```
to:
```tsx
<main className="flex-1 flex overflow-hidden">
  <HistoryPanel
    history={history}
    isLoading={historyLoading}
    error={historyError}
    resumeError={resumeError}
    onResumeSession={resumeSession}
  />
  <div className="flex-1 overflow-y-auto p-6">
```

And add the closing `</div>` before `</main>`.

The session grid content (error/empty/grid) stays inside the new `<div className="flex-1 overflow-y-auto p-6">` wrapper.

- [ ] **Step 2: Verify frontend compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Verify full build**

```bash
. "$HOME/.cargo/env" && export PKG_CONFIG_PATH="/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig" && npm run tauri build 2>&1 | tail -5
```

Expected: AppImage produced successfully.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: integrate HistoryPanel into app layout"
```

---

## Task 7: Manual Testing

This task verifies the full feature end-to-end.

- [ ] **Step 1: Launch the AppImage**

```bash
chmod +x "src-tauri/target/release/bundle/appimage/Agent Sessions_0.1.27_amd64.AppImage"
"./src-tauri/target/release/bundle/appimage/Agent Sessions_0.1.27_amd64.AppImage" &
```

- [ ] **Step 2: Verify collapsed rail**

Expected: thin rail on the left with hamburger icon and "HISTORY" text.

- [ ] **Step 3: Expand the panel**

Click the rail. Expected: panel expands to ~300px showing search bar and project-grouped sessions.

- [ ] **Step 4: Test search**

Type a project name or branch name. Expected: list filters in real-time.

- [ ] **Step 5: Test resume**

Click a past session. Expected: new Zellij tab opens with `claude --resume <id>` running. Terminal window comes to foreground.

- [ ] **Step 6: Test refresh**

Click the app refresh button. Expected: both active sessions and history update.

- [ ] **Step 7: Test persistence**

Close and reopen the app. Expected: panel collapsed/expanded state is preserved.
