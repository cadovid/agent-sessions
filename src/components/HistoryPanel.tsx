import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ProjectHistory, HistorySession } from '../types/session';
import { formatSmartDate, getDateGroupLabel } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Markdown } from './Markdown';
import { EventInspector } from './EventInspector';

const HISTORY_PANEL_EXPANDED_KEY = 'agent-sessions-history-panel-expanded';
const HISTORY_PANEL_WIDTH_KEY = 'agent-sessions-history-panel-width';
const DEFAULT_PANEL_WIDTH = 288;
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 600;


const CUSTOM_NAMES_KEY = 'agent-sessions-custom-names';
const FAVORITES_KEY = 'agent-sessions-favorites';

function getFavoriteIds(): Set<string> {
  try {
    const stored = localStorage.getItem(FAVORITES_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function saveFavoriteIds(ids: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...ids]));
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg className="w-3 h-3" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  );
}

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

// Stable color derived from project name hash
const ACCENT_COLORS = [
  '#10b981', // emerald
  '#3b82f6', // blue
  '#a855f7', // purple
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
  '#84cc16', // lime
  '#8b5cf6', // violet
];

function getProjectAccentColor(projectName: string): string {
  let hash = 0;
  for (let i = 0; i < projectName.length; i++) {
    hash = ((hash << 5) - hash + projectName.charCodeAt(i)) | 0;
  }
  return ACCENT_COLORS[Math.abs(hash) % ACCENT_COLORS.length];
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

// Subagent hierarchy section within a session
function SubagentSection({
  subagents,
  sessionId,
  projectDirName,
  accentColor,
}: {
  subagents: import('../types/session').SubagentInfo[];
  sessionId: string;
  projectDirName: string;
  accentColor?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);
  const [inspectAgent, setInspectAgent] = useState<import('../types/session').SubagentInfo | null>(null);

  const shown = expanded ? subagents.slice(0, visibleCount) : [];
  const remaining = subagents.length - visibleCount;

  return (
    <>
      <div className="ml-5 mr-2 mb-1 pl-2">
        <button
          onClick={() => setExpanded((p) => !p)}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-1"
        >
          <svg
            className={`w-2.5 h-2.5 transition-transform ${expanded ? '' : '-rotate-90'}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
          </svg>
          <span className="font-medium">{subagents.length} subagent{subagents.length !== 1 ? 's' : ''}</span>
        </button>

        {expanded && (
          <div className="ml-3 border-l border-purple-500/20 pl-2 space-y-0.5">
            {shown.map((agent) => (
              <div
                key={agent.agentId}
                className="group flex items-start gap-2 py-1 px-1 rounded hover:bg-muted/20 cursor-pointer"
                onClick={() => setInspectAgent(agent)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30">
                      Agent
                    </span>
                    <span className="text-[10px] text-foreground/70 truncate">
                      {agent.slug || agent.agentId.slice(0, 12)}
                    </span>
                    <span className="text-[9px] text-muted-foreground/50">
                      {agent.eventCount} events
                    </span>
                  </div>
                  {agent.taskDescription && (
                    <div className="text-[10px] text-foreground/50 line-clamp-1 mt-0.5 ml-0.5">
                      {agent.taskDescription}
                    </div>
                  )}
                </div>
                {/* Inspect button */}
                <button
                  onClick={(e) => { e.stopPropagation(); setInspectAgent(agent); }}
                  className="p-0.5 rounded text-muted-foreground/40 hover:text-blue-400 hover:bg-blue-400/10 opacity-0 group-hover:opacity-100 transition-all shrink-0 mt-0.5"
                  title="Inspect subagent"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </button>
              </div>
            ))}

            {expanded && remaining > 0 && (
              <button
                onClick={() => setVisibleCount((p) => Math.min(p + 10, subagents.length))}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-1 py-0.5"
              >
                +{Math.min(remaining, 10)} more
              </button>
            )}
            {visibleCount > 10 && (
              <button
                onClick={() => setVisibleCount(10)}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-1 py-0.5"
              >
                collapse
              </button>
            )}
          </div>
        )}
      </div>

      {/* Subagent inspector */}
      {inspectAgent && (
        <EventInspector
          open={!!inspectAgent}
          onClose={() => setInspectAgent(null)}
          sessionId={sessionId}
          projectDirName={projectDirName}
          sessionLabel={inspectAgent.slug || inspectAgent.agentId.slice(0, 12)}
          accentColor={accentColor}
          agentId={inspectAgent.agentId}
        />
      )}
    </>
  );
}

interface SessionEntryProps {
  session: HistorySession;
  onResume: (sessionId: string, cwd: string) => void;
  onDelete: (sessionId: string) => void;
  showProjectName?: string;
  isFavorited?: boolean;
  onToggleFavorite?: (sessionId: string) => void;
  accentColor?: string;
  projectDirName: string;
}

function SessionEntry({ session, onResume, onDelete, showProjectName, isFavorited, onToggleFavorite, accentColor, projectDirName }: SessionEntryProps) {
  const customName = getCustomName(session.sessionId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
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
      <div
        className="group relative border-b border-border/10"
        style={accentColor ? { borderLeft: `2px solid ${accentColor}` } : undefined}
      >
        {/* Session header: name, date, branch, delete */}
        <div className="flex items-start px-3 py-2 pr-7">
          <button
            onClick={handleResume}
            className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
          >
            {showProjectName && (
              <div className="text-[10px] text-foreground/50 truncate mb-0.5">
                {showProjectName}
              </div>
            )}
            {customName && (
              <div className="text-xs font-medium text-orange-400 truncate mb-0.5">
                {customName}
              </div>
            )}
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs text-muted-foreground shrink-0">
                {formatSmartDate(session.lastActivityAt)}
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
          {/* Star + Inspect + Delete buttons */}
          <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
            {onToggleFavorite && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(session.sessionId); }}
                className={`p-0.5 rounded transition-all ${isFavorited ? 'text-amber-400' : 'text-muted-foreground/40 hover:text-amber-400 opacity-0 group-hover:opacity-100'}`}
                title={isFavorited ? 'Unstar session' : 'Star session'}
              >
                <StarIcon filled={!!isFavorited} />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setInspectorOpen(true); }}
              className="p-0.5 rounded text-muted-foreground/40 hover:text-blue-400 hover:bg-blue-400/10 opacity-0 group-hover:opacity-100 transition-all"
              title="Inspect events"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <button
              onClick={handleDeleteClick}
              className="p-0.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
              title="Delete session"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
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

        {/* Subagent hierarchy */}
        {session.subagents.length > 0 && (
          <SubagentSection
            subagents={session.subagents}
            sessionId={session.sessionId}
            projectDirName={projectDirName}
            accentColor={accentColor}
          />
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

      {/* Event Inspector */}
      <EventInspector
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        sessionId={session.sessionId}
        projectDirName={projectDirName}
        sessionLabel={customName || showProjectName || session.sessionId.slice(0, 8)}
        accentColor={accentColor}
      />
    </>
  );
}

interface ProjectGroupProps {
  project: ProjectHistory;
  isCollapsed: boolean;
  onToggle: (projectPath: string) => void;
  onResumeSession: (sessionId: string, cwd: string) => void;
  onDeleteSession: (sessionId: string, projectDirName: string) => void;
  favoriteIds: Set<string>;
  onToggleFavorite: (sessionId: string, projectDirName: string) => void;
}

function groupSessionsByDate(sessions: HistorySession[]): { label: string; sessions: HistorySession[] }[] {
  const groups: { label: string; sessions: HistorySession[] }[] = [];
  let currentLabel = '';
  for (const session of sessions) {
    const label = getDateGroupLabel(session.lastActivityAt);
    if (label !== currentLabel) {
      groups.push({ label, sessions: [session] });
      currentLabel = label;
    } else {
      groups[groups.length - 1].sessions.push(session);
    }
  }
  return groups;
}

function ProjectGroup({ project, isCollapsed, onToggle, onResumeSession, onDeleteSession, favoriteIds, onToggleFavorite }: ProjectGroupProps) {
  const handleDelete = useCallback((sessionId: string) => {
    onDeleteSession(sessionId, project.projectDirName);
  }, [onDeleteSession, project.projectDirName]);

  const handleFavorite = useCallback((sessionId: string) => {
    onToggleFavorite(sessionId, project.projectDirName);
  }, [onToggleFavorite, project.projectDirName]);

  const dateGroups = useMemo(() => groupSessionsByDate(project.sessions), [project.sessions]);
  const accentColor = useMemo(() => getProjectAccentColor(project.projectName), [project.projectName]);

  return (
    <div className="mb-1 rounded-md overflow-hidden">
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
          {dateGroups.map((group) => (
            <div key={group.label}>
              <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider px-3 py-1">
                {group.label}
              </div>
              {group.sessions.map((session) => (
                <SessionEntry
                  key={session.sessionId}
                  session={session}
                  onResume={onResumeSession}
                  onDelete={handleDelete}
                  isFavorited={favoriteIds.has(session.sessionId)}
                  onToggleFavorite={handleFavorite}
                  accentColor={accentColor}
                  projectDirName={project.projectDirName}
                />
              ))}
            </div>
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
  const [groupingMode, setGroupingMode] = useState<'project' | 'date'>('project');
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(getFavoriteIds);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
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

  const handleToggleFavorite = useCallback(async (sessionId: string, projectDirName: string) => {
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
        // Archive on star
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('archive_session', { sessionId, projectDirName }).catch(console.error);
        });
      }
      saveFavoriteIds(next);
      return next;
    });
  }, []);

  const filteredProjects = useMemo(() => {
    if (!history) return [];

    // Apply favorites filter first
    let projects = history.projects;
    if (showFavoritesOnly) {
      projects = projects
        .map((p) => ({ ...p, sessions: p.sessions.filter((s) => favoriteIds.has(s.sessionId)) }))
        .filter((p) => p.sessions.length > 0);
    }

    if (!searchQuery.trim()) return projects;

    const q = searchQuery.toLowerCase();
    return projects
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
  }, [history, searchQuery, showFavoritesOnly, favoriteIds]);

  // "By Date" mode: flatten all sessions, group by date
  const dateGroupedView = useMemo(() => {
    if (groupingMode !== 'date' || !history) return [];

    type FlatSession = HistorySession & { projectName: string; projectDirName: string };

    // Apply favorites filter
    let projects = history.projects;
    if (showFavoritesOnly) {
      projects = projects
        .map((p) => ({ ...p, sessions: p.sessions.filter((s) => favoriteIds.has(s.sessionId)) }))
        .filter((p) => p.sessions.length > 0);
    }

    const allSessions: FlatSession[] = projects.flatMap((p) =>
      p.sessions.map((s) => ({ ...s, projectName: p.projectName, projectDirName: p.projectDirName }))
    );

    const q = searchQuery.toLowerCase();
    const filtered = q
      ? allSessions.filter(
          (s) =>
            s.projectName.toLowerCase().includes(q) ||
            (s.gitBranch?.toLowerCase().includes(q) ?? false) ||
            s.recentMessages.some((m) => m.text.toLowerCase().includes(q)) ||
            (getCustomName(s.sessionId)?.toLowerCase().includes(q) ?? false)
        )
      : allSessions;

    filtered.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

    const groups: { label: string; sessions: FlatSession[] }[] = [];
    let currentLabel = '';
    for (const s of filtered) {
      const label = getDateGroupLabel(s.lastActivityAt);
      if (label !== currentLabel) {
        groups.push({ label, sessions: [s] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].sessions.push(s);
      }
    }
    return groups;
  }, [history, groupingMode, searchQuery, showFavoritesOnly, favoriteIds]);

  // Collapsed rail
  if (!isExpanded) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-4 px-2 border-r border-white/5 cursor-pointer hover:bg-muted/20 transition-colors"
        style={{ width: '36px', minWidth: '36px', backgroundColor: 'rgba(0, 0, 0, 0.15)' }}
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
      className="flex flex-col relative border-r border-white/5"
      style={{ width: `${panelWidth}px`, minWidth: `${MIN_PANEL_WIDTH}px`, maxWidth: `${MAX_PANEL_WIDTH}px`, backgroundColor: 'rgba(0, 0, 0, 0.15)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground tracking-widest uppercase">
            History
          </span>
          <div className="flex text-[10px] bg-muted/50 rounded overflow-hidden">
            <button
              onClick={() => setGroupingMode('project')}
              className={`px-2 py-0.5 transition-colors ${groupingMode === 'project' ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Project
            </button>
            <button
              onClick={() => setGroupingMode('date')}
              className={`px-2 py-0.5 transition-colors ${groupingMode === 'date' ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Date
            </button>
          </div>
          <button
            onClick={() => setShowFavoritesOnly((p) => !p)}
            className={`p-0.5 rounded transition-colors ${showFavoritesOnly ? 'text-amber-400' : 'text-muted-foreground hover:text-amber-400'}`}
            title={showFavoritesOnly ? 'Show all' : 'Show favorites only'}
          >
            <StarIcon filled={showFavoritesOnly} />
          </button>
        </div>
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

        {!isLoading && !error && groupingMode === 'project' && filteredProjects.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-muted-foreground">
              {searchQuery.trim() ? 'No results found' : 'No session history'}
            </span>
          </div>
        )}

        {!isLoading && !error && groupingMode === 'date' && dateGroupedView.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-muted-foreground">
              {searchQuery.trim() ? 'No results found' : 'No session history'}
            </span>
          </div>
        )}

        {/* By Project mode */}
        {!isLoading && !error && groupingMode === 'project' && filteredProjects.map((project) => (
          <ProjectGroup
            key={project.projectPath}
            project={project}
            isCollapsed={collapsedGroups.has(project.projectPath)}
            onToggle={handleToggleGroup}
            onResumeSession={onResumeSession}
            onDeleteSession={onDeleteSession}
            favoriteIds={favoriteIds}
            onToggleFavorite={handleToggleFavorite}
          />
        ))}

        {/* By Date mode */}
        {!isLoading && !error && groupingMode === 'date' && dateGroupedView.map((group) => (
          <div key={group.label} className="mb-1 rounded-md overflow-hidden">
            <button
              onClick={() => handleToggleGroup(group.label)}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-muted/30 transition-colors"
            >
              <ChevronDownIcon collapsed={collapsedGroups.has(group.label)} />
              <div className="flex-1 min-w-0 text-left">
                <div className="text-xs font-medium text-foreground">
                  {group.label}
                </div>
              </div>
              <span className="text-xs text-muted-foreground shrink-0 ml-1">
                {group.sessions.length}
              </span>
            </button>
            {!collapsedGroups.has(group.label) && (
              <div className="ml-4 mr-1 mb-1 space-y-0.5 border-l border-border/40 pl-2">
                {group.sessions.map((session) => (
                  <SessionEntry
                    key={session.sessionId}
                    session={session}
                    onResume={onResumeSession}
                    onDelete={(id) => onDeleteSession(id, (session as any).projectDirName)}
                    showProjectName={(session as any).projectName}
                    isFavorited={favoriteIds.has(session.sessionId)}
                    onToggleFavorite={(id) => handleToggleFavorite(id, (session as any).projectDirName)}
                    accentColor={getProjectAccentColor((session as any).projectName)}
                    projectDirName={(session as any).projectDirName}
                  />
                ))}
              </div>
            )}
          </div>
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
