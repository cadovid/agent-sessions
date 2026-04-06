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

export interface HistorySession {
  sessionId: string;
  cwd: string;
  lastActivityAt: string;
  gitBranch: string | null;
  recentMessages: MessagePreview[];
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
