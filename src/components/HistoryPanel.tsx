import { useState, useMemo, useCallback } from 'react';
import { ProjectHistory, HistorySession } from '../types/session';
import { formatTimeAgo } from '@/lib/formatters';

const HISTORY_PANEL_EXPANDED_KEY = 'agent-sessions-history-panel-expanded';

function shortenPath(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, '~/');
}

interface HistoryPanelProps {
  history: { projects: ProjectHistory[] } | null;
  isLoading: boolean;
  error: string | null;
  resumeError: string | null;
  onResumeSession: (sessionId: string, cwd: string) => void;
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

interface SessionEntryProps {
  session: HistorySession;
  onResume: (sessionId: string, cwd: string) => void;
}

function SessionEntry({ session, onResume }: SessionEntryProps) {
  const handleClick = useCallback(() => {
    onResume(session.sessionId, session.cwd);
  }, [session.sessionId, session.cwd, onResume]);

  return (
    <button
      onClick={handleClick}
      className="w-full text-left px-3 py-2 rounded hover:bg-muted/50 transition-colors group"
    >
      {/* Line 1: date + branch */}
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
      {/* Line 2: message preview */}
      <div className="text-xs text-foreground/70 truncate mt-0.5 group-hover:text-foreground transition-colors">
        {session.lastMessage ? session.lastMessage : (
          <span className="italic text-muted-foreground">No message</span>
        )}
      </div>
    </button>
  );
}

interface ProjectGroupProps {
  project: ProjectHistory;
  isCollapsed: boolean;
  onToggle: (projectPath: string) => void;
  onResumeSession: (sessionId: string, cwd: string) => void;
}

function ProjectGroup({ project, isCollapsed, onToggle, onResumeSession }: ProjectGroupProps) {
  return (
    <div className="mb-1">
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
        <div className="ml-2 mt-0.5 space-y-0.5">
          {project.sessions.map((session) => (
            <SessionEntry
              key={session.sessionId}
              session={session}
              onResume={onResumeSession}
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
}: HistoryPanelProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(HISTORY_PANEL_EXPANDED_KEY);
      return stored === 'true';
    } catch {
      return false;
    }
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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
            (session.lastMessage?.toLowerCase().includes(q) ?? false)
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
      className="flex flex-col border-r border-border bg-card/50"
      style={{ width: '288px', minWidth: '288px' }}
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

        {!isLoading && !error && filteredProjects.map((project) => (
          <ProjectGroup
            key={project.projectPath}
            project={project}
            isCollapsed={collapsedGroups.has(project.projectPath)}
            onToggle={handleToggleGroup}
            onResumeSession={onResumeSession}
          />
        ))}
      </div>
    </div>
  );
}
