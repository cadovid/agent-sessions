import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ProjectHistory, HistorySession } from '../types/session';
import { formatTimeAgo } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Markdown } from './Markdown';

const HISTORY_PANEL_EXPANDED_KEY = 'agent-sessions-history-panel-expanded';
const HISTORY_PANEL_WIDTH_KEY = 'agent-sessions-history-panel-width';
const DEFAULT_PANEL_WIDTH = 288;
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 600;

// Neon background colors for project groups (dark-mode friendly)
const GROUP_COLORS = [
  'rgba(0, 255, 136, 0.15)',    // neon green
  'rgba(0, 200, 255, 0.15)',    // neon cyan
  'rgba(200, 0, 255, 0.15)',    // neon magenta
  'rgba(255, 0, 128, 0.15)',    // neon pink
  'rgba(255, 255, 0, 0.12)',    // neon yellow
  'rgba(255, 100, 0, 0.15)',    // neon orange
  'rgba(0, 128, 255, 0.15)',    // neon blue
  'rgba(180, 0, 180, 0.15)',    // neon purple
];

const CUSTOM_NAMES_KEY = 'agent-sessions-custom-names';

function getCustomName(sessionId: string): string | null {
  try {
    const stored = localStorage.getItem(CUSTOM_NAMES_KEY);
    if (!stored) return null;
    const names: Record<string, string> = JSON.parse(stored);
    return names[sessionId] || null;
  } catch {
    return null;
  }
}

function shortenPath(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, '~/');
}

interface HistoryPanelProps {
  history: { projects: ProjectHistory[] } | null;
  isLoading: boolean;
  error: string | null;
  resumeError: string | null;
  onResumeSession: (sessionId: string, cwd: string) => void;
  onDeleteSession: (sessionId: string, projectDirName: string) => void;
}

function HamburgerIcon() {
  return (
    <svg
      className="w-5 h-5 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function ChevronDownIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg
      className="w-3 h-3 text-muted-foreground shrink-0"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9" />
    </svg>
  );
}

interface HoverPreviewProps {
  message: string;
  role: string;
  anchorRect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function HoverPreview({ message, role, anchorRect, onMouseEnter, onMouseLeave }: HoverPreviewProps) {
  const panelWidth = 320;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = anchorRect.right + 8;
  if (left + panelWidth > viewportWidth - 8) {
    left = anchorRect.left - panelWidth - 8;
  }

  let top = anchorRect.top;
  const maxTop = viewportHeight - 200;
  if (top > maxTop) top = maxTop;

  return createPortal(
    <div
      className="fixed z-50 bg-popover border border-border rounded-lg shadow-xl p-3"
      style={{ left, top, width: panelWidth, maxHeight: 400, overflowY: 'auto' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className={`text-[10px] font-medium uppercase tracking-wider ${role === 'user' ? 'text-blue-400' : 'text-emerald-400'}`}>
        {role}
      </span>
      <div className="text-xs text-foreground/80 leading-relaxed mt-1">
        <Markdown>{message}</Markdown>
      </div>
    </div>,
    document.body
  );
}

interface MessageLineProps {
  msg: { text: string; role: string };
  index: number;
  isHovered: boolean;
  hoverRect: DOMRect | null;
  onHoverEnter: (index: number, rect: DOMRect) => void;
  onHoverLeave: () => void;
  onHoverCancel: () => void;
  onResume: () => void;
}

function MessageLine({ msg, index, isHovered, hoverRect, onHoverEnter, onHoverLeave, onHoverCancel, onResume }: MessageLineProps) {
  const lineRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = useCallback(() => {
    if (lineRef.current) {
      onHoverEnter(index, lineRef.current.getBoundingClientRect());
    }
  }, [index, onHoverEnter]);

  return (
    <>
      <div
        ref={lineRef}
        className="py-0.5 cursor-pointer hover:bg-muted/30 rounded px-1"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={onHoverLeave}
        onClick={onResume}
      >
        <div className="text-xs text-foreground/70 line-clamp-2">
          <span className={`font-medium ${msg.role === 'user' ? 'text-blue-400/70' : 'text-emerald-400/70'}`}>
            {msg.role === 'user' ? 'U' : 'A'}:
          </span>{' '}
          <Markdown className="inline">{msg.text}</Markdown>
        </div>
      </div>
      {isHovered && hoverRect && (
        <HoverPreview
          message={msg.text}
          role={msg.role}
          anchorRect={hoverRect}
          onMouseEnter={onHoverCancel}
          onMouseLeave={onHoverLeave}
        />
      )}
    </>
  );
}

interface SessionEntryProps {
  session: HistorySession;
  onResume: (sessionId: string, cwd: string) => void;
  onDelete: (sessionId: string) => void;
}

function SessionEntry({ session, onResume, onDelete }: SessionEntryProps) {
  const customName = getCustomName(session.sessionId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(1);
  // Single active hover: index + rect (only one message hovered at a time)
  const [activeHover, setActiveHover] = useState<{ index: number; rect: DOMRect } | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messages = session.recentMessages;
  const shownMessages = messages.slice(0, visibleCount);
  const remaining = messages.length - visibleCount;

  const handleResume = useCallback(() => {
    onResume(session.sessionId, session.cwd);
  }, [session.sessionId, session.cwd, onResume]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    setConfirmOpen(false);
    onDelete(session.sessionId);
  }, [session.sessionId, onDelete]);

  const handleShowMore = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setVisibleCount((prev) => Math.min(prev + 5, messages.length));
  }, [messages.length]);

  const handleCollapse = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setVisibleCount(1);
  }, []);

  const handleHoverEnter = useCallback((index: number, rect: DOMRect) => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setActiveHover({ index, rect });
  }, []);

  const handleHoverLeave = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setActiveHover(null), 150);
  }, []);

  const handleHoverCancel = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
  }, []);

  return (
    <>
      <div className="group relative">
        {/* Session header: name, date, branch, delete */}
        <div className="flex items-start px-3 py-2 pr-7">
          <button
            onClick={handleResume}
            className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
          >
            {customName && (
              <div className="text-xs font-medium text-orange-400 truncate mb-0.5">
                {customName}
              </div>
            )}
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs text-muted-foreground shrink-0">
                {formatTimeAgo(session.lastActivityAt)}
              </span>
              {session.gitBranch && (
                <>
                  <BranchIcon />
                  <span className="text-xs text-muted-foreground truncate">
                    {session.gitBranch}
                  </span>
                </>
              )}
            </div>
          </button>
          {/* Delete button */}
          <button
            onClick={handleDeleteClick}
            className="shrink-0 p-0.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all mt-0.5"
            title="Delete session"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Messages section — indented under the header */}
        {messages.length > 0 && (
          <div className="ml-5 mr-2 mb-1 border-l border-border/30 pl-2">
            {/* Visible messages */}
            {shownMessages.map((msg, i) => (
              <MessageLine
                key={i}
                msg={msg}
                index={i}
                isHovered={activeHover?.index === i}
                hoverRect={activeHover?.index === i ? activeHover.rect : null}
                onHoverEnter={handleHoverEnter}
                onHoverLeave={handleHoverLeave}
                onHoverCancel={handleHoverCancel}
                onResume={handleResume}
              />
            ))}

            {/* "+N more" / "collapse" toggle */}
            {remaining > 0 && (
              <button
                onClick={handleShowMore}
                className="ml-1 my-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                +{Math.min(remaining, 5)} more
              </button>
            )}
            {visibleCount > 1 && (
              <button
                onClick={handleCollapse}
                className="ml-1 my-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                collapse
              </button>
            )}
          </div>
        )}

        {messages.length === 0 && (
          <div className="ml-5 mr-2 mb-1 pl-2 text-xs italic text-muted-foreground">
            No messages
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Are you sure you want to remove this session? This will permanently delete the session file from disk.
          </p>
          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>No</Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>Yes, delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ProjectGroupProps {
  project: ProjectHistory;
  isCollapsed: boolean;
  onToggle: (projectPath: string) => void;
  onResumeSession: (sessionId: string, cwd: string) => void;
  onDeleteSession: (sessionId: string, projectDirName: string) => void;
  colorIndex: number;
}

function ProjectGroup({ project, isCollapsed, onToggle, onResumeSession, onDeleteSession, colorIndex }: ProjectGroupProps) {
  const bgColor = GROUP_COLORS[colorIndex % GROUP_COLORS.length];

  const handleDelete = useCallback((sessionId: string) => {
    onDeleteSession(sessionId, project.projectDirName);
  }, [onDeleteSession, project.projectDirName]);

  return (
    <div className="mb-1 rounded-md overflow-hidden" style={{ backgroundColor: bgColor }}>
      <button
        onClick={() => onToggle(project.projectPath)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-muted/30 transition-colors group"
      >
        <ChevronDownIcon collapsed={isCollapsed} />
        <div className="flex-1 min-w-0 text-left">
          <div className="text-xs font-medium text-foreground truncate">
            {project.projectName}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {shortenPath(project.projectPath)}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0 ml-1">
          {project.sessions.length}
        </span>
      </button>
      {!isCollapsed && (
        <div className="ml-4 mr-1 mb-1 space-y-0.5 border-l border-border/40 pl-2">
          {project.sessions.map((session) => (
            <SessionEntry
              key={session.sessionId}
              session={session}
              onResume={onResumeSession}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function HistoryPanel({
  history,
  isLoading,
  error,
  resumeError,
  onResumeSession,
  onDeleteSession,
}: HistoryPanelProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(HISTORY_PANEL_EXPANDED_KEY);
      return stored === 'true';
    } catch {
      return false;
    }
  });

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(HISTORY_PANEL_WIDTH_KEY);
      if (stored) {
        const w = parseInt(stored, 10);
        if (w >= MIN_PANEL_WIDTH && w <= MAX_PANEL_WIDTH) return w;
      }
    } catch { /* ignore */ }
    return DEFAULT_PANEL_WIDTH;
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Drag-to-resize logic
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const panelLeft = panelRef.current.getBoundingClientRect().left;
      const newWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, e.clientX - panelLeft));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      // Persist width
      try {
        localStorage.setItem(HISTORY_PANEL_WIDTH_KEY, String(Math.round(panelWidth)));
      } catch { /* ignore */ }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    // Prevent text selection while dragging
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, panelWidth]);

  // Save width when resizing stops (via the state change)
  useEffect(() => {
    if (!isResizing) {
      try {
        localStorage.setItem(HISTORY_PANEL_WIDTH_KEY, String(Math.round(panelWidth)));
      } catch { /* ignore */ }
    }
  }, [isResizing, panelWidth]);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HISTORY_PANEL_EXPANDED_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const handleToggleGroup = useCallback((projectPath: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectPath)) {
        next.delete(projectPath);
      } else {
        next.add(projectPath);
      }
      return next;
    });
  }, []);

  const filteredProjects = useMemo(() => {
    if (!history) return [];
    if (!searchQuery.trim()) return history.projects;

    const q = searchQuery.toLowerCase();
    return history.projects
      .map((project) => {
        const matchesProject =
          project.projectName.toLowerCase().includes(q) ||
          project.projectPath.toLowerCase().includes(q);

        const matchedSessions = project.sessions.filter(
          (session) =>
            matchesProject ||
            (session.gitBranch?.toLowerCase().includes(q) ?? false) ||
            session.recentMessages.some((m) => m.text.toLowerCase().includes(q)) ||
            (getCustomName(session.sessionId)?.toLowerCase().includes(q) ?? false)
        );

        return { ...project, sessions: matchedSessions };
      })
      .filter((project) => project.sessions.length > 0);
  }, [history, searchQuery]);

  // Collapsed rail
  if (!isExpanded) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-4 px-2 border-r border-border bg-card/50 cursor-pointer hover:bg-muted/20 transition-colors"
        style={{ width: '36px', minWidth: '36px' }}
        onClick={handleToggleExpand}
        title="Open history panel"
      >
        <HamburgerIcon />
        <span
          className="text-xs font-medium text-muted-foreground tracking-widest select-none"
          style={{ writingMode: 'vertical-lr' }}
        >
          HISTORY
        </span>
      </div>
    );
  }

  // Expanded panel
  return (
    <div
      ref={panelRef}
      className="flex flex-col bg-card/50 relative"
      style={{ width: `${panelWidth}px`, minWidth: `${MIN_PANEL_WIDTH}px`, maxWidth: `${MAX_PANEL_WIDTH}px` }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-foreground tracking-widest uppercase">
          History
        </span>
        <button
          onClick={handleToggleExpand}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          title="Close history panel"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full text-xs bg-muted/50 border border-border rounded px-2 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Resume error */}
      {resumeError && (
        <div className="mx-3 mt-2 px-2 py-1.5 rounded bg-destructive/10 border border-destructive/20 text-destructive text-xs shrink-0">
          {resumeError}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-2 px-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-muted-foreground">Loading history...</span>
          </div>
        )}

        {!isLoading && error && (
          <div className="mx-2 px-2 py-1.5 rounded bg-destructive/10 border border-destructive/20 text-destructive text-xs">
            {error}
          </div>
        )}

        {!isLoading && !error && filteredProjects.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-muted-foreground">
              {searchQuery.trim() ? 'No results found' : 'No session history'}
            </span>
          </div>
        )}

        {!isLoading && !error && filteredProjects.map((project, index) => (
          <ProjectGroup
            key={project.projectPath}
            project={project}
            isCollapsed={collapsedGroups.has(project.projectPath)}
            onToggle={handleToggleGroup}
            onResumeSession={onResumeSession}
            onDeleteSession={onDeleteSession}
            colorIndex={index}
          />
        ))}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-ring/50 active:bg-ring/70 transition-colors"
        style={{ zIndex: 10 }}
      />
    </div>
  );
}
