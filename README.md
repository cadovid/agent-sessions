# Agent Sessions

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/cadovid/agent-sessions/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Linux](https://img.shields.io/badge/Linux-AppImage-yellow)](https://github.com/cadovid/agent-sessions/releases)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-orange)](https://tauri.app)

A desktop app to monitor, browse, and inspect your Claude Code sessions in real-time. Built with Tauri 2.x for Linux (with Zellij/tmux support) and macOS.

## Features

### Active Session Monitoring
- View all running Claude Code sessions in one place
- Real-time status detection (Thinking, Processing, Waiting, Idle)
- Filter tabs: All / Active / Idle
- Full message preview with markdown rendering and collapsible "show more"
- Click to focus on a session's terminal (Zellij pane switching, tmux select-pane)
- Custom session names, URLs, and GitHub links via dropdown menu
- Kill sessions directly from the app
- Global hotkey to toggle visibility (configurable)

### Session History Panel
- Collapsible left panel showing all past sessions from `~/.claude/projects/`
- Two grouping modes: **By Project** and **By Date** (toggle in header)
- Smart date labels: "Today 14:32", "Yesterday 09:15", "Mar 28 16:45"
- Date section headers within project groups
- Search across project names, branches, messages, and custom names
- Drag-to-resize panel (200-600px)
- Per-session actions: resume in new Zellij tab, star/favorite, inspect, delete (with confirmation)

### Event Inspector
- Full JSONL event viewer for any session (history, active, or subagent)
- Draggable, resizable floating panel with split-pane layout and virtual scrolling
- Role filters: All / User / Assistant / Tools / System
- Semantic type filters: Search / Edit / Execute / Plan / Diff / Web / Agent (auto-detected from tool name and content patterns)
- Navigation pills to jump between event types (User, Assistant, Tool, System)
- Search with match highlighting (yellow) in event list, detail panel, and raw JSON
- Pretty view (markdown rendered) and Raw JSON view with copy-to-clipboard
- Live refresh (3-second polling) for active sessions with LIVE indicator, incremental fetch (only new events)
- Lazy raw JSON loading — only fetched on demand to keep memory low

### Memory Inspector
- Per-project memory browser for `~/.claude/projects/<dir>/memory/` files
- Open-book icon appears in each project group header when memory exists
- Draggable, resizable dialog mirroring the Event Inspector layout
- Type filters with counts: All / Index / Feedback / User / Project / Reference
- Search across filename, frontmatter (`name`, `description`), and full file content with yellow highlighting
- Pretty view renders all frontmatter fields in a structured metadata block, then the markdown body
- Raw view shows the full file (frontmatter + body) for direct inspection
- Delete individual memory files with confirmation (path-traversal protected)

### Claude Code Usage Tracking
- Reads OAuth token from `~/.claude/.credentials.json` and queries `https://api.anthropic.com/api/oauth/usage`
- Compact usage meters in the app header for the 5-hour, 7-day, Opus, and Sonnet windows
- Color-coded bars (green / amber / red) showing % used + reset countdown
- Tray menu shows usage line at the top of the dropdown
- Tray title appends usage info (e.g. `2 (2 idle) · 5h:31% 7d:9%`)
- Dynamic tray icon: anti-aliased colored status dot (green/amber/red/gray) overlaid in the bottom-right corner
- Manual refresh button + automatic poll every 15 minutes
- Auto-handles token refresh (spawns `claude /status` on 401)

### Subagent Hierarchy
- Detects parent-child relationships from `<session>/subagents/` directories
- Collapsible tree showing each subagent's slug name, task description, and event count
- Click any subagent to open its events in the Event Inspector
- Progressive loading (10 at a time) for sessions with many subagents

### Favorites and Archiving
- Star sessions for quick access (amber star icon)
- Starring automatically archives the session to `~/.local/share/agent-sessions/archives/`
- Archived sessions always appear even if `~/.claude/` is cleaned up
- Favorites filter toggle in the history panel header

### Transcript Linkification
- URLs in messages are clickable (opens in default browser)
- Absolute file paths (e.g., `/home/.../file.rs`) are auto-detected and clickable (opens in `$EDITOR`, `$VISUAL`, or `xdg-open`)
- File paths render in green, URLs in blue

### System Tray
- Persistent tray icon with dynamic colored status dot reflecting Claude Code usage level (green / amber / red)
- Tray title shows session counts and usage at a glance: `2 (2 idle) · 5h:31% 7d:9%`
- Right-click menu shows usage line, all active sessions with status indicators (● active / ○ idle), Show Window, and Quit
- Click a session in the menu to focus its terminal
- Sessions display custom names when set
- Menu only rebuilds when sessions actually change (avoids unnecessary IPC overhead)

### Visual Design
- Dark theme with three-zone depth layering (header / content / sidebar)
- Project accent colors (hash-based, 10 colors) as left border on session entries
- Separator lines between sessions
- Neon-colored event type badges and semantic type indicators in the inspector

## Installation

### AppImage (Linux)

Download the latest AppImage from [Releases](https://github.com/cadovid/agent-sessions/releases).

```bash
chmod +x "Agent Sessions_1.0.0_amd64.AppImage"
./"Agent Sessions_1.0.0_amd64.AppImage"
```

### Build from Source

Requirements: Node.js 20+, Rust toolchain, system dependencies for Tauri 2.x on Linux.

```bash
# Install dependencies
npm install

# Development
npm run tauri dev

# Build AppImage
npm run tauri build -- --bundles appimage
```

## Terminal Integration

### Zellij (Linux)

The app integrates with Zellij for terminal focusing and session resume:

- **Focus**: Parses `zellij dump-layout` to find the correct pane, switches tabs if needed, then cycles to the target pane
- **Resume**: Creates a new named Zellij tab and types `claude --resume <session-id>`
- **Shell hook** (optional): Source `scripts/shell-hook.sh` in your shell config to name Zellij panes by Claude's PID for reliable focusing

### tmux

Basic tmux support with `select-pane` for terminal focusing.

## Tech Stack

- **Tauri 2.x** (Rust backend + React frontend)
- **React + TypeScript** with Vite
- **Tailwind CSS + shadcn/ui** components
- **react-markdown + remark-gfm** for message rendering (lazy-loaded with the inspectors to keep the initial bundle small)
- **sysinfo** crate for cross-platform process discovery (single shared instance, refreshed once per poll cycle)
- **ureq** for the synchronous HTTP call to Anthropic's usage API
- **png** crate for decoding the tray icon at runtime to overlay the colored status dot

## License

MIT
