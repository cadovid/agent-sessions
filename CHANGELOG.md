# Changelog

## [1.0.0] - 2026-04-08

This is a major release that diverges from the upstream macOS-only project, refocused on Linux (with full Zellij integration) and broadly expanded session tooling.

### Added — Linux support
- Cross-platform process discovery via `sysinfo` (single shared System instance per poll cycle)
- Zellij integration: terminal focusing via `dump-layout` parsing + `focus-next-pane` cycling, cross-tab switching with `go-to-tab-name`, and "resume in new tab" via `write-chars`
- Optional shell hook (`scripts/shell-hook.sh`) to name Zellij panes by Claude's PID for reliable focusing
- AppImage build via GitHub Actions on tag push (`.github/workflows/release.yml`)

### Added — Session History Panel
- Collapsible left panel showing all past sessions from `~/.claude/projects/`
- Two grouping modes: By Project and By Date with smart date labels ("Today 14:32", "Yesterday 09:15", "Mar 28 16:45")
- Drag-to-resize panel, search, and filter tabs (All / Active / Idle)
- Per-session actions: resume in new Zellij tab, star/favorite, inspect, delete (with confirmation)
- Project accent colors (hash-based, 10 colors) as left border on session entries
- Custom session names and per-session URLs (stored in localStorage)

### Added — Event Inspector
- Full JSONL event viewer for any session (history, active, or subagent)
- Draggable, resizable floating panel with split-pane layout and virtual scrolling
- Role filters (User / Assistant / Tools / System) and semantic filters (Search / Edit / Execute / Plan / Diff / Web / Agent) auto-detected from tool name and content
- Search with match highlighting in list, Pretty view, and Raw JSON
- Live refresh (3-second incremental polling) for active sessions
- Lazy raw JSON loading and lazy-loaded inspector chunk

### Added — Memory Inspector
- Per-project memory browser for `~/.claude/projects/<dir>/memory/`
- Type filters (Index / Feedback / User / Project / Reference) with counts
- Search across filename, frontmatter, and full file content with highlighting
- Pretty / Raw view toggle, structured frontmatter metadata block
- Delete files with path-traversal-protected confirmation

### Added — Subagent Hierarchy
- Detects parent-child relationships from `<session>/subagents/`
- Collapsible tree with slug name, task description, and event count per subagent
- Click any subagent to open its events in the Event Inspector
- Progressive loading (10 at a time) for sessions with many subagents

### Added — Favorites and Archiving
- Star sessions for quick access; starring auto-archives the JSONL to `~/.local/share/agent-sessions/archives/`
- History scanner reads both live and archived directories so favorites survive `~/.claude/` cleanup
- Favorites filter toggle in the history panel header

### Added — Claude Code Usage Tracking
- Reads OAuth token from `~/.claude/.credentials.json`, calls `api.anthropic.com/api/oauth/usage`
- Header strip with 5h / 7d / Opus / Sonnet meters (used %, reset countdown, color-coded bars)
- Tray title and dropdown show usage info; dynamic colored status dot overlaid on tray icon
- Manual refresh button + automatic 15-minute polling
- Auto-handles token refresh on 401 by spawning `claude /status`

### Added — Transcript Linkification
- URLs in messages render as clickable links (open in default browser via `tauri-plugin-opener`)
- Absolute file paths auto-detected and clickable (open via `$EDITOR`, `$VISUAL`, or `xdg-open`)
- File paths render in green, URLs in blue
- ` ```diff ` blocks render with red/green line coloring; line-numbered tool output auto-wrapped in code fences

### Added — System Tray
- Right-click menu lists all active sessions with status dots (● active / ○ idle); click to focus
- Title shows session counts + usage; menu only rebuilds when sessions actually change

### Performance
- Single shared `sysinfo::System` instance per poll cycle (was duplicated per detector)
- Directory pre-filtering: skip project dirs that don't match any active process CWD
- Git remote URL caching across the app lifetime
- JSONL tail-seeking (last 1MB) for active session status detection
- CWD caching per session file
- Combined head+tail file reads in history scanner (single open instead of 2-3)
- Markdown component lazy-loaded with the Event/Memory inspectors
- Lazy raw JSON loading in inspector (-16MB initial transfer for large sessions)
- Virtual scrolling for the inspector event list
- Incremental live refresh (only new events) instead of full re-fetch
- Removed unused `rusqlite` (with bundled SQLite C code) dependency
- Release profile: `lto = true`, `codegen-units = 1`, `opt-level = 3`

### Fixed
- Zellij session resume now picks the active session marked `(current)` instead of the first line of `list-sessions`, which was often a stale exited session
- Surface the real Rust error string in the resume failure flow instead of a generic fallback

## [0.1.27] - 2026-03-09

### Fixed
- Show sessions as "Waiting" when Claude is blocked on `AskUserQuestion` user input instead of "Processing"

## [0.1.26] - 2026-03-01

### Fixed
- Fix project path resolution for directories with hyphens

## [0.1.25] - 2026-02-08

### Fixed
- Fix status flickering when multiple sessions run in the same project - idle sessions no longer pick up active status from sibling sessions

## [0.1.24] - 2026-02-06

### Added
- "Compacting" status shown when a session is compressing its conversation context

## [0.1.23] - 2026-02-06

### Fixed
- Simplify status detection to use message content as primary signal instead of file age heuristics
- Increase JSONL lookback from 100 to 500 lines to handle long tool execution progress streaks
- Never show "idle" for sessions with active processes

## [0.1.22] - 2026-02-06

### Fixed
- Use 30-second activity window for tool execution status instead of 3 seconds
- Sessions running tools no longer flicker to "waiting" between progress writes

## [0.1.21] - 2026-02-05

### Fixed
- Remove CPU-based status override that falsely showed finished sessions as "processing"

## [0.1.20] - 2026-02-05

### Fixed
- Filter out orphaned sessions whose terminal was closed (processes reparented to launchd)
- Clean up stale status tracking entries to prevent unbounded memory growth

## [0.1.17] - 2025-12-07

### Fixed
- Session detection for paths with dashes in folder names (worktrees, subfolders)

## [0.1.16] - 2025-12-06

### Changed
- Version bump for release

## [0.1.15] - 2025-12-06

### Added
- "Kill Session" option in session card menu to terminate Claude Code processes

### Changed
- Default hotkey changed from Option+Space to Control+Space
- Git branch now shows proper branch icon instead of lightning bolt
- Dev server port changed from 1420 to 1422 to avoid conflicts

## [0.1.14] - 2025-12-06

### Fixed
- Improved status detection to prevent premature transition to "Waiting" while Claude is still streaming
- Added stable session ordering in UI to prevent unnecessary reordering on each poll
- Enhanced debug logging with status transition tracking and content previews

## [0.1.13] - 2025-12-06

### Added
- Sub-agent count badge `[+N]` displayed on sessions with active sub-agents
- `activeSubagentCount` field to Session model

### Fixed
- Filter out sub-agent processes (parent is another Claude process)
- Filter out Zed external agents (claude-code-acp) that aren't user-initiated
- Exclude `agent-*.jsonl` files from main session detection to prevent duplicates

## [0.1.12] - 2025-12-05

### Changed
- Reduced poll interval to 2 seconds for faster updates

## [0.1.11] - 2025-12-05

### Added
- "Open GitHub" menu item to open project's GitHub repo
