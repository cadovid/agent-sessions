use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;

use super::model::JsonlMessage;
use super::parser::convert_dir_name_to_path;

/// Response containing session history grouped by project
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryResponse {
    pub projects: Vec<ProjectHistory>,
}

/// History for a single project
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistory {
    pub project_path: String,
    pub project_name: String,
    pub project_dir_name: String,
    pub sessions: Vec<HistorySession>,
}

/// A single past session
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    pub session_id: String,
    pub cwd: String,
    pub last_activity_at: String,
    pub git_branch: Option<String>,
    pub recent_messages: Vec<MessagePreview>,
    pub subagents: Vec<SubagentInfo>,
}

/// A single message preview (text + role)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePreview {
    pub text: String,
    pub role: String,
}

/// Info about a subagent spawned by a session
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub agent_id: String,
    pub slug: Option<String>,
    pub task_description: Option<String>,
    pub timestamp: Option<String>,
    pub event_count: usize,
}

/// Extract text content from a serde_json::Value.
/// - If it's a string, return it directly.
/// - If it's an array, find the first item with `"type": "text"` and return its `"text"` field.
/// - Otherwise return None.
/// Truncates to 100 characters.
fn extract_text_content(value: &serde_json::Value) -> Option<String> {
    let text = match value {
        serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
        serde_json::Value::Array(arr) => arr.iter().find_map(|item| {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                item.get("text")
                    .and_then(|t| t.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            } else {
                None
            }
        }),
        _ => None,
    }?;

    // Cap at 2000 chars — enough for a full hover preview
    if text.chars().count() > 2000 {
        Some(format!("{}...", text.chars().take(2000).collect::<String>()))
    } else {
        Some(text)
    }
}

/// Read the last `n` lines from a file by seeking to end - 64KB.
fn read_last_lines(path: &PathBuf, n: usize) -> Vec<String> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    let file_len = match file.seek(SeekFrom::End(0)) {
        Ok(len) => len,
        Err(_) => return Vec::new(),
    };

    // Seek back up to 256KB from end (enough for ~500 lines)
    let seek_pos = file_len.saturating_sub(262144);
    if file.seek(SeekFrom::Start(seek_pos)).is_err() {
        return Vec::new();
    }

    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return Vec::new();
    }

    let lines: Vec<String> = buf.lines().map(String::from).collect();
    lines.into_iter().rev().take(n).collect()
}

/// Read the first `n` lines from a file.
fn read_first_lines(path: &PathBuf, n: usize) -> Vec<String> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    reader.lines().take(n).flatten().collect()
}

/// Scan the subagents directory for a session and return info about each subagent.
/// Only reads the first line of each subagent file for metadata (fast).
fn scan_subagents(parent_jsonl: &PathBuf, session_id: &str) -> Vec<SubagentInfo> {
    // Subagents are at <parent_dir>/<session_id>/subagents/agent-*.jsonl
    let parent_dir = match parent_jsonl.parent() {
        Some(d) => d,
        None => return Vec::new(),
    };
    let subagents_dir = parent_dir.join(session_id).join("subagents");
    if !subagents_dir.is_dir() {
        return Vec::new();
    }

    let entries = match fs::read_dir(&subagents_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut subagents: Vec<SubagentInfo> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.starts_with("agent-") || !name.ends_with(".jsonl") {
            continue;
        }

        // Count lines for event_count (use metadata file size as proxy for speed)
        let event_count = match File::open(&path) {
            Ok(f) => BufReader::new(f).lines().count(),
            Err(_) => 0,
        };

        // Read first line for metadata
        let first_lines = read_first_lines(&path, 2);
        let mut agent_id: Option<String> = None;
        let mut slug: Option<String> = None;
        let mut timestamp: Option<String> = None;
        let mut task_description: Option<String> = None;

        for line in &first_lines {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                if agent_id.is_none() {
                    agent_id = parsed.get("agentId")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                }
                if slug.is_none() {
                    slug = parsed.get("slug")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                }
                if timestamp.is_none() {
                    timestamp = parsed.get("timestamp")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                }
                if task_description.is_none() {
                    if let Some(msg) = parsed.get("message") {
                        if let Some(content) = msg.get("content") {
                            task_description = extract_text_content(content);
                        }
                    }
                }
            }
        }

        let agent_id = match agent_id {
            Some(id) => id,
            None => name.strip_prefix("agent-").unwrap_or(name)
                .strip_suffix(".jsonl").unwrap_or(name).to_string(),
        };

        // Truncate task description for preview
        let task_description = task_description.map(|t| {
            if t.chars().count() > 200 {
                format!("{}...", t.chars().take(200).collect::<String>())
            } else {
                t
            }
        });

        subagents.push(SubagentInfo {
            agent_id,
            slug,
            task_description,
            timestamp,
            event_count,
        });
    }

    // Sort by timestamp descending (newest first)
    subagents.sort_by(|a, b| {
        let a_ts = a.timestamp.as_deref().unwrap_or("");
        let b_ts = b.timestamp.as_deref().unwrap_or("");
        b_ts.cmp(a_ts)
    });

    subagents
}

/// Parse a single JSONL session file and return a HistorySession.
fn parse_history_session(jsonl_path: &PathBuf) -> Option<HistorySession> {
    let session_id = jsonl_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(String::from)?;

    // Read last ~500 lines to find timestamp, git_branch, and up to 20 recent messages
    let last_lines = read_last_lines(jsonl_path, 500);

    let mut last_activity_at: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut recent_messages: Vec<MessagePreview> = Vec::new();

    for line in &last_lines {
        if let Ok(msg) = serde_json::from_str::<JsonlMessage>(line) {
            if last_activity_at.is_none() {
                last_activity_at = msg.timestamp.clone();
            }
            if git_branch.is_none() {
                git_branch = msg.git_branch.clone();
            }
            // Collect up to 20 meaningful messages (most recent first)
            if recent_messages.len() < 20 {
                if let Some(content) = &msg.message {
                    if let Some(c) = &content.content {
                        if let Some(text) = extract_text_content(c) {
                            let role = content.role.clone().unwrap_or_else(|| "unknown".to_string());
                            recent_messages.push(MessagePreview { text, role });
                        }
                    }
                }
            }
        }
    }

    // Read first ~20 lines to extract cwd
    let first_lines = read_first_lines(jsonl_path, 20);
    let mut cwd: Option<String> = None;
    for line in &first_lines {
        if let Ok(msg) = serde_json::from_str::<JsonlMessage>(line) {
            if let Some(c) = msg.cwd {
                if c.starts_with('/') {
                    cwd = Some(c);
                    break;
                }
            }
        }
    }

    // Also grab git_branch and last_activity_at from first lines if missing
    if git_branch.is_none() || last_activity_at.is_none() {
        for line in &first_lines {
            if let Ok(msg) = serde_json::from_str::<JsonlMessage>(line) {
                if git_branch.is_none() {
                    git_branch = msg.git_branch.clone();
                }
                if last_activity_at.is_none() {
                    last_activity_at = msg.timestamp.clone();
                }
            }
        }
    }

    let cwd = cwd.unwrap_or_default();

    // Scan for subagents in <session_id>/subagents/ directory
    let subagents = scan_subagents(jsonl_path, &session_id);

    Some(HistorySession {
        session_id,
        cwd,
        last_activity_at: last_activity_at.unwrap_or_else(|| "Unknown".to_string()),
        git_branch,
        recent_messages,
        subagents,
    })
}

/// Scan a base directory for project subdirectories containing JSONL session files.
fn scan_project_directories(base_dir: &PathBuf) -> Vec<ProjectHistory> {
    let mut projects: Vec<ProjectHistory> = Vec::new();

    let entries = match fs::read_dir(base_dir) {
        Ok(e) => e,
        Err(_) => return projects,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let jsonl_files: Vec<PathBuf> = match fs::read_dir(&path) {
            Ok(dir_entries) => dir_entries
                .flatten()
                .filter_map(|e| {
                    let p = e.path();
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if p.extension().map(|ext| ext == "jsonl").unwrap_or(false)
                        && !(name.starts_with("agent-") && name.ends_with(".jsonl"))
                    {
                        Some(p)
                    } else {
                        None
                    }
                })
                .collect(),
            Err(_) => continue,
        };

        if jsonl_files.is_empty() {
            continue;
        }

        let mut sessions: Vec<HistorySession> = jsonl_files
            .iter()
            .filter_map(parse_history_session)
            .collect();

        if sessions.is_empty() {
            continue;
        }

        sessions.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));

        let project_path = sessions
            .first()
            .map(|s| s.cwd.clone())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| convert_dir_name_to_path(&dir_name));

        let project_name = project_path
            .split('/')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or("Unknown")
            .to_string();

        projects.push(ProjectHistory {
            project_path,
            project_name,
            project_dir_name: dir_name,
            sessions,
        });
    }

    projects
}

/// Scan `~/.claude/projects/` (and archives) and return all past sessions grouped by project.
pub fn get_session_history() -> SessionHistoryResponse {
    let mut projects = match dirs::home_dir() {
        Some(h) => {
            let claude_dir = h.join(".claude").join("projects");
            if claude_dir.exists() {
                scan_project_directories(&claude_dir)
            } else {
                Vec::new()
            }
        }
        None => Vec::new(),
    };

    // Merge archived sessions (dedup by session_id, prefer live over archived)
    if let Some(archive_dir) = get_archive_base_dir() {
        if archive_dir.exists() {
            let archived = scan_project_directories(&archive_dir);
            for arch_project in archived {
                if let Some(existing) = projects.iter_mut().find(|p| p.project_dir_name == arch_project.project_dir_name) {
                    let existing_ids: std::collections::HashSet<String> =
                        existing.sessions.iter().map(|s| s.session_id.clone()).collect();
                    let new_sessions: Vec<HistorySession> = arch_project
                        .sessions
                        .into_iter()
                        .filter(|s| !existing_ids.contains(&s.session_id))
                        .collect();
                    existing.sessions.extend(new_sessions);
                    existing.sessions.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
                } else {
                    projects.push(arch_project);
                }
            }
        }
    }

    // Sort projects by most-recent session descending
    projects.sort_by(|a, b| {
        let a_time = a.sessions.first().map(|s| s.last_activity_at.as_str()).unwrap_or("");
        let b_time = b.sessions.first().map(|s| s.last_activity_at.as_str()).unwrap_or("");
        b_time.cmp(a_time)
    });

    SessionHistoryResponse { projects }
}

/// Delete a history session's JSONL file (and its subdirectory if present).
pub fn delete_history_session(session_id: &str, project_dir_name: &str) -> Result<(), String> {
    let claude_dir = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".claude")
        .join("projects")
        .join(project_dir_name);

    let jsonl_path = claude_dir.join(format!("{}.jsonl", session_id));
    if jsonl_path.exists() {
        fs::remove_file(&jsonl_path)
            .map_err(|e| format!("Failed to delete session file: {}", e))?;
    }

    // Some sessions also have a subdirectory (e.g. for agent sub-sessions)
    let dir_path = claude_dir.join(session_id);
    if dir_path.is_dir() {
        fs::remove_dir_all(&dir_path)
            .map_err(|e| format!("Failed to delete session directory: {}", e))?;
    }

    Ok(())
}

/// Archive a session by copying its JSONL file (and subdirectory) to a safe location.
pub fn archive_session(session_id: &str, project_dir_name: &str) -> Result<(), String> {
    let source_dir = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".claude")
        .join("projects")
        .join(project_dir_name);

    let archive_dir = dirs::data_dir()
        .ok_or("Cannot determine data directory")?
        .join("agent-sessions")
        .join("archives")
        .join(project_dir_name);

    fs::create_dir_all(&archive_dir)
        .map_err(|e| format!("Failed to create archive directory: {}", e))?;

    // Copy JSONL file
    let source_jsonl = source_dir.join(format!("{}.jsonl", session_id));
    if source_jsonl.exists() {
        let dest_jsonl = archive_dir.join(format!("{}.jsonl", session_id));
        fs::copy(&source_jsonl, &dest_jsonl)
            .map_err(|e| format!("Failed to archive session file: {}", e))?;
    }

    // Copy subdirectory if present
    let source_subdir = source_dir.join(session_id);
    if source_subdir.is_dir() {
        let dest_subdir = archive_dir.join(session_id);
        copy_dir_recursive(&source_subdir, &dest_subdir)
            .map_err(|e| format!("Failed to archive session directory: {}", e))?;
    }

    Ok(())
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// A single JSONL event for the Event Inspector.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub index: usize,
    pub timestamp: Option<String>,
    pub event_type: String,
    pub role: Option<String>,
    pub tool_name: Option<String>,
    pub content_preview: Option<String>,
}

/// Build a human-readable preview for a tool_use event from its name and input.
fn build_tool_preview(name: &str, input: &serde_json::Value) -> String {
    match name {
        "Agent" | "SendMessage" => {
            let mut parts = vec![format!("**{}**", name)];
            if let Some(desc) = input.get("description").and_then(|d| d.as_str()) {
                parts.push(format!("**Description:** {}", desc));
            }
            if let Some(st) = input.get("subagent_type").and_then(|s| s.as_str()) {
                parts.push(format!("**Type:** {}", st));
            }
            if let Some(prompt) = input.get("prompt").and_then(|p| p.as_str()) {
                parts.push(format!("**Prompt:**\n\n```text\n{}\n```", prompt));
            }
            // SendMessage
            if let Some(to) = input.get("to").and_then(|t| t.as_str()) {
                parts.push(format!("**To:** {}", to));
            }
            if let Some(msg) = input.get("message").and_then(|m| m.as_str()) {
                parts.push(format!("**Message:**\n\n```text\n{}\n```", msg));
            }
            parts.join("\n\n")
        }
        "Edit" => {
            let file = input.get("file_path").and_then(|f| f.as_str()).unwrap_or("unknown");
            let mut parts = vec![format!("**Edit:** `{}`", file)];
            // Build a unified diff from old_string -> new_string
            let old = input.get("old_string").and_then(|s| s.as_str()).unwrap_or("");
            let new = input.get("new_string").and_then(|s| s.as_str()).unwrap_or("");
            if !old.is_empty() || !new.is_empty() {
                let mut diff_lines = vec!["```diff".to_string()];
                for line in old.lines() {
                    diff_lines.push(format!("- {}", line));
                }
                for line in new.lines() {
                    diff_lines.push(format!("+ {}", line));
                }
                diff_lines.push("```".to_string());
                parts.push(diff_lines.join("\n"));
            }
            parts.join("\n\n")
        }
        "Write" => {
            let file = input.get("file_path").and_then(|f| f.as_str()).unwrap_or("unknown");
            let content = input.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let preview: String = content.chars().take(2000).collect();
            format!("**Write:** `{}`\n\n```\n{}\n```", file, preview)
        }
        "Bash" | "PowerShell" => {
            let cmd = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
            format!("```bash\n{}\n```", cmd)
        }
        "Read" => {
            let file = input.get("file_path").and_then(|f| f.as_str()).unwrap_or("unknown");
            let mut s = format!("**Read:** `{}`", file);
            if let Some(offset) = input.get("offset").and_then(|o| o.as_u64()) {
                s.push_str(&format!(" (offset: {})", offset));
            }
            if let Some(limit) = input.get("limit").and_then(|l| l.as_u64()) {
                s.push_str(&format!(" (limit: {})", limit));
            }
            s
        }
        "Glob" => {
            let pattern = input.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
            format!("**Glob:** `{}`", pattern)
        }
        "Grep" => {
            let pattern = input.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path.is_empty() {
                format!("**Grep:** `{}`", pattern)
            } else {
                format!("**Grep:** `{}` in `{}`", pattern, path)
            }
        }
        "WebFetch" => {
            let url = input.get("url").and_then(|u| u.as_str()).unwrap_or("");
            format!("**WebFetch:** {}", url)
        }
        "WebSearch" => {
            let query = input.get("query").and_then(|q| q.as_str()).unwrap_or("");
            format!("**WebSearch:** {}", query)
        }
        _ => {
            // Generic: show tool name + file_path or pattern if present
            if let Some(fp) = input.get("file_path").and_then(|f| f.as_str()) {
                format!("{}: {}", name, fp)
            } else if let Some(p) = input.get("pattern").and_then(|p| p.as_str()) {
                format!("{}: {}", name, p)
            } else {
                name.to_string()
            }
        }
    }
}

/// Detect the actual content type from message.content blocks.
/// Returns (effective_event_type, effective_role, tool_name, content_preview).
fn classify_message_content(parsed: &serde_json::Value) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let message = match parsed.get("message") {
        Some(m) => m,
        None => return (None, None, None, None),
    };

    let role = message.get("role").and_then(|r| r.as_str()).map(String::from);
    let content = match message.get("content") {
        Some(c) => c,
        None => return (None, role, None, None),
    };

    // If content is an array, inspect the block types
    if let Some(arr) = content.as_array() {
        let mut has_tool_use = false;
        let mut has_tool_result = false;
        let mut has_thinking_only = true;
        let mut has_text = false;
        let mut detected_tool_name: Option<String> = None;
        let mut tool_input_preview: Option<String> = None;
        let mut tool_result_content: Option<String> = None;
        let mut text_content: Option<String> = None;

        for block in arr {
            let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match block_type {
                "tool_use" => {
                    has_tool_use = true;
                    has_thinking_only = false;
                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("Tool");
                    detected_tool_name = Some(name.to_string());
                    // Build preview from tool input
                    if let Some(input) = block.get("input") {
                        tool_input_preview = Some(build_tool_preview(name, input));
                    } else {
                        tool_input_preview = Some(name.to_string());
                    }
                }
                "tool_result" => {
                    has_tool_result = true;
                    has_thinking_only = false;
                    // Extract content from tool_result block (no truncation — inspector shows full content)
                    if let Some(c) = block.get("content") {
                        if let Some(s) = c.as_str() {
                            tool_result_content = Some(s.to_string());
                        } else if let Some(arr) = c.as_array() {
                            for item in arr {
                                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                                        tool_result_content = Some(t.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                "thinking" => {
                    // thinking blocks — no useful content
                }
                "text" => {
                    has_text = true;
                    has_thinking_only = false;
                    if text_content.is_none() {
                        text_content = block.get("text")
                            .and_then(|t| t.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());
                    }
                }
                _ => {
                    has_thinking_only = false;
                }
            }
        }

        // Classify based on detected block types
        if has_tool_use {
            return (Some("tool_use".to_string()), Some("tool".to_string()), detected_tool_name, tool_input_preview.or(text_content));
        }
        if has_tool_result {
            return (Some("tool_result".to_string()), Some("tool".to_string()), None, tool_result_content);
        }
        if has_thinking_only && !has_text {
            return (Some("thinking".to_string()), role, None, None);
        }
        if has_text {
            return (None, role, None, text_content);
        }
    }

    // Content is a simple string — extract full text without truncation
    let preview = match content {
        serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => extract_text_content(content),
    };
    (None, role, None, preview)
}

/// Parse a JSONL file into SessionEvent objects.
fn parse_jsonl_events(jsonl_path: &PathBuf, after_index: Option<usize>) -> Result<Vec<SessionEvent>, String> {
    let file = File::open(jsonl_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    let reader = BufReader::new(file);

    let mut events = Vec::new();
    for (i, line) in reader.lines().enumerate() {
        // Skip lines until past after_index (by line number)
        if let Some(after) = after_index {
            if i <= after {
                continue;
            }
        }

        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        if line.trim().is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let timestamp = parsed.get("timestamp")
            .and_then(|v| v.as_str())
            .map(String::from);

        let base_type = parsed.get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        // Classify based on actual message content blocks
        let (override_type, effective_role, tool_name, content_preview) = classify_message_content(&parsed);

        let event_type = override_type.unwrap_or(base_type);
        let role = effective_role.or_else(|| {
            parsed.get("message")
                .and_then(|m| m.get("role"))
                .and_then(|r| r.as_str())
                .map(String::from)
        });

        // Fall back to subtype for non-message events
        let content_preview = content_preview.or_else(|| {
            if parsed.get("message").is_none() {
                parsed.get("subtype")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            } else {
                None
            }
        });

        events.push(SessionEvent {
            index: i,
            timestamp,
            event_type,
            role,
            tool_name,
            content_preview,
        });
    }

    Ok(events)
}

/// Resolve the JSONL file path for a session (or subagent).
fn resolve_session_jsonl_path(session_id: &str, project_dir_name: &str, agent_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;

    if !agent_id.is_empty() {
        let subagent_filename = format!("agent-{}.jsonl", agent_id);
        if !project_dir_name.is_empty() {
            let path = home.join(".claude").join("projects")
                .join(project_dir_name).join(session_id).join("subagents").join(&subagent_filename);
            if path.exists() { return Ok(path); }
        }
        let projects_dir = home.join(".claude").join("projects");
        if let Ok(entries) = fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let path = entry.path().join(session_id).join("subagents").join(&subagent_filename);
                if path.exists() { return Ok(path); }
            }
        }
        return Err("Subagent file not found".to_string());
    }

    let filename = format!("{}.jsonl", session_id);

    if !project_dir_name.is_empty() {
        let path = home.join(".claude").join("projects").join(project_dir_name).join(&filename);
        if path.exists() { return Ok(path); }
        if let Some(archive_dir) = get_archive_base_dir() {
            let path = archive_dir.join(project_dir_name).join(&filename);
            if path.exists() { return Ok(path); }
        }
    }

    let projects_dir = home.join(".claude").join("projects");
    if projects_dir.exists() {
        if let Ok(entries) = fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let path = entry.path().join(&filename);
                if path.exists() { return Ok(path); }
            }
        }
    }

    if let Some(archive_dir) = get_archive_base_dir() {
        if archive_dir.exists() {
            if let Ok(entries) = fs::read_dir(&archive_dir) {
                for entry in entries.flatten() {
                    let path = entry.path().join(&filename);
                    if path.exists() { return Ok(path); }
                }
            }
        }
    }

    Err("Session file not found".to_string())
}

/// Read all events from a session JSONL file for the Event Inspector.
pub fn get_session_events(session_id: &str, project_dir_name: &str, agent_id: &str, after_index: Option<usize>) -> Result<Vec<SessionEvent>, String> {
    let path = resolve_session_jsonl_path(session_id, project_dir_name, agent_id)?;
    parse_jsonl_events(&path, after_index)
}

/// Read a single raw JSON line from a JSONL file by event index.
pub fn get_event_raw_json(session_id: &str, project_dir_name: &str, event_index: usize, agent_id: &str) -> Result<String, String> {
    let path = resolve_session_jsonl_path(session_id, project_dir_name, agent_id)?;
    let file = File::open(&path).map_err(|e| format!("Failed to open: {}", e))?;
    let reader = BufReader::new(file);

    let mut current_index: usize = 0;
    for (i, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }
        // The event index corresponds to the line number (i), not a filtered counter
        if i == event_index {
            // Pretty-format the JSON
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                return serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string());
            }
            return Ok(line);
        }
        current_index = i;
    }
    Err(format!("Event index {} not found (last was {})", event_index, current_index))
}

/// Get the archive base directory path.
fn get_archive_base_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("agent-sessions").join("archives"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_extract_text_content_string() {
        let value = json!("hello world");
        let result = extract_text_content(&value);
        assert_eq!(result, Some("hello world".to_string()));
    }

    #[test]
    fn test_extract_text_content_empty_string() {
        let value = json!("");
        let result = extract_text_content(&value);
        assert_eq!(result, None);
    }

    #[test]
    fn test_extract_text_content_array_with_text_block() {
        let value = json!([
            {"type": "tool_use", "id": "abc"},
            {"type": "text", "text": "Here is my answer"}
        ]);
        let result = extract_text_content(&value);
        assert_eq!(result, Some("Here is my answer".to_string()));
    }

    #[test]
    fn test_extract_text_content_array_no_text_block() {
        let value = json!([
            {"type": "tool_use", "id": "abc"}
        ]);
        let result = extract_text_content(&value);
        assert_eq!(result, None);
    }

    #[test]
    fn test_extract_text_content_null() {
        let value = json!(null);
        let result = extract_text_content(&value);
        assert_eq!(result, None);
    }

    #[test]
    fn test_extract_text_content_truncates_long_string() {
        let long_text = "a".repeat(2500);
        let value = serde_json::Value::String(long_text);
        let result = extract_text_content(&value).unwrap();
        // Should be truncated to 2000 chars + "..."
        assert!(result.ends_with("..."));
        assert_eq!(result.chars().count(), 2003); // 2000 + "..."
    }

    #[test]
    fn test_get_session_history_smoke() {
        // Should not panic even if ~/.claude/projects/ doesn't exist
        let response = get_session_history();
        // projects can be empty or populated — just ensure it runs
        let _ = response.projects.len();
    }
}
