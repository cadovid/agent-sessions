import { UsageResponse } from '../types/session';

interface UsageStripProps {
  usage: UsageResponse | null;
  isLoading: boolean;
  onRefresh: () => void;
}

function getBarColor(utilization: number): string {
  if (utilization >= 90) return 'bg-red-500';
  if (utilization >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const d = new Date(resetsAt);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  const diffH = Math.floor(diffMs / 3600000);
  const diffM = Math.floor((diffMs % 3600000) / 60000);
  if (diffH > 24) return `${Math.floor(diffH / 24)}d`;
  if (diffH > 0) return `${diffH}h${diffM}m`;
  return `${diffM}m`;
}

function UsageMeter({ label, utilization, resetsAt }: { label: string; utilization: number; resetsAt: string | null }) {
  const barColor = getBarColor(utilization);
  const resetText = formatResetTime(resetsAt);

  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${utilization.toFixed(0)}% used${resetText ? `, resets in ${resetText}` : ''}`}>
      <span className="text-[10px] text-muted-foreground font-medium">{label}</span>
      <div className="w-14 h-1.5 bg-muted/50 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all duration-500`} style={{ width: `${utilization}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground">{utilization.toFixed(0)}%</span>
      {resetText && (
        <span className="text-[9px] text-muted-foreground/50">{resetText}</span>
      )}
    </div>
  );
}

export function UsageStrip({ usage, isLoading, onRefresh }: UsageStripProps) {
  if (!usage) {
    return null;
  }

  if (usage.error) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground/50" title={usage.error}>Usage unavailable</span>
        <button
          onClick={onRefresh}
          className="text-muted-foreground/40 hover:text-foreground transition-colors"
          title="Refresh usage"
        >
          <svg className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {usage.fiveHour && (
        <UsageMeter label="5h" utilization={usage.fiveHour.utilization} resetsAt={usage.fiveHour.resetsAt} />
      )}
      {usage.sevenDay && (
        <UsageMeter label="7d" utilization={usage.sevenDay.utilization} resetsAt={usage.sevenDay.resetsAt} />
      )}
      {usage.sevenDayOpus && (
        <UsageMeter label="Opus" utilization={usage.sevenDayOpus.utilization} resetsAt={usage.sevenDayOpus.resetsAt} />
      )}
      {usage.sevenDaySonnet && (
        <UsageMeter label="Sonnet" utilization={usage.sevenDaySonnet.utilization} resetsAt={usage.sevenDaySonnet.resetsAt} />
      )}
      <button
        onClick={onRefresh}
        className="text-muted-foreground/40 hover:text-foreground transition-colors"
        title="Refresh usage"
      >
        <svg className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
  );
}
