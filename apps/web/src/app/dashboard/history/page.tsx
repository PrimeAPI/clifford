'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useQueueStatus, type QueueJob } from '../queue/use-queue-status';

type RunRecord = {
  id: string;
  agentId: string;
  agentName?: string | null;
  inputText: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  wakeAt?: string | null;
  wakeReason?: string | null;
};

type HistoryTask = {
  id: string;
  queue: string;
  status: string;
  name: string;
  timestamp?: number;
  detail?: string;
  data?: unknown;
  meta?: Record<string, unknown>;
  failedReason?: string;
  result?: unknown;
  kind: 'run' | 'queue';
};

const DEMO_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const RUN_LIMIT = 50;
const queueFilterOptions = ['all', 'runs', 'messages', 'deliveries', 'memorywrites'] as const;

const getTaskTime = (job: QueueJob) => job.finishedOn ?? job.processedOn ?? job.timestamp ?? 0;

const buildQueueTasks = (queueStatus: ReturnType<typeof useQueueStatus>['queueStatus']) => {
  if (!queueStatus) return [] as HistoryTask[];

  const buckets: Array<{ queue: string; status: string; jobs: QueueJob[] }> = [
    { queue: 'Messages', status: 'active', jobs: queueStatus.queues.messages.active },
    { queue: 'Messages', status: 'waiting', jobs: queueStatus.queues.messages.waiting },
    { queue: 'Messages', status: 'failed', jobs: queueStatus.queues.messages.failed },
    { queue: 'Messages', status: 'completed', jobs: queueStatus.queues.messages.completed },
    { queue: 'Deliveries', status: 'active', jobs: queueStatus.queues.deliveries.active },
    { queue: 'Deliveries', status: 'waiting', jobs: queueStatus.queues.deliveries.waiting },
    { queue: 'Deliveries', status: 'failed', jobs: queueStatus.queues.deliveries.failed },
    { queue: 'Deliveries', status: 'completed', jobs: queueStatus.queues.deliveries.completed },
    { queue: 'MemoryWrites', status: 'active', jobs: queueStatus.queues.memoryWrites.active },
    { queue: 'MemoryWrites', status: 'waiting', jobs: queueStatus.queues.memoryWrites.waiting },
    { queue: 'MemoryWrites', status: 'failed', jobs: queueStatus.queues.memoryWrites.failed },
    { queue: 'MemoryWrites', status: 'completed', jobs: queueStatus.queues.memoryWrites.completed },
  ];

  return buckets.flatMap(({ queue, status, jobs }) =>
    jobs.map((job) => ({
      id: job.id,
      queue,
      status,
      name: job.name,
      detail: job.detail,
      meta: job.meta,
      result: job.result,
      data: job.data,
      failedReason: job.failedReason,
      timestamp: getTaskTime(job),
      kind: 'queue',
    }))
  );
};

const buildRunTasks = (runs: RunRecord[]) =>
  runs.map((run) => ({
    id: run.id,
    queue: 'Runs',
    status: run.status,
    name: run.agentName ? run.agentName : `Agent ${run.agentId}`,
    detail: run.inputText,
    timestamp: new Date(run.updatedAt || run.createdAt).getTime(),
    kind: 'run',
  }));

const formatTimestamp = (timestamp?: number) => {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
};

const formatMetaLine = (meta?: Record<string, unknown>) => {
  if (!meta) return '';
  const channelName = meta.channelName as string | undefined;
  const channelId = meta.channelId as string | undefined;
  const contextName = meta.contextName as string | undefined;
  const contextId = meta.contextId as string | undefined;
  const source = meta.source as string | undefined;

  const parts: string[] = [];
  if (channelName || channelId) {
    parts.push(`Channel: ${channelName ?? channelId}`);
  }
  if (contextName || contextId) {
    parts.push(`Context: ${contextName ?? contextId}`);
  }
  if (source) {
    parts.push(`Source: ${source}`);
  }
  return parts.join(' • ');
};

export default function HistoryPage() {
  const { queueStatus, loadingQueue, loadQueueStatus } = useQueueStatus();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runsOffset, setRunsOffset] = useState(0);
  const [runsTotal, setRunsTotal] = useState(0);
  const [hasMoreRuns, setHasMoreRuns] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<{ run: RunRecord; steps: any[] } | null>(null);
  const [loadingRunDetails, setLoadingRunDetails] = useState(false);
  const [runDetailsError, setRunDetailsError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [queueFilter, setQueueFilter] = useState<(typeof queueFilterOptions)[number]>('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const loadRuns = useCallback(
    async (options?: { reset?: boolean }) => {
      const nextOffset = options?.reset ? 0 : runsOffset;
      setLoadingRuns(true);
      try {
        const res = await fetch(`/api/runs?limit=${RUN_LIMIT}&offset=${nextOffset}`, {
          headers: { 'X-Tenant-Id': DEMO_TENANT_ID },
        });
        if (!res.ok) {
          throw new Error('Failed to load runs');
        }
        const data = (await res.json()) as {
          runs: RunRecord[];
          total: number;
          limit: number;
          offset: number;
          hasMore: boolean;
        };
        setRuns((prev) => (options?.reset ? (data.runs ?? []) : [...prev, ...(data.runs ?? [])]));
        setRunsOffset(data.offset + (data.runs?.length ?? 0));
        setRunsTotal(data.total ?? 0);
        setHasMoreRuns(Boolean(data.hasMore));
      } catch (err) {
        console.error(err);
        if (options?.reset) {
          setRuns([]);
          setRunsOffset(0);
          setRunsTotal(0);
          setHasMoreRuns(false);
        }
      } finally {
        setLoadingRuns(false);
      }
    },
    [runsOffset]
  );

  const refreshAll = useCallback(() => {
    loadQueueStatus();
    loadRuns({ reset: true });
  }, [loadQueueStatus, loadRuns]);

  useEffect(() => {
    loadRuns({ reset: true });
  }, [loadRuns]);

  const tasks = useMemo(() => {
    const combined = [...buildRunTasks(runs), ...buildQueueTasks(queueStatus)];
    return combined.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }, [runs, queueStatus]);

  const statusOptions = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach((task) => set.add(task.status));
    return ['all', ...Array.from(set).sort()];
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return tasks.filter((task) => {
      if (queueFilter !== 'all' && task.queue.toLowerCase() !== queueFilter) return false;
      if (statusFilter !== 'all' && task.status !== statusFilter) return false;
      if (!query) return true;

      const metaText = task.meta ? formatMetaLine(task.meta) : '';
      const base =
        `${task.id} ${task.queue} ${task.status} ${task.name} ${task.detail ?? ''} ${metaText}`.toLowerCase();
      if (base.includes(query)) return true;
      if (task.data) {
        try {
          return JSON.stringify(task.data).toLowerCase().includes(query);
        } catch {
          return false;
        }
      }
      return false;
    });
  }, [tasks, queueFilter, statusFilter, searchQuery]);

  const isLoading = loadingQueue || loadingRuns;

  const openRunDetails = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setRunDetails(null);
    setRunDetailsError(null);
    setLoadingRunDetails(true);
    try {
      const res = await fetch(`/api/runs/${runId}`);
      if (!res.ok) {
        throw new Error('Failed to load run details');
      }
      const data = (await res.json()) as { run: RunRecord; steps: any[] };
      setRunDetails(data);
    } catch (err) {
      console.error(err);
      setRunDetailsError('Unable to load run details.');
    } finally {
      setLoadingRunDetails(false);
    }
  }, []);

  const closeRunDetails = useCallback(() => {
    setSelectedRunId(null);
    setRunDetails(null);
    setRunDetailsError(null);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">History</h1>
        <p className="text-muted-foreground">All recent tasks across queues and runs.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Recent Tasks</CardTitle>
              <CardDescription>Filter, search, and review the latest work items.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={isLoading}>
              <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-3 md:grid-cols-3">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by id, queue, status, or text"
            />
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={queueFilter}
              onChange={(e) =>
                setQueueFilter(e.target.value as (typeof queueFilterOptions)[number])
              }
            >
              {queueFilterOptions.map((option) => (
                <option key={option} value={option}>
                  {option === 'all'
                    ? 'All Queues'
                    : option === 'memorywrites'
                      ? 'Memory Writes'
                      : option[0].toUpperCase() + option.slice(1)}
                </option>
              ))}
            </select>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option === 'all' ? 'All Statuses' : option}
                </option>
              ))}
            </select>
          </div>

          {filteredTasks.length ? (
            <div className="space-y-3">
              {filteredTasks.map((task) => (
                <div
                  key={`${task.queue}-${task.status}-${task.id}`}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{task.id}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.queue} • {task.name}
                      </p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p className="font-medium capitalize">{task.status}</p>
                      <p>{formatTimestamp(task.timestamp)}</p>
                    </div>
                  </div>
                  {task.detail ? (
                    <p className="mt-2 text-xs text-muted-foreground">Input: {task.detail}</p>
                  ) : null}
                  {task.meta ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatMetaLine(task.meta)}
                    </p>
                  ) : null}
                  {task.failedReason ? (
                    <p className="mt-2 text-xs text-destructive">Error: {task.failedReason}</p>
                  ) : null}
                  {task.kind === 'queue' && (task as { result?: unknown }).result ? (
                    <div className="mt-2 space-y-1">
                      <p className="text-[11px] uppercase text-muted-foreground">Response</p>
                      <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                        {JSON.stringify((task as { result?: unknown }).result, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {task.data ? (
                    <div className="mt-2 space-y-1">
                      <p className="text-[11px] uppercase text-muted-foreground">Input</p>
                      <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                        {JSON.stringify(task.data, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {task.kind === 'run' ? (
                    <div className="mt-3">
                      <Button variant="outline" size="sm" onClick={() => openRunDetails(task.id)}>
                        View Run Details
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm font-medium">
                {isLoading ? 'Loading tasks…' : 'No tasks match your filters'}
              </p>
              <p className="text-xs text-muted-foreground">
                Try clearing filters or wait for new queue activity.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
            <p>
              Showing {runs.length} of {runsTotal} runs.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadRuns()}
              disabled={!hasMoreRuns || loadingRuns}
            >
              {loadingRuns ? 'Loading…' : hasMoreRuns ? 'Load More Runs' : 'No More Runs'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {selectedRunId ? (
        <div className="fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40" onClick={closeRunDetails} />
          <div className="relative ml-auto h-full w-full max-w-xl bg-background shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <p className="text-sm text-muted-foreground">Run Details</p>
                <h2 className="text-lg font-semibold">{selectedRunId}</h2>
              </div>
              <Button variant="outline" size="sm" onClick={closeRunDetails}>
                Close
              </Button>
            </div>
            <div className="h-[calc(100%-72px)] overflow-y-auto px-6 py-4 text-sm">
              {loadingRunDetails ? (
                <p className="text-muted-foreground">Loading run details…</p>
              ) : runDetailsError ? (
                <p className="text-destructive">{runDetailsError}</p>
              ) : runDetails ? (
                <div className="space-y-4">
                  <div className="rounded-md border border-border p-3">
                    <p className="text-xs text-muted-foreground">Agent</p>
                    <p className="font-medium">
                      {runDetails.run.agentName ?? runDetails.run.agentId}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">Status</p>
                    <p className="font-medium capitalize">{runDetails.run.status}</p>
                    {runDetails.run.wakeAt ? (
                      <>
                        <p className="mt-2 text-xs text-muted-foreground">Wake At</p>
                        <p className="font-medium">
                          {new Date(runDetails.run.wakeAt).toLocaleString()}
                        </p>
                        {runDetails.run.wakeReason ? (
                          <p className="text-sm text-muted-foreground">
                            {runDetails.run.wakeReason}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    <p className="mt-2 text-xs text-muted-foreground">Input</p>
                    <p className="text-sm">{runDetails.run.inputText}</p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase text-muted-foreground">Steps</p>
                    {runDetails.steps.length ? (
                      runDetails.steps.map((step) => (
                        <div key={step.id} className="rounded-md border border-border p-3">
                          <p className="text-xs text-muted-foreground">#{step.seq}</p>
                          <p className="font-medium">{step.type}</p>
                          {step.toolName ? (
                            <p className="text-xs text-muted-foreground">Tool: {step.toolName}</p>
                          ) : null}
                          {step.argsJson ? (
                            <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                              {JSON.stringify(step.argsJson, null, 2)}
                            </pre>
                          ) : null}
                          {step.resultJson ? (
                            <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                              {JSON.stringify(step.resultJson, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <p className="text-muted-foreground">No steps available yet.</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground">Select a run to view details.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
