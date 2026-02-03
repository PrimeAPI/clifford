'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ListChecks, History } from 'lucide-react';
import { useQueueStatus } from './use-queue-status';

export default function QueueOverviewPage() {
  const { queueStatus } = useQueueStatus();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Queue</h1>
        <p className="text-muted-foreground">Track system throughput and task health at a glance.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Queued Work</CardTitle>
            <CardDescription>Active + waiting tasks across all queues.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Messages</p>
                <p className="text-lg font-semibold">
                  {(queueStatus?.queues.messages.counts.active ?? 0) +
                    (queueStatus?.queues.messages.counts.waiting ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Runs</p>
                <p className="text-lg font-semibold">
                  {(queueStatus?.queues.runs.counts.active ?? 0) +
                    (queueStatus?.queues.runs.counts.waiting ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Deliveries</p>
                <p className="text-lg font-semibold">
                  {(queueStatus?.queues.deliveries.counts.active ?? 0) +
                    (queueStatus?.queues.deliveries.counts.waiting ?? 0)}
                </p>
              </div>
            </div>
            <Button asChild className="w-full">
              <Link href="/dashboard/queue/tasks">
                <ListChecks className="mr-2 h-4 w-4" />
                View Queue Tasks
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>Recently completed and failed tasks.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Completed</p>
                <p className="text-lg font-semibold">
                  {(queueStatus?.queues.messages.counts.completed ?? 0) +
                    (queueStatus?.queues.runs.counts.completed ?? 0) +
                    (queueStatus?.queues.deliveries.counts.completed ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Failed</p>
                <p className="text-lg font-semibold">
                  {(queueStatus?.queues.messages.counts.failed ?? 0) +
                    (queueStatus?.queues.runs.counts.failed ?? 0) +
                    (queueStatus?.queues.deliveries.counts.failed ?? 0)}
                </p>
              </div>
            </div>
            <Button asChild variant="outline" className="w-full">
              <Link href="/dashboard/history">
                <History className="mr-2 h-4 w-4" />
                View History
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
