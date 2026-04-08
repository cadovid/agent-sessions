import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { UsageResponse } from '../types/session';

const POLL_INTERVAL = 15 * 60 * 1000; // 15 minutes

export function useUsage() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await invoke<UsageResponse>('fetch_usage');
      setUsage(response);
      // Update tray icon with usage-colored dot
      await invoke('update_tray_icon').catch(console.error);
    } catch (err) {
      console.error('Failed to fetch usage:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load: try cache first, then fetch
  useEffect(() => {
    invoke<UsageResponse | null>('get_cached_usage').then((cached) => {
      if (cached) setUsage(cached);
    });
    refresh();
  }, [refresh]);

  // Poll every 15 minutes
  useEffect(() => {
    const interval = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [refresh]);

  return { usage, isLoading, refresh };
}
