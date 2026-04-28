import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { ProjectMemory, MemoryFile } from '../types/session';
import { Markdown } from './Markdown';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface MemoryInspectorProps {
  open: boolean;
  onClose: () => void;
  projectDirName: string;
  projectName: string;
  accentColor?: string;
}

type FilterType = 'all' | 'index' | 'feedback' | 'user' | 'project' | 'reference';
type ViewMode = 'pretty' | 'raw';

const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  user: { label: 'User', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  feedback: { label: 'Feedback', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  project: { label: 'Project', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  reference: { label: 'Reference', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  index: { label: 'Index', color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
};

function getFileType(file: MemoryFile): string {
  if (file.filename === 'MEMORY.md') return 'index';
  return file.memoryType ?? 'unknown';
}

function getTypeConfig(file: MemoryFile) {
  const type = getFileType(file);
  return TYPE_CONFIG[type] ?? null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
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

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const MemoryRow = memo(function MemoryRow({
  file,
  isSelected,
  onClick,
  searchQuery,
}: {
  file: MemoryFile;
  isSelected: boolean;
  onClick: () => void;
  searchQuery: string;
}) {
  const config = getTypeConfig(file);
  const displayName = file.name || file.filename;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 border-b border-border/10 transition-colors ${
        isSelected ? 'bg-muted/50' : 'hover:bg-muted/20'
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        {config && (
          <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${config.color}`}>
            {config.label}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          {formatSize(file.sizeBytes)}
        </span>
      </div>
      <div className="text-xs font-medium text-foreground truncate">
        {searchQuery ? <HighlightText text={displayName} query={searchQuery} /> : displayName}
      </div>
      {file.description && (
        <div className="text-[10px] text-muted-foreground/70 line-clamp-1 mt-0.5">
          {searchQuery ? <HighlightText text={file.description} query={searchQuery} /> : file.description}
        </div>
      )}
    </button>
  );
});

export function MemoryInspector({ open, onClose, projectDirName, projectName, accentColor }: MemoryInspectorProps) {
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('pretty');
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery, 200);

  // Dialog drag/resize
  const [dialogSize, setDialogSize] = useState({ width: 900, height: 600 });
  const [dialogPos, setDialogPos] = useState<{ x: number; y: number } | null>(null);
  const [isResizingDialog, setIsResizingDialog] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const interactionStart = useRef({ mx: 0, my: 0, w: 0, h: 0, px: 0, py: 0 });

  // Split pane
  const [splitPos, setSplitPos] = useState(320);
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setDialogPos(null);
  }, [open]);

  const loadMemory = useCallback(() => {
    setIsLoading(true);
    setError(null);
    invoke<ProjectMemory>('get_project_memory', { projectDirName })
      .then((m) => {
        setMemory(m);
        if (m.files.length > 0 && selectedFilename === null) {
          setSelectedFilename(m.files[0].filename);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setIsLoading(false));
  }, [projectDirName, selectedFilename]);

  useEffect(() => {
    if (!open) return;
    setSelectedFilename(null);
    setSearchQuery('');
    setFilter('all');
    setViewMode('pretty');
    setIsLoading(true);
    invoke<ProjectMemory>('get_project_memory', { projectDirName })
      .then((m) => {
        setMemory(m);
        if (m.files.length > 0) setSelectedFilename(m.files[0].filename);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setIsLoading(false));
  }, [open, projectDirName]);

  // Drag header
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    e.preventDefault();
    setIsDragging(true);
    const rect = dialogRef.current?.getBoundingClientRect();
    if (rect) {
      interactionStart.current = { mx: e.clientX, my: e.clientY, w: 0, h: 0, px: rect.left, py: rect.top };
      if (!dialogPos) setDialogPos({ x: rect.left, y: rect.top });
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

  // Resize edges
  const handleDialogResizeStart = useCallback((e: React.MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingDialog(edge);
    const rect = dialogRef.current?.getBoundingClientRect();
    interactionStart.current = { mx: e.clientX, my: e.clientY, w: dialogSize.width, h: dialogSize.height, px: rect?.left ?? 0, py: rect?.top ?? 0 };
    if (!dialogPos && rect) setDialogPos({ x: rect.left, y: rect.top });
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

  // Split pane
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

  // Pre-compute searchable lowercase
  const searchableFiles = useMemo(() =>
    (memory?.files ?? []).map((f) => ({
      file: f,
      lowerName: (f.name ?? '').toLowerCase(),
      lowerDesc: (f.description ?? '').toLowerCase(),
      lowerFilename: f.filename.toLowerCase(),
      lowerContent: f.content.toLowerCase(),
    })),
    [memory]
  );

  const filteredFiles = useMemo(() => {
    let result = searchableFiles;

    // Type filter
    if (filter !== 'all') {
      result = result.filter(({ file }) => getFileType(file) === filter);
    }

    // Search filter
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter(({ lowerName, lowerDesc, lowerFilename, lowerContent }) =>
        lowerName.includes(q) || lowerDesc.includes(q) || lowerFilename.includes(q) || lowerContent.includes(q)
      );
    }

    return result.map(({ file }) => file);
  }, [searchableFiles, filter, debouncedSearch]);

  // Type counts
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { index: 0, feedback: 0, user: 0, project: 0, reference: 0 };
    for (const f of memory?.files ?? []) {
      const t = getFileType(f);
      if (t in counts) counts[t]++;
    }
    return counts;
  }, [memory]);

  const selectedFile = filteredFiles.find((f) => f.filename === selectedFilename) ?? memory?.files.find((f) => f.filename === selectedFilename) ?? null;

  // Auto-select first filtered file if current selection isn't in the filtered list
  useEffect(() => {
    if (filteredFiles.length === 0) return;
    if (!selectedFilename || !filteredFiles.find((f) => f.filename === selectedFilename)) {
      setSelectedFilename(filteredFiles[0].filename);
    }
  }, [filteredFiles, selectedFilename]);

  const handleDelete = useCallback(async (filename: string) => {
    try {
      await invoke('delete_memory_file', { projectDirName, filename });
      if (selectedFilename === filename) setSelectedFilename(null);
      setConfirmDelete(null);
      loadMemory();
    } catch (e) {
      setError(String(e));
    }
  }, [projectDirName, selectedFilename, loadMemory]);

  const handleCopy = useCallback(() => {
    if (!selectedFile) return;
    if (viewMode === 'raw') {
      navigator.clipboard.writeText(selectedFile.content);
    } else {
      // Pretty mode: copy the body without frontmatter
      const content = selectedFile.content;
      if (content.startsWith('---')) {
        const closeIdx = content.slice(3).indexOf('\n---');
        if (closeIdx !== -1) {
          navigator.clipboard.writeText(content.slice(closeIdx + 7).trimStart());
          return;
        }
      }
      navigator.clipboard.writeText(content);
    }
  }, [selectedFile, viewMode]);

  const filters: { key: FilterType; label: string; count?: number }[] = [
    { key: 'all', label: 'All' },
    { key: 'index', label: 'Index', count: typeCounts.index },
    { key: 'feedback', label: 'Feedback', count: typeCounts.feedback },
    { key: 'user', label: 'User', count: typeCounts.user },
    { key: 'project', label: 'Project', count: typeCounts.project },
    { key: 'reference', label: 'Reference', count: typeCounts.reference },
  ];

  if (!open) return null;

  const dialogStyle: React.CSSProperties = dialogPos
    ? { position: 'fixed', left: dialogPos.x, top: dialogPos.y, width: dialogSize.width, height: dialogSize.height, transform: 'none', maxWidth: '100vw', maxHeight: '100vh' }
    : { width: dialogSize.width, height: dialogSize.height, maxWidth: '95vw', maxHeight: '95vh' };

  // Parse frontmatter into key-value pairs (preserving order) and extract body
  let prettyContent = selectedFile?.content ?? '';
  const frontmatterPairs: { key: string; value: string }[] = [];
  if (prettyContent.startsWith('---')) {
    const closeIdx = prettyContent.slice(3).indexOf('\n---');
    if (closeIdx !== -1) {
      const fm = prettyContent.slice(3, closeIdx + 3);
      for (const line of fm.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key) frontmatterPairs.push({ key, value });
      }
      prettyContent = prettyContent.slice(closeIdx + 7).trimStart();
    }
  }

  // Format a frontmatter key as a readable label: "originSessionId" -> "Origin Session Id"
  function formatKey(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (s) => s.toUpperCase())
      .trim();
  }

  const panel = (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={dialogRef}
        className={`${dialogPos ? '' : 'relative'} bg-popover border border-border rounded-lg shadow-2xl flex flex-col overflow-hidden z-50`}
        style={dialogStyle}
      >
        {/* Resize handles */}
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
            Memory — {projectName}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {filteredFiles.length}{filteredFiles.length !== (memory?.files.length ?? 0) ? ` / ${memory?.files.length}` : ''} files
            </span>
            <button onClick={loadMemory} className="text-muted-foreground hover:text-foreground transition-colors" title="Refresh">
              <svg className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors" title="Close">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Toolbar: filters + search + view toggle */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0 gap-2" style={{ backgroundColor: 'rgba(255, 255, 255, 0.04)' }}>
          <div className="flex gap-1 shrink-0 items-center flex-wrap">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  filter === f.key ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                {f.key === 'all' ? f.label : `${f.label} ${f.count ?? 0}`}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0 relative">
            <input
              type="text"
              placeholder="Search memory..."
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
          {selectedFile && (
            <div className="flex items-center gap-1 shrink-0">
              <div className="flex text-[10px] bg-muted/50 rounded overflow-hidden">
                <button
                  onClick={() => setViewMode('pretty')}
                  className={`px-2 py-0.5 transition-colors ${viewMode === 'pretty' ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground'}`}
                >
                  Pretty
                </button>
                <button
                  onClick={() => setViewMode('raw')}
                  className={`px-2 py-0.5 transition-colors ${viewMode === 'raw' ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground'}`}
                >
                  Raw
                </button>
              </div>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleCopy}>Copy</Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmDelete(selectedFile.filename)}
              >
                Delete
              </Button>
            </div>
          )}
        </div>

        {/* Content */}
        <div ref={splitContainerRef} className="flex flex-1 overflow-hidden relative mx-2">
          {/* File list */}
          <div className="overflow-y-auto bg-black/20" style={{ width: splitPos }}>
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <span className="text-xs text-muted-foreground">Loading memory...</span>
              </div>
            )}
            {error && (
              <div className="m-3 px-2 py-1.5 rounded bg-destructive/10 text-destructive text-xs">{error}</div>
            )}
            {!isLoading && !error && filteredFiles.length === 0 && (
              <div className="flex items-center justify-center py-12 px-4 text-center">
                <span className="text-xs text-muted-foreground">
                  {(memory?.files.length ?? 0) === 0 ? 'No memory files' : 'No matches'}
                </span>
              </div>
            )}
            {!isLoading && !error && filteredFiles.map((file) => (
              <MemoryRow
                key={file.filename}
                file={file}
                isSelected={selectedFilename === file.filename}
                onClick={() => setSelectedFilename(file.filename)}
                searchQuery={debouncedSearch}
              />
            ))}
          </div>

          {/* Split handle */}
          <div onMouseDown={handleSplitStart} className="w-1.5 shrink-0 cursor-col-resize hover:bg-ring/50 active:bg-ring/70 transition-colors z-30 relative" />

          {/* Detail panel */}
          <div className="flex-1 overflow-y-auto p-4">
            {!selectedFile ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-xs text-muted-foreground">Select a file to inspect</span>
              </div>
            ) : (
              <div>
                {/* Metadata */}
                <div className="flex items-center gap-2 mb-3 pb-3 border-b border-border/50">
                  {(() => {
                    const cfg = getTypeConfig(selectedFile);
                    return cfg ? (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${cfg.color}`}>
                        {cfg.label}
                      </span>
                    ) : null;
                  })()}
                  <code className="text-xs text-muted-foreground truncate">{selectedFile.filename}</code>
                  <span className="text-[10px] text-muted-foreground/50 ml-auto">{formatSize(selectedFile.sizeBytes)}</span>
                </div>

                {viewMode === 'raw' ? (
                  <pre className="text-xs bg-muted/30 rounded-lg p-3 overflow-auto whitespace-pre-wrap break-words font-mono text-foreground/80">
                    {debouncedSearch ? <HighlightText text={selectedFile.content} query={debouncedSearch} /> : selectedFile.content}
                  </pre>
                ) : (
                  <>
                    {/* Frontmatter metadata block (all fields) */}
                    {frontmatterPairs.length > 0 && (
                      <div className="mb-4 bg-muted/20 border border-border/40 rounded-lg p-3">
                        <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
                          {frontmatterPairs.map(({ key, value }, i) => (
                            <div key={i} className="contents">
                              <div className="text-muted-foreground font-medium">{formatKey(key)}</div>
                              <div className="text-foreground/90 break-words">
                                {key === 'name' ? (
                                  <span className="font-semibold">
                                    {debouncedSearch ? <HighlightText text={value} query={debouncedSearch} /> : value}
                                  </span>
                                ) : key === 'description' ? (
                                  <span className="italic">
                                    {debouncedSearch ? <HighlightText text={value} query={debouncedSearch} /> : value}
                                  </span>
                                ) : key.toLowerCase().includes('id') || key.toLowerCase().includes('uuid') ? (
                                  <code className="text-[11px] text-muted-foreground/80">{value}</code>
                                ) : (
                                  debouncedSearch ? <HighlightText text={value} query={debouncedSearch} /> : value
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Search match preview */}
                    {debouncedSearch.trim() && (
                      <div className="text-xs bg-muted/30 rounded-lg p-3 mb-3 whitespace-pre-wrap break-words">
                        <HighlightText text={prettyContent} query={debouncedSearch} />
                      </div>
                    )}

                    {/* Rendered markdown body */}
                    <div className="text-sm text-foreground/80 leading-relaxed">
                      <Markdown>{prettyContent}</Markdown>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Delete confirmation */}
        <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
          <DialogContent onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle>Delete memory file?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground py-2">
              Are you sure you want to delete <code className="text-foreground">{confirmDelete}</code>? This will permanently remove the file from disk.
            </p>
            <DialogFooter className="flex gap-2">
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => confirmDelete && handleDelete(confirmDelete)}>Yes, delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

export default MemoryInspector;
