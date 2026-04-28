use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub filename: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub memory_type: Option<String>,
    pub content: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemory {
    pub project_dir_name: String,
    pub files: Vec<MemoryFile>,
}

fn memory_dir(project_dir_name: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".claude").join("projects").join(project_dir_name).join("memory");
    if dir.is_dir() { Some(dir) } else { None }
}

/// Quick check: does this project have a memory directory with at least one .md file?
pub fn project_has_memory(project_dir_name: &str) -> bool {
    let dir = match memory_dir(project_dir_name) {
        Some(d) => d,
        None => return false,
    };
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".md") { return true; }
            }
        }
    }
    false
}

/// Parse YAML frontmatter from a markdown file. Returns (name, description, type).
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>, Option<String>) {
    if !content.starts_with("---") {
        return (None, None, None);
    }

    // Find the closing `---`
    let after_open = &content[3..];
    let close_idx = match after_open.find("\n---") {
        Some(i) => i,
        None => return (None, None, None),
    };
    let frontmatter = &after_open[..close_idx];

    let mut name = None;
    let mut description = None;
    let mut mem_type = None;

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("name:") {
            name = Some(rest.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
        } else if let Some(rest) = line.strip_prefix("description:") {
            description = Some(rest.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
        } else if let Some(rest) = line.strip_prefix("type:") {
            mem_type = Some(rest.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
        }
    }

    (name, description, mem_type)
}

/// Get all memory files for a project.
pub fn get_project_memory(project_dir_name: &str) -> Result<ProjectMemory, String> {
    let dir = memory_dir(project_dir_name)
        .ok_or("No memory directory for this project")?;

    let mut files = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read memory dir: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if n.ends_with(".md") => n.to_string(),
            _ => continue,
        };

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let (name, description, memory_type) = parse_frontmatter(&content);

        files.push(MemoryFile {
            filename,
            name,
            description,
            memory_type,
            content,
            size_bytes,
        });
    }

    // Sort: MEMORY.md first, then by filename
    files.sort_by(|a, b| {
        if a.filename == "MEMORY.md" { return std::cmp::Ordering::Less; }
        if b.filename == "MEMORY.md" { return std::cmp::Ordering::Greater; }
        a.filename.cmp(&b.filename)
    });

    Ok(ProjectMemory {
        project_dir_name: project_dir_name.to_string(),
        files,
    })
}

/// Delete a single memory file.
pub fn delete_memory_file(project_dir_name: &str, filename: &str) -> Result<(), String> {
    // Validate filename to prevent path traversal
    if filename.contains('/') || filename.contains("..") || !filename.ends_with(".md") {
        return Err("Invalid filename".to_string());
    }

    let dir = memory_dir(project_dir_name).ok_or("No memory directory")?;
    let path = dir.join(filename);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    fs::remove_file(&path).map_err(|e| format!("Failed to delete: {}", e))
}
