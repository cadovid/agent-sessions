import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { SessionEvent } from '../types/session';
import { Markdown } from './Markdown';
import { Button } from '@/components/ui/button';

interface EventInspectorProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  projectDirName: string;
  sessionLabel: string;
  accentColor?: string;
  isLive?: boolean;
  agentId?: string;
}

const EVENT_TYPE_CONFIG: Record<string, { label: string; color: string; accent: string }> = {
  human: { label: 'User', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', accent: '#3b82f6' },
  assistant: { label: 'Assistant', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', accent: '#10b981' },
  tool_use: { label: 'Tool Call', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30', accent: '#a855f7' },
  tool_result: { label: 'Tool Result', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30', accent: '#f59e0b' },
  thinking: { label: 'Thinking', color: 'bg-gray-500/15 text-gray-500 border-gray-500/20', accent: '#4b5563' },
  system: { label: 'System', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30', accent: '#6b7280' },
  unknown: { label: 'Event', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30', accent: '#6b7280' },
};

function getEventConfig(event: SessionEvent) {
  if (event.eventType === 'thinking') return EVENT_TYPE_CONFIG.thinking;
  if (event.eventType === 'tool_use') return EVENT_TYPE_CONFIG.tool_use;
  if (event.eventType === 'tool_result') return EVENT_TYPE_CONFIG.tool_result;
  if (event.role === 'tool') return event.eventType === 'tool_result' ? EVENT_TYPE_CONFIG.tool_result : EVENT_TYPE_CONFIG.tool_use;
  if (event.role === 'user' || event.role === 'human') return EVENT_TYPE_CONFIG.human;
  if (event.role === 'assistant') return EVENT_TYPE_CONFIG.assistant;
  return EVENT_TYPE_CONFIG[event.eventType] ?? EVENT_TYPE_CONFIG.unknown;
}

function getEventTypeKey(event: SessionEvent): string {
  if (event.eventType === 'thinking') return 'system';
  if (event.eventType === 'tool_use' || event.eventType === 'tool_result' || event.role === 'tool') return 'tool';
  if (event.role === 'user' || event.role === 'human') return 'user';
  if (event.role === 'assistant') return 'assistant';
  return 'system';
}

type FilterType = 'all' | 'user' | 'assistant' | 'tool' | 'system';
type SemanticType = 'none' | 'search' | 'edit' | 'execute' | 'plan' | 'diff' | 'web' | 'delegate';
type ViewMode = 'timeline' | 'raw';

// Line-numbered source dump pattern (Claude Code's Read tool format: "42→ code", "42| code", "42: code", "42- code")
const LINE_NUMBERED_SOURCE = /^\d+\s*(\u2192|\||:|-|  )\s/m;

// Prepare content for Pretty rendering: wrap source-like content in code fences
function prepareContentForPretty(text: string): string {
  // Already has code fences — leave it alone
  if (/^[ \t]*```/m.test(text)) return text;

  const lines = text.split('\n');
  if (lines.length < 3) return text;

  // Detect unified diff content (diff --git, @@, ---/+++)
  const hasGitHeader = /^diff --git /m.test(text);
  const hasHunk = /^@@/m.test(text);
  const hasPatchMinus = /^--- /m.test(text);
  const hasPatchPlus = /^\+\+\+ /m.test(text);
  if (hasGitHeader || (hasHunk && hasPatchMinus && hasPatchPlus)) {
    return '```diff\n' + text + '\n```';
  }

  // Check if most non-empty lines start with a number (line-numbered output)
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const numbered = nonEmpty.filter((l) => /^\d+/.test(l.trim()));
  if (numbered.length >= nonEmpty.length * 0.5) {
    return '```text\n' + text + '\n```';
  }
  return text;
}

// Tool classification sets
const SEARCH_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP', 'ToolSearch']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const EXECUTE_TOOLS = new Set(['Bash', 'PowerShell']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const DELEGATE_TOOLS = new Set(['Agent', 'SendMessage', 'TeamCreate', 'TeamDelete']);
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion']);

// Detect semantic type (priority: Plan > Diff > tool-based classification > content-based)
function detectSemanticType(event: SessionEvent): SemanticType {
  const text = event.contentPreview ?? '';
  const toolName = event.toolName ?? '';

  // 1. Plan: <proposed_plan> tags in assistant text, or Plan Mode tools
  if (event.role === 'assistant' && text.includes('<proposed_plan>')) {
    return 'plan';
  }
  if (PLAN_TOOLS.has(toolName)) {
    return 'plan';
  }

  // 2. Diff: structural unified diff markers OR ```diff code fences (in any event)
  if (text) {
    const hasDiffFence = /^[ \t]*```diff/m.test(text);
    const hasGitHeader = /^diff --git /m.test(text);
    const hasHunk = /^@@/m.test(text);
    const hasPatchMinus = /^--- /m.test(text);
    const hasPatchPlus = /^\+\+\+ /m.test(text);
    const hasPatchFiles = hasPatchMinus && hasPatchPlus;

    if (hasDiffFence || (hasGitHeader && (hasHunk || hasPatchFiles)) || (hasHunk && hasPatchFiles)) {
      return 'diff';
    }
  }

  // 3. Tool-name-based classification
  if (toolName) {
    if (SEARCH_TOOLS.has(toolName)) return 'search';
    if (EDIT_TOOLS.has(toolName)) return 'edit';
    if (EXECUTE_TOOLS.has(toolName)) return 'execute';
    if (WEB_TOOLS.has(toolName)) return 'web';
    if (DELEGATE_TOOLS.has(toolName)) return 'delegate';
  }

  // 4. Content-based: code fences in assistant text
  if (event.role === 'assistant' && text && /^[ \t]*```/m.test(text)) {
    return 'edit'; // assistant providing code = edit context
  }

  // 5. Tool results without toolName: check content patterns
  if (event.eventType === 'tool_result' && text) {
    if (LINE_NUMBERED_SOURCE.test(text)) return 'search';
    if (text.includes('\n') && /^\d+/.test(text.trim())) return 'search';
  }

  return 'none';
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// Highlight search matches in text
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const parts: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    cursor = idx + q.length;
  }
  return (
    <>
      {parts.map((p, i) =>
        p.match ? <mark key={i} className="bg-yellow-500/40 text-foreground rounded-sm px-0.5">{p.text}</mark> : <span key={i}>{p.text}</span>
      )}
    </>
  );
}

function PrettyJson({ json, query }: { json: string; query?: string }) {
  const formatted = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }, [json]);

  return (
    <pre className="text-xs bg-muted/30 rounded-lg p-3 overflow-auto whitespace-pre-wrap break-words font-mono text-foreground/80">
      {query ? <HighlightText text={formatted} query={query} /> : formatted}
    </pre>
  );
}

const SEMANTIC_BADGE: Record<string, { label: string; color: string } | null> = {
  search: { label: 'Search', color: 'text-blue-400/70' },
  edit: { label: 'Edit', color: 'text-cyan-400/70' },
  execute: { label: 'Exec', color: 'text-yellow-400/70' },
  plan: { label: 'Plan', color: 'text-violet-400/70' },
  diff: { label: 'Diff', color: 'text-orange-400/70' },
  web: { label: 'Web', color: 'text-pink-400/70' },
  delegate: { label: 'Agent', color: 'text-teal-400/70' },
  none: null,
};

const EventRow = memo(function EventRow({
  event,
  isSelected,
  onClick,
  rowIndex,
  searchQuery,
  semanticType,
}: {
  event: SessionEvent;
  isSelected: boolean;
  onClick: () => void;
  rowIndex: number;
  searchQuery: string;
  semanticType: SemanticType;
}) {
  const config = getEventConfig(event);
  const zebra = rowIndex % 2 === 1 ? 'bg-white/[0.02]' : '';
  const semBadge = SEMANTIC_BADGE[semanticType];
  return (
    <button
      data-event-index={event.index}
      onClick={onClick}
      className={`w-full text-left py-2 pr-3 pl-0 border-b border-border/10 transition-colors flex ${
        isSelected ? 'bg-muted/50' : `hover:bg-muted/20 ${zebra}`
      }`}
      style={{ borderLeft: `3px solid ${config.accent}` }}
    >
      <div className="pl-2.5 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${config.color}`}>
            {config.label}
          </span>
          {semBadge && (
            <span className={`text-[8px] font-medium ${semBadge.color}`}>
              {semBadge.label}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">
            {formatTimestamp(event.timestamp)}
          </span>
        </div>
        {event.contentPreview && (
          <div className="text-xs text-foreground/60 line-clamp-1 mt-0.5">
            {searchQuery ? <HighlightText text={event.contentPreview} query={searchQuery} /> : event.contentPreview}
          </div>
        )}
      </div>
    </button>
  );
});

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// Virtual scroll for event list
const ROW_HEIGHT = 52;
const OVERSCAN = 10;

function useVirtualScroll(itemCount: number) {
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Callback ref: called when the DOM element mounts/unmounts
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    // Cleanup previous
    if (containerElRef.current) {
      containerElRef.current.removeEventListener('scroll', handleScroll);
      observerRef.current?.disconnect();
    }

    containerElRef.current = el;

    if (el) {
      el.addEventListener('scroll', handleScroll, { passive: true });
      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) setContainerHeight(entry.contentRect.height);
      });
      observerRef.current.observe(el);
      setContainerHeight(el.clientHeight);
      setScrollTop(el.scrollTop);
    }

    function handleScroll() {
      if (containerElRef.current) setScrollTop(containerElRef.current.scrollTop);
    }
  }, []);

  const totalHeight = itemCount * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + 2 * OVERSCAN;
  const endIndex = Math.min(itemCount - 1, startIndex + visibleCount);

  return { totalHeight, startIndex, endIndex, setContainerRef, containerElRef };
}

export function EventInspector({ open, onClose, sessionId, projectDirName, sessionLabel, accentColor, isLive, agentId }: EventInspectorProps) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [semanticFilter, setSemanticFilter] = useState<SemanticType | 'all'>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery, 200);

  // Lazy rawJson loading
  const [rawJsonCache, setRawJsonCache] = useState<Map<number, string>>(new Map());
  const [selectedRawJson, setSelectedRawJson] = useState<string | null>(null);

  // Dialog position + size
  const [dialogSize, setDialogSize] = useState({ width: 900, height: 600 });
  const [dialogPos, setDialogPos] = useState<{ x: number; y: number } | null>(null);
  const [isResizingDialog, setIsResizingDialog] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const interactionStart = useRef({ mx: 0, my: 0, w: 0, h: 0, px: 0, py: 0 });

  // Resizable split pane
  const [splitPos, setSplitPos] = useState(380);
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Virtual scroll removes the need for a separate eventListRef

  // Reset position when opening
  useEffect(() => {
    if (open) setDialogPos(null);
  }, [open]);

  // Drag handler
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    setIsDragging(true);
    const rect = dialogRef.current?.getBoundingClientRect();
    if (rect) {
      interactionStart.current = { mx: e.clientX, my: e.clientY, w: 0, h: 0, px: rect.left, py: rect.top };
      if (!dialogPos) {
        setDialogPos({ x: rect.left, y: rect.top });
        interactionStart.current.px = rect.left;
        interactionStart.current.py = rect.top;
      }
    }
  }, [dialogPos]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      setDialogPos({
        x: interactionStart.current.px + (e.clientX - interactionStart.current.mx),
        y: interactionStart.current.py + (e.clientY - interactionStart.current.my),
      });
    };
    const handleUp = () => setIsDragging(false);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'move';
    return () => { document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp); document.body.style.userSelect = ''; document.body.style.cursor = ''; };
  }, [isDragging]);

  // Dialog resize
  const handleDialogResizeStart = useCallback((e: React.MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingDialog(edge);
    const rect = dialogRef.current?.getBoundingClientRect();
    interactionStart.current = { mx: e.clientX, my: e.clientY, w: dialogSize.width, h: dialogSize.height, px: rect?.left ?? 0, py: rect?.top ?? 0 };
    if (!dialogPos && rect) {
      setDialogPos({ x: rect.left, y: rect.top });
      interactionStart.current.px = rect.left;
      interactionStart.current.py = rect.top;
    }
  }, [dialogSize, dialogPos]);

  useEffect(() => {
    if (!isResizingDialog) return;
    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - interactionStart.current.mx;
      const dy = e.clientY - interactionStart.current.my;
      const edge = isResizingDialog;
      let newW = interactionStart.current.w, newH = interactionStart.current.h;
      let newX = interactionStart.current.px, newY = interactionStart.current.py;
      if (edge.includes('e')) newW = Math.max(600, newW + dx);
      if (edge.includes('w')) { newW = Math.max(600, newW - dx); newX = interactionStart.current.px + dx; }
      if (edge.includes('s')) newH = Math.max(400, newH + dy);
      if (edge.includes('n')) { newH = Math.max(400, newH - dy); newY = interactionStart.current.py + dy; }
      setDialogSize({ width: newW, height: newH });
      setDialogPos({ x: newX, y: newY });
    };
    const handleUp = () => setIsResizingDialog(null);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = isResizingDialog === 'e' || isResizingDialog === 'w' ? 'ew-resize' : isResizingDialog === 's' || isResizingDialog === 'n' ? 'ns-resize' : 'nwse-resize';
    return () => { document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp); document.body.style.userSelect = ''; document.body.style.cursor = ''; };
  }, [isResizingDialog]);

  // Split pane resize
  const handleSplitStart = useCallback((e: React.MouseEvent) => { e.preventDefault(); setIsResizingSplit(true); }, []);
  useEffect(() => {
    if (!isResizingSplit) return;
    const handleMove = (e: MouseEvent) => { if (!splitContainerRef.current) return; const rect = splitContainerRef.current.getBoundingClientRect(); setSplitPos(Math.max(200, Math.min(e.clientX - rect.left, rect.width - 200))); };
    const handleUp = () => setIsResizingSplit(false);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => { document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp); document.body.style.userSelect = ''; document.body.style.cursor = ''; };
  }, [isResizingSplit]);

  // Load events (initial full load)
  const loadEvents = useCallback(() => {
    return invoke<SessionEvent[]>('get_session_events', { sessionId, projectDirName, agentId: agentId || null, afterIndex: null })
      .then(setEvents)
      .catch((e) => setError(String(e)));
  }, [sessionId, projectDirName, agentId]);

  // Incremental refresh (only new events)
  const eventsRef = useRef<SessionEvent[]>([]);
  eventsRef.current = events;

  const loadNewEvents = useCallback(() => {
    const currentEvents = eventsRef.current;
    if (currentEvents.length === 0) return loadEvents();
    const lastIndex = currentEvents[currentEvents.length - 1].index;
    return invoke<SessionEvent[]>('get_session_events', {
      sessionId, projectDirName, agentId: agentId || null, afterIndex: lastIndex,
    })
      .then((newEvents) => {
        if (newEvents.length > 0) {
          setEvents((prev) => [...prev, ...newEvents]);
        }
      })
      .catch(console.error);
  }, [sessionId, projectDirName, agentId, loadEvents]);

  useEffect(() => {
    if (!open) return;
    setIsLoading(true);
    setError(null);
    setSelectedIndex(null);
    setSearchQuery('');
    setRawJsonCache(new Map());
    setSelectedRawJson(null);
    loadEvents().finally(() => setIsLoading(false));
  }, [open, sessionId, projectDirName, loadEvents]);

  // Live refresh — incremental, every 3 seconds
  useEffect(() => {
    if (!open || !isLive) return;
    const interval = setInterval(loadNewEvents, 3000);
    return () => clearInterval(interval);
  }, [open, isLive, loadNewEvents]);

  // Fetch rawJson on demand when needed
  const fetchRawJson = useCallback(async (eventIndex: number) => {
    const cached = rawJsonCache.get(eventIndex);
    if (cached) { setSelectedRawJson(cached); return; }
    try {
      const json = await invoke<string>('get_event_raw_json', {
        sessionId, projectDirName, eventIndex, agentId: agentId || null,
      });
      setRawJsonCache((prev) => new Map(prev).set(eventIndex, json));
      setSelectedRawJson(json);
    } catch (e) {
      setSelectedRawJson(`Error loading raw JSON: ${e}`);
    }
  }, [rawJsonCache, sessionId, projectDirName, agentId]);

  // Trigger rawJson fetch when needed
  useEffect(() => {
    if (selectedIndex === null) { setSelectedRawJson(null); return; }
    const event = events.find((e) => e.index === selectedIndex);
    const needsRaw = viewMode === 'raw' || !event?.contentPreview;
    if (!needsRaw) { setSelectedRawJson(null); return; }
    fetchRawJson(selectedIndex);
  }, [selectedIndex, viewMode, events, fetchRawJson]);

  // Pre-compute search data + semantic types (once per load)
  const searchableEvents = useMemo(() =>
    events.map((e) => ({
      event: e,
      lowerPreview: e.contentPreview?.toLowerCase() ?? '',
      semantic: detectSemanticType(e),
    })),
    [events]
  );

  const filteredEvents = useMemo(() => {
    let result = searchableEvents;
    // Hide thinking events by default (they have no useful content)
    if (filter === 'all') {
      result = result.filter(({ event: e }) => e.eventType !== 'thinking');
    } else {
      result = result.filter(({ event: e }) => {
        const typeKey = getEventTypeKey(e);
        switch (filter) {
          case 'user': return typeKey === 'user';
          case 'assistant': return typeKey === 'assistant';
          case 'tool': return typeKey === 'tool';
          case 'system': return typeKey === 'system'; // includes thinking
          default: return true;
        }
      });
    }
    // Semantic filter
    if (semanticFilter !== 'all') {
      result = result.filter(({ semantic }) => semantic === semanticFilter);
    }
    // Search filter
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter(({ lowerPreview }) => lowerPreview.includes(q));
    }
    return result.map(({ event, semantic }) => ({ event, semantic })).reverse();
  }, [searchableEvents, filter, semanticFilter, debouncedSearch]);

  // Navigation: counts per type
  const typeCounts = useMemo(() => {
    const counts = { user: 0, assistant: 0, tool: 0, system: 0 };
    for (const { event: e } of filteredEvents) {
      const key = getEventTypeKey(e);
      if (key in counts) counts[key as keyof typeof counts]++;
    }
    return counts;
  }, [filteredEvents]);

  // Navigate to next/prev event of a given type
  const navigateTo = useCallback((typeKey: string, direction: 'next' | 'prev') => {
    const currentPos = selectedIndex !== null
      ? filteredEvents.findIndex(({ event: e }) => e.index === selectedIndex)
      : -1;

    const candidates = filteredEvents
      .map(({ event: e }, i) => ({ event: e, pos: i }))
      .filter(({ event }) => getEventTypeKey(event) === typeKey);

    if (candidates.length === 0) return;

    let target: typeof candidates[0];
    if (direction === 'next') {
      target = candidates.find((c) => c.pos > currentPos) ?? candidates[0];
    } else {
      target = [...candidates].reverse().find((c) => c.pos < currentPos) ?? candidates[candidates.length - 1];
    }

    setSelectedIndex(target.event.index);

    // Scroll to target using virtual scroll positioning
    requestAnimationFrame(() => {
      const el = virtualScroll.containerElRef.current;
      if (el) {
        el.scrollTop = target.pos * ROW_HEIGHT - el.clientHeight / 2 + ROW_HEIGHT / 2;
      }
    });
  }, [filteredEvents, selectedIndex]);

  const selectedEvent = selectedIndex !== null ? events.find((e) => e.index === selectedIndex) : null;
  const virtualScroll = useVirtualScroll(filteredEvents.length);

  const handleCopy = useCallback(() => {
    if (!selectedEvent) return;
    if (viewMode === 'raw') {
      if (selectedRawJson) navigator.clipboard.writeText(selectedRawJson);
    } else {
      navigator.clipboard.writeText(selectedEvent.contentPreview || '');
    }
  }, [selectedEvent, viewMode, selectedRawJson]);

  // Semantic counts (from the role-filtered set, before semantic filter is applied)
  const semanticCounts = useMemo(() => {
    const counts: Record<string, number> = { search: 0, edit: 0, execute: 0, plan: 0, diff: 0, web: 0, delegate: 0 };
    for (const { event: e, semantic } of searchableEvents) {
      if (filter !== 'all') {
        const typeKey = getEventTypeKey(e);
        if (typeKey !== filter) continue;
      } else if (e.eventType === 'thinking') {
        continue;
      }
      if (semantic !== 'none' && semantic in counts) counts[semantic]++;
    }
    return counts;
  }, [searchableEvents, filter]);

  const typeFilters: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'user', label: 'User' },
    { key: 'assistant', label: 'Assistant' },
    { key: 'tool', label: 'Tools' },
    { key: 'system', label: 'System' },
  ];

  const semanticFilters: { key: SemanticType | 'all'; label: string; count: number; accent: string }[] = [
    { key: 'all', label: 'Any', count: 0, accent: '' },
    { key: 'search', label: 'Search', count: semanticCounts.search, accent: '#3b82f6' },
    { key: 'edit', label: 'Edit', count: semanticCounts.edit, accent: '#06b6d4' },
    { key: 'execute', label: 'Exec', count: semanticCounts.execute, accent: '#eab308' },
    { key: 'plan', label: 'Plan', count: semanticCounts.plan, accent: '#8b5cf6' },
    { key: 'diff', label: 'Diff', count: semanticCounts.diff, accent: '#f97316' },
    { key: 'web', label: 'Web', count: semanticCounts.web, accent: '#ec4899' },
    { key: 'delegate', label: 'Agent', count: semanticCounts.delegate, accent: '#14b8a6' },
  ];

  const navPills: { key: string; label: string; count: number; accent: string }[] = [
    { key: 'user', label: 'User', count: typeCounts.user, accent: '#3b82f6' },
    { key: 'assistant', label: 'Asst', count: typeCounts.assistant, accent: '#10b981' },
    { key: 'tool', label: 'Tool', count: typeCounts.tool, accent: '#a855f7' },
    { key: 'system', label: 'Sys', count: typeCounts.system, accent: '#6b7280' },
  ];

  if (!open) return null;

  const dialogStyle: React.CSSProperties = dialogPos
    ? { position: 'fixed', left: dialogPos.x, top: dialogPos.y, width: dialogSize.width, height: dialogSize.height, transform: 'none', maxWidth: '100vw', maxHeight: '100vh' }
    : { width: dialogSize.width, height: dialogSize.height, maxWidth: '95vw', maxHeight: '95vh' };

  const panel = (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={dialogRef}
        className={`${dialogPos ? '' : 'relative'} bg-popover border border-border rounded-lg shadow-2xl flex flex-col overflow-hidden z-50`}
        style={dialogStyle}
      >
        {/* Resize handles — z-10 so they don't overlap the split pane handle */}
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'e')} className="absolute top-0 right-0 w-1.5 h-full cursor-ew-resize z-10" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'w')} className="absolute top-0 left-0 w-1.5 h-full cursor-ew-resize z-10" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 's')} className="absolute bottom-0 left-0 h-1.5 w-full cursor-ns-resize z-10" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'n')} className="absolute top-0 left-0 h-1.5 w-full cursor-ns-resize z-10" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'se')} className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-20" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'sw')} className="absolute bottom-0 left-0 w-4 h-4 cursor-nesw-resize z-20" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'ne')} className="absolute top-0 right-0 w-4 h-4 cursor-nesw-resize z-20" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'nw')} className="absolute top-0 left-0 w-4 h-4 cursor-nwse-resize z-20" />

        {/* Header */}
        <div
          onMouseDown={handleDragStart}
          className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 cursor-move select-none"
          style={{ backgroundColor: accentColor ? `${accentColor}20` : 'rgba(255, 255, 255, 0.08)' }}
        >
          <span className="text-sm font-semibold text-foreground">
            Event Inspector — {sessionLabel}
          </span>
          <div className="flex items-center gap-3">
            {isLive && (
              <span className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                LIVE
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {filteredEvents.length}{filteredEvents.length !== events.length ? ` / ${events.length}` : ''} events
            </span>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Toolbar: filters + search + view toggle */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0 gap-2" style={{ backgroundColor: 'rgba(255, 255, 255, 0.04)' }}>
          <div className="flex gap-1 shrink-0 items-center">
            {typeFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  filter === f.key ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                {f.label}
              </button>
            ))}
            <div className="w-px h-4 bg-border/50 mx-1" />
            {semanticFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => setSemanticFilter(f.key)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  semanticFilter === f.key
                    ? f.accent ? `text-foreground` : 'bg-foreground/15 text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
                style={semanticFilter === f.key && f.accent ? { backgroundColor: `${f.accent}30`, color: f.accent } : undefined}
              >
                {f.key === 'all' ? f.label : `${f.label} ${f.count}`}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0 relative">
            <input
              type="text"
              placeholder="Search events..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full text-xs bg-muted/50 border border-border rounded px-2 py-1 pr-6 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          {selectedEvent && (
            <div className="flex items-center gap-1 shrink-0">
              <div className="flex text-[10px] bg-muted/50 rounded overflow-hidden">
                <button onClick={() => setViewMode('timeline')} className={`px-2 py-0.5 transition-colors ${viewMode === 'timeline' ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground'}`}>Pretty</button>
                <button onClick={() => setViewMode('raw')} className={`px-2 py-0.5 transition-colors ${viewMode === 'raw' ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground'}`}>Raw JSON</button>
              </div>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleCopy}>Copy</Button>
            </div>
          )}
        </div>

        {/* Navigation pills */}
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border/50 shrink-0">
          <span className="text-[10px] text-muted-foreground/60 mr-1">Jump:</span>
          {navPills.map((pill) => (
            <div key={pill.key} className="flex items-center gap-0.5">
              <button
                onClick={() => navigateTo(pill.key, 'prev')}
                className="text-muted-foreground/50 hover:text-foreground p-0.5 transition-colors"
                title={`Previous ${pill.label}`}
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 15l7-7 7 7" /></svg>
              </button>
              <span
                className="text-[9px] font-medium px-1.5 py-0.5 rounded min-w-[3rem] text-center"
                style={{ backgroundColor: `${pill.accent}20`, color: pill.accent }}
              >
                {pill.label} {pill.count}
              </span>
              <button
                onClick={() => navigateTo(pill.key, 'next')}
                className="text-muted-foreground/50 hover:text-foreground p-0.5 transition-colors"
                title={`Next ${pill.label}`}
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" /></svg>
              </button>
            </div>
          ))}
        </div>

        {/* Content — resizable split (mr-2 keeps scrollbar away from dialog edge resize handle) */}
        <div ref={splitContainerRef} className="flex flex-1 overflow-hidden relative mx-2">
          {/* Event list (virtual scroll) */}
          <div ref={virtualScroll.setContainerRef} className="overflow-y-auto bg-black/20" style={{ width: splitPos }}>
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <span className="text-xs text-muted-foreground">Loading events...</span>
              </div>
            )}
            {error && (
              <div className="m-3 px-2 py-1.5 rounded bg-destructive/10 text-destructive text-xs">{error}</div>
            )}
            {!isLoading && !error && (
              <div style={{ height: virtualScroll.totalHeight, position: 'relative' }}>
                {filteredEvents.slice(virtualScroll.startIndex, virtualScroll.endIndex + 1).map(({ event, semantic }, i) => (
                  <div
                    key={event.index}
                    style={{
                      position: 'absolute',
                      top: (virtualScroll.startIndex + i) * ROW_HEIGHT,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                    }}
                  >
                    <EventRow
                      event={event}
                      isSelected={selectedIndex === event.index}
                      onClick={() => setSelectedIndex(event.index)}
                      rowIndex={virtualScroll.startIndex + i}
                      searchQuery={debouncedSearch}
                      semanticType={semantic}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Split handle — z-30 to sit above dialog edge resize handles */}
          <div onMouseDown={handleSplitStart} className="w-1.5 shrink-0 cursor-col-resize hover:bg-ring/50 active:bg-ring/70 transition-colors z-30 relative" />

          {/* Detail panel */}
          <div className="flex-1 overflow-y-auto p-4">
            {!selectedEvent ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-xs text-muted-foreground">Select an event to inspect</span>
              </div>
            ) : viewMode === 'raw' ? (
              selectedRawJson ? (
                <PrettyJson json={selectedRawJson} query={debouncedSearch} />
              ) : (
                <div className="flex items-center justify-center py-8">
                  <span className="text-xs text-muted-foreground">Loading raw JSON...</span>
                </div>
              )
            ) : (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${getEventConfig(selectedEvent).color}`}>
                    {getEventConfig(selectedEvent).label}
                  </span>
                  {selectedEvent.timestamp && (
                    <span className="text-xs text-muted-foreground">
                      {new Date(selectedEvent.timestamp).toLocaleString()}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground/50">#{selectedEvent.index}</span>
                </div>
                {selectedEvent.contentPreview ? (
                  <div className="text-sm text-foreground/80 leading-relaxed">
                    {debouncedSearch.trim() && (
                      <div className="text-xs bg-muted/30 rounded-lg p-3 mb-3 whitespace-pre-wrap break-words">
                        <HighlightText text={selectedEvent.contentPreview} query={debouncedSearch} />
                      </div>
                    )}
                    <Markdown>{prepareContentForPretty(selectedEvent.contentPreview)}</Markdown>
                  </div>
                ) : selectedRawJson ? (
                  <PrettyJson json={selectedRawJson} query={debouncedSearch} />
                ) : (
                  <div className="flex items-center justify-center py-8">
                    <span className="text-xs text-muted-foreground">Loading...</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
