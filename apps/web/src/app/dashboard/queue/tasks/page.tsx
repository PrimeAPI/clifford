'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useQueueStatus } from '../use-queue-status';
import type { QueueJob } from '../use-queue-status';

const renderJobList = (title: string, jobs: QueueJob[]) => (
  <div className="space-y-2">
    <p className="font-medium">{title}</p>
    {jobs.length ? (
      <div className="space-y-2 rounded-md border border-border p-3">
        {jobs.map((job) => (
          <div key={job.id} className="space-y-1 border-b border-border pb-2 last:border-0 last:pb-0">
            <p className="text-sm font-medium">{job.id}</p>
            <p className="text-xs text-muted-foreground">Type: {job.name}</p>
            {job.failedReason ? (
              <p className="text-xs text-destructive">Error: {job.failedReason}</p>
            ) : null}
            {job.data ? (
              <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                {JSON.stringify(job.data, null, 2)}
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    ) : (
      <p className="text-muted-foreground">No jobs.</p>
    )}
  </div>
);

export default function QueueTasksPage() {
  const { queueStatus, loadingQueue, loadQueueStatus } = useQueueStatus();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Queue</h1>
        <p className="text-muted-foreground">Monitor queued work and task execution.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Queue Status</CardTitle>
              <CardDescription>Live view of queued and active tasks</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={loadQueueStatus} disabled={loadingQueue}>
              <RefreshCw className={cn('h-4 w-4', loadingQueue && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <p className="font-medium">Message Queue</p>
              <p>Active: {queueStatus?.queues.messages.counts.active ?? 0}</p>
              <p>Waiting: {queueStatus?.queues.messages.counts.waiting ?? 0}</p>
              <p>Completed: {queueStatus?.queues.messages.counts.completed ?? 0}</p>
              <p>Failed: {queueStatus?.queues.messages.counts.failed ?? 0}</p>
            </div>
            <div className="space-y-2">
              <p className="font-medium">Run Queue</p>
              <p>Active: {queueStatus?.queues.runs.counts.active ?? 0}</p>
              <p>Waiting: {queueStatus?.queues.runs.counts.waiting ?? 0}</p>
              <p>Completed: {queueStatus?.queues.runs.counts.completed ?? 0}</p>
              <p>Failed: {queueStatus?.queues.runs.counts.failed ?? 0}</p>
            </div>
            <div className="space-y-2">
              <p className="font-medium">Delivery Queue</p>
              <p>Active: {queueStatus?.queues.deliveries.counts.active ?? 0}</p>
              <p>Waiting: {queueStatus?.queues.deliveries.counts.waiting ?? 0}</p>
              <p>Completed: {queueStatus?.queues.deliveries.counts.completed ?? 0}</p>
              <p>Failed: {queueStatus?.queues.deliveries.counts.failed ?? 0}</p>
            </div>
          </div>
          {renderJobList('Active Message Jobs', queueStatus?.queues.messages.active ?? [])}
          {renderJobList('Waiting Message Jobs', queueStatus?.queues.messages.waiting ?? [])}
          {renderJobList('Failed Message Jobs', queueStatus?.queues.messages.failed ?? [])}
          {renderJobList('Completed Message Jobs', queueStatus?.queues.messages.completed ?? [])}
          {renderJobList('Active Delivery Jobs', queueStatus?.queues.deliveries.active ?? [])}
          {renderJobList('Waiting Delivery Jobs', queueStatus?.queues.deliveries.waiting ?? [])}
          {renderJobList('Failed Delivery Jobs', queueStatus?.queues.deliveries.failed ?? [])}
          {renderJobList('Completed Delivery Jobs', queueStatus?.queues.deliveries.completed ?? [])}
          {renderJobList('Active Run Jobs', queueStatus?.queues.runs.active ?? [])}
          {renderJobList('Waiting Run Jobs', queueStatus?.queues.runs.waiting ?? [])}
          {renderJobList('Failed Run Jobs', queueStatus?.queues.runs.failed ?? [])}
          {renderJobList('Completed Run Jobs', queueStatus?.queues.runs.completed ?? [])}
        </CardContent>
      </Card>
    </div>
  );
}
