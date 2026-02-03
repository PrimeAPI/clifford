'use client';

import { useCallback, useEffect, useState } from 'react';

export interface QueueJob {
  id: string;
  name: string;
  data?: unknown;
  failedReason?: string;
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
  result?: unknown;
  detail?: string;
  meta?: Record<string, unknown>;
}

export interface QueueStatus {
  queues: {
    runs: {
      counts: Record<string, number>;
      active: QueueJob[];
      waiting: QueueJob[];
      completed: QueueJob[];
      failed: QueueJob[];
    };
    messages: {
      counts: Record<string, number>;
      active: QueueJob[];
      waiting: QueueJob[];
      completed: QueueJob[];
      failed: QueueJob[];
    };
    deliveries: {
      counts: Record<string, number>;
      active: QueueJob[];
      waiting: QueueJob[];
      completed: QueueJob[];
      failed: QueueJob[];
    };
    memoryWrites: {
      counts: Record<string, number>;
      active: QueueJob[];
      waiting: QueueJob[];
      completed: QueueJob[];
      failed: QueueJob[];
    };
  };
}

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';
const REFRESH_INTERVAL_MS = 5000;

export function useQueueStatus() {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const loadQueueStatus = useCallback(async () => {
    setLoadingQueue(true);
    try {
      const res = await fetch('/api/queue/status', {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = (await res.json()) as QueueStatus;
      setQueueStatus(data);
    } catch (err) {
      console.error('Failed to load queue status:', err);
    } finally {
      setLoadingQueue(false);
    }
  }, []);

  useEffect(() => {
    loadQueueStatus();
    const interval = setInterval(loadQueueStatus, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadQueueStatus]);

  return { queueStatus, loadingQueue, loadQueueStatus };
}
