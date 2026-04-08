export type SessionStatus = 'waiting' | 'processing' | 'thinking' | 'compacting' | 'idle';

export type AgentType = 'claude' | 'opencode';

export interface Session {
  id: string;
  agentType: AgentType;
  projectName: string;
  projectPath: string;
  gitBranch: string | null;
  githubUrl: string | null;
  status: SessionStatus;
  lastMessage: string | null;
  lastMessageRole: 'user' | 'assistant' | null;
  lastActivityAt: string;
  pid: number;
  cpuUsage: number;
  activeSubagentCount: number;
}

export interface SessionsResponse {
  sessions: Session[];
  totalCount: number;
  waitingCount: number;
}

export interface MessagePreview {
  text: string;
  role: string;
}

export interface SubagentInfo {
  agentId: string;
  slug: string | null;
  taskDescription: string | null;
  timestamp: string | null;
  eventCount: number;
}

export interface HistorySession {
  sessionId: string;
  cwd: string;
  lastActivityAt: string;
  gitBranch: string | null;
  recentMessages: MessagePreview[];
  subagents: SubagentInfo[];
}

export interface ProjectHistory {
  projectPath: string;
  projectName: string;
  projectDirName: string;
  sessions: HistorySession[];
}

export interface SessionHistoryResponse {
  projects: ProjectHistory[];
}

export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
}

export interface UsageResponse {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDayOpus: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  extraUsage: ExtraUsage | null;
  fetchedAt: string;
  error: string | null;
}

export interface SessionEvent {
  index: number;
  timestamp: string | null;
  eventType: string;
  role: string | null;
  toolName: string | null;
  contentPreview: string | null;
}
