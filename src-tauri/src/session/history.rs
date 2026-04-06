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
}

/// A single message preview (text + role)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePreview {
    pub text: String,
    pub role: String,
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

    Some(HistorySession {
        session_id,
        cwd,
        last_activity_at: last_activity_at.unwrap_or_else(|| "Unknown".to_string()),
        git_branch,
        recent_messages,
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
