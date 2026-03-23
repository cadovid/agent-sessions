import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SessionHistoryResponse } from '../types/session';

export function useSessionHistory() {
  const [history, setHistory] = useState<SessionHistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await invoke<SessionHistoryResponse>('get_session_history');
      setHistory(response);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch session history');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resumeSession = useCallback(async (sessionId: string, cwd: string) => {
    try {
      setResumeError(null);
      await invoke('resume_session', { sessionId, projectPath: cwd });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resume session';
      setResumeError(message);
      setTimeout(() => setResumeError(null), 5000);
    }
  }, []);

  const deleteSession = useCallback(async (sessionId: string, projectDirName: string) => {
    try {
      await invoke('delete_history_session', { sessionId, projectDirName });
      await fetchHistory();
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  }, [fetchHistory]);

  // Load once on mount
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return {
    history,
    isLoading,
    error,
    resumeError,
    refresh: fetchHistory,
    resumeSession,
    deleteSession,
  };
}
