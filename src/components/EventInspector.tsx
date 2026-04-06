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
}

const EVENT_TYPE_CONFIG: Record<string, { label: string; color: string; accent: string }> = {
  human: { label: 'User', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', accent: '#3b82f6' },
  assistant: { label: 'Assistant', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', accent: '#10b981' },
  tool_use: { label: 'Tool Call', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30', accent: '#a855f7' },
  tool_result: { label: 'Tool Result', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30', accent: '#f59e0b' },
  system: { label: 'System', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30', accent: '#6b7280' },
  unknown: { label: 'Event', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30', accent: '#6b7280' },
};

function getEventConfig(event: SessionEvent) {
  if (event.role === 'user' || event.role === 'human') return EVENT_TYPE_CONFIG.human;
  if (event.role === 'assistant') return EVENT_TYPE_CONFIG.assistant;
  if (event.eventType === 'tool_use') return EVENT_TYPE_CONFIG.tool_use;
  if (event.eventType === 'tool_result') return EVENT_TYPE_CONFIG.tool_result;
  return EVENT_TYPE_CONFIG[event.eventType] ?? EVENT_TYPE_CONFIG.unknown;
}

function getEventTypeKey(event: SessionEvent): string {
  if (event.role === 'user' || event.role === 'human') return 'user';
  if (event.role === 'assistant') return 'assistant';
  if (event.eventType === 'tool_use' || event.eventType === 'tool_result') return 'tool';
  return 'system';
}

type FilterType = 'all' | 'user' | 'assistant' | 'tool' | 'system';
type ViewMode = 'timeline' | 'raw';

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

const EventRow = memo(function EventRow({
  event,
  isSelected,
  onClick,
  rowIndex,
  searchQuery,
}: {
  event: SessionEvent;
  isSelected: boolean;
  onClick: () => void;
  rowIndex: number;
  searchQuery: string;
}) {
  const config = getEventConfig(event);
  const zebra = rowIndex % 2 === 1 ? 'bg-white/[0.02]' : '';
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

export function EventInspector({ open, onClose, sessionId, projectDirName, sessionLabel, accentColor, isLive }: EventInspectorProps) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery, 200);

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

  // Event list scroll ref for navigation
  const eventListRef = useRef<HTMLDivElement>(null);

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

  // Load events
  const loadEvents = useCallback(() => {
    return invoke<SessionEvent[]>('get_session_events', { sessionId, projectDirName })
      .then(setEvents)
      .catch((e) => setError(String(e)));
  }, [sessionId, projectDirName]);

  useEffect(() => {
    if (!open) return;
    setIsLoading(true);
    setError(null);
    setSelectedIndex(null);
    setSearchQuery('');
    loadEvents().finally(() => setIsLoading(false));
  }, [open, sessionId, projectDirName, loadEvents]);

  // Live refresh (every 3 seconds for active sessions)
  useEffect(() => {
    if (!open || !isLive) return;
    const interval = setInterval(() => {
      loadEvents();
    }, 3000);
    return () => clearInterval(interval);
  }, [open, isLive, loadEvents]);

  // Pre-compute search data
  const searchableEvents = useMemo(() =>
    events.map((e) => ({
      event: e,
      lowerPreview: e.contentPreview?.toLowerCase() ?? '',
      lowerRaw: e.rawJson.toLowerCase(),
    })),
    [events]
  );

  const filteredEvents = useMemo(() => {
    let result = searchableEvents;
    if (filter !== 'all') {
      result = result.filter(({ event: e }) => {
        switch (filter) {
          case 'user': return e.role === 'user' || e.role === 'human';
          case 'assistant': return e.role === 'assistant';
          case 'tool': return e.eventType === 'tool_use' || e.eventType === 'tool_result';
          case 'system': return !e.role && e.eventType !== 'tool_use' && e.eventType !== 'tool_result';
          default: return true;
        }
      });
    }
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter(({ lowerPreview, lowerRaw }) => lowerPreview.includes(q) || lowerRaw.includes(q));
    }
    return result.map(({ event }) => event).reverse();
  }, [searchableEvents, filter, debouncedSearch]);

  // Navigation: counts per type
  const typeCounts = useMemo(() => {
    const counts = { user: 0, assistant: 0, tool: 0, system: 0 };
    for (const e of filteredEvents) {
      const key = getEventTypeKey(e);
      if (key in counts) counts[key as keyof typeof counts]++;
    }
    return counts;
  }, [filteredEvents]);

  // Navigate to next/prev event of a given type
  const navigateTo = useCallback((typeKey: string, direction: 'next' | 'prev') => {
    const currentPos = selectedIndex !== null
      ? filteredEvents.findIndex((e) => e.index === selectedIndex)
      : -1;

    const candidates = filteredEvents
      .map((e, i) => ({ event: e, pos: i }))
      .filter(({ event }) => getEventTypeKey(event) === typeKey);

    if (candidates.length === 0) return;

    let target: typeof candidates[0];
    if (direction === 'next') {
      target = candidates.find((c) => c.pos > currentPos) ?? candidates[0];
    } else {
      target = [...candidates].reverse().find((c) => c.pos < currentPos) ?? candidates[candidates.length - 1];
    }

    setSelectedIndex(target.event.index);

    // Scroll the event into view
    requestAnimationFrame(() => {
      const el = eventListRef.current?.querySelector(`[data-event-index="${target.event.index}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [filteredEvents, selectedIndex]);

  const selectedEvent = selectedIndex !== null ? events.find((e) => e.index === selectedIndex) : null;

  const handleCopy = useCallback(() => {
    if (!selectedEvent) return;
    if (viewMode === 'raw') {
      try {
        navigator.clipboard.writeText(JSON.stringify(JSON.parse(selectedEvent.rawJson), null, 2));
      } catch {
        navigator.clipboard.writeText(selectedEvent.rawJson);
      }
    } else {
      navigator.clipboard.writeText(selectedEvent.contentPreview || selectedEvent.rawJson);
    }
  }, [selectedEvent, viewMode]);

  const typeFilters: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'user', label: 'User' },
    { key: 'assistant', label: 'Assistant' },
    { key: 'tool', label: 'Tools' },
    { key: 'system', label: 'System' },
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
        {/* Resize handles */}
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'e')} className="absolute top-0 right-0 w-1.5 h-full cursor-ew-resize z-50" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'w')} className="absolute top-0 left-0 w-1.5 h-full cursor-ew-resize z-50" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 's')} className="absolute bottom-0 left-0 h-1.5 w-full cursor-ns-resize z-50" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'n')} className="absolute top-0 left-0 h-1.5 w-full cursor-ns-resize z-50" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'se')} className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-50" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'sw')} className="absolute bottom-0 left-0 w-4 h-4 cursor-nesw-resize z-50" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'ne')} className="absolute top-0 right-0 w-4 h-4 cursor-nesw-resize z-50" />
        <div onMouseDown={(e) => handleDialogResizeStart(e, 'nw')} className="absolute top-0 left-0 w-4 h-4 cursor-nwse-resize z-50" />

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
          <div className="flex gap-1 shrink-0">
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

        {/* Content — resizable split */}
        <div ref={splitContainerRef} className="flex flex-1 overflow-hidden relative">
          {/* Event list */}
          <div ref={eventListRef} className="overflow-y-auto bg-black/20" style={{ width: splitPos }}>
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <span className="text-xs text-muted-foreground">Loading events...</span>
              </div>
            )}
            {error && (
              <div className="m-3 px-2 py-1.5 rounded bg-destructive/10 text-destructive text-xs">{error}</div>
            )}
            {!isLoading && !error && filteredEvents.map((event, i) => (
              <EventRow
                key={event.index}
                event={event}
                isSelected={selectedIndex === event.index}
                onClick={() => setSelectedIndex(event.index)}
                rowIndex={i}
                searchQuery={debouncedSearch}
              />
            ))}
          </div>

          {/* Split handle */}
          <div onMouseDown={handleSplitStart} className="w-1 shrink-0 cursor-col-resize hover:bg-ring/50 active:bg-ring/70 transition-colors" />

          {/* Detail panel */}
          <div className="flex-1 overflow-y-auto p-4">
            {!selectedEvent ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-xs text-muted-foreground">Select an event to inspect</span>
              </div>
            ) : viewMode === 'raw' ? (
              <PrettyJson json={selectedEvent.rawJson} query={debouncedSearch} />
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
                    <Markdown>{selectedEvent.contentPreview}</Markdown>
                  </div>
                ) : (
                  <PrettyJson json={selectedEvent.rawJson} query={debouncedSearch} />
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
