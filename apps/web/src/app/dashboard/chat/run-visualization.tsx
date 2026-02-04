'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

type RunSummary = {
  id: string;
  agentName?: string | null;
  agentId: string;
  status: string;
  inputText: string;
  outputText?: string | null;
  kind?: string | null;
  profile?: string | null;
  updatedAt?: string;
  wakeAt?: string | null;
  wakeReason?: string | null;
};

type RunStep = {
  id: string;
  seq: number;
  type: string;
  toolName?: string | null;
  argsJson?: unknown;
  resultJson?: unknown;
};

type RunDetails = {
  run: RunSummary;
  steps: RunStep[];
};

type TaskDialogEntry =
  | { id: string; seq: number; kind: 'decision'; content: string; importance: string }
  | { id: string; seq: number; kind: 'note'; category: 'requirements' | 'plan' | 'artifact' | 'validation'; content: string }
  | {
      id: string;
      seq: number;
      kind: 'tool';
      label: string;
      toolName: string;
      args?: unknown;
      result?: unknown;
    }
  | {
      id: string;
      seq: number;
      kind: 'spawn';
      label: string;
      subagents: Array<{ runId: string; task: string; profile?: string | null; status?: string }>;
    }
  | { id: string; seq: number; kind: 'message'; label: string; detail: string }
  | { id: string; seq: number; kind: 'sleep'; label: string; detail: string }
  | { id: string; seq: number; kind: 'finish'; label: string };

function TaskDialog({
  runId,
  onOpenTask,
  onOpenTool,
}: {
  runId: string;
  onOpenTask: (id: string) => void;
  onOpenTool: (tool: { name: string; args?: unknown; result?: unknown }) => void;
}) {
  const { details, children, loading, reload } = useRunDetails(runId);
  const [showFullOutput, setShowFullOutput] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      void reload();
    }, 1500);
    return () => clearInterval(interval);
  }, [reload]);

  const entries = useMemo<TaskDialogEntry[]>(() => {
    if (!details) return [];
    const items: TaskDialogEntry[] = [];
    const stepMap = details.steps;

    stepMap.forEach((step) => {
      if (step.type === 'note') {
        const payload = step.resultJson as { category?: string; content?: string } | null;
        if (payload?.content && payload?.category) {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'note',
            category: payload.category as 'requirements' | 'plan' | 'artifact' | 'validation',
            content: payload.content,
          });
        }
      }

      if (step.type === 'decision') {
        const payload = step.resultJson as { content?: string; importance?: string } | null;
        if (payload?.content) {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'decision',
            content: payload.content,
            importance: payload.importance ?? 'normal',
          });
        }
      }

      if (step.type === 'tool_call') {
        const toolResult = stepMap.find(
          (candidate) =>
            candidate.type === 'tool_result' &&
            candidate.toolName === step.toolName &&
            candidate.seq > step.seq
        );
        items.push({
          id: step.id,
          seq: step.seq,
          kind: 'tool',
          label: step.toolName ?? 'tool',
          toolName: step.toolName ?? 'tool',
          args: step.argsJson,
          result: toolResult?.resultJson,
        });
      }

      if (step.type === 'message') {
        const payload = step.resultJson as { event?: string; subagents?: any; reason?: string } | null;
        if (payload?.event === 'spawn_subagents') {
          const subagents = Array.isArray(payload.subagents) ? payload.subagents : [];
          const statusById = new Map(children.map((child) => [child.id, child.status]));
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'spawn',
            label: 'Spawned subagents',
            subagents: subagents.map((sub: any) => ({
              runId: sub.runId,
              task: sub.task,
              profile: sub.profile ?? null,
              status: statusById.get(sub.runId),
            })),
          });
        }
        if (payload?.event === 'sleep') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'sleep',
            label: 'Sleep',
            detail: payload?.reason ?? 'Waiting for wake trigger',
          });
        }
      }

      if (step.type === 'assistant_message') {
        const payload = step.resultJson as { message?: string } | null;
        if (payload?.message) {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Message to user',
            detail: payload.message,
          });
        }
      }

      if (step.type === 'finish') {
        items.push({
          id: step.id,
          seq: step.seq,
          kind: 'finish',
          label: 'Finished',
        });
      }
    });

    return items.sort((a, b) => a.seq - b.seq);
  }, [details, children]);

  if (loading || !details) {
    return <div className="text-xs text-muted-foreground">Loading task…</div>;
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>Status: {details.run.status}</div>
        <div>Profile: {details.run.profile ?? details.run.kind ?? 'coordinator'}</div>
      </div>
      <div className="rounded border border-border p-3 text-xs text-muted-foreground">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Run Metadata</div>
        <div className="mt-2 grid grid-cols-1 gap-1 md:grid-cols-2">
          <div>Run ID: {details.run.id}</div>
          <div>Agent ID: {details.run.agentId}</div>
          <div>Kind: {details.run.kind ?? 'coordinator'}</div>
          <div>Context ID: {details.run.contextId ?? 'none'}</div>
          <div>Updated: {details.run.updatedAt ?? 'unknown'}</div>
          <div>Wake Reason: {details.run.wakeReason ?? 'none'}</div>
          <div>Wake At: {details.run.wakeAt ?? 'none'}</div>
          <div>Tools Allowed: {Array.isArray(details.run.allowedTools) ? details.run.allowedTools.length : 'all'}</div>
        </div>
      </div>
      <div className="rounded border border-border p-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Task</div>
        <div className="mt-1">{details.run.inputText}</div>
      </div>
      <div className="space-y-3">
        {entries.length === 0 ? (
          <div className="text-xs text-muted-foreground">No actions recorded yet.</div>
        ) : (
          entries.map((entry, index) => {
            if (entry.kind === 'finish' && details.run.outputText) {
              const output = details.run.outputText;
              const preview = output.length > 240 ? `${output.slice(0, 240)}…` : output;
              return (
                <div key={`${entry.id}-output`} className="rounded border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Output</div>
                    {output.length > 240 ? (
                      <Button variant="ghost" size="sm" onClick={() => setShowFullOutput((v) => !v)}>
                        {showFullOutput ? 'Collapse' : 'Expand'}
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap">
                    {showFullOutput ? output : preview}
                  </div>
                </div>
              );
            }
            if (entry.kind === 'decision') {
              return (
                <div key={entry.id} className="rounded border border-border bg-accent/30 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Decision · {entry.importance}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap">{entry.content}</div>
                </div>
              );
            }
            if (entry.kind === 'note') {
              return (
                <div key={entry.id} className="rounded border border-border bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {entry.category}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap">{entry.content}</div>
                </div>
              );
            }
            if (entry.kind === 'tool') {
              return (
                <div key={entry.id} className="rounded border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{entry.label}</div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onOpenTool({
                          name: entry.toolName,
                          args: entry.args,
                          result: entry.result,
                        })
                      }
                    >
                      View
                    </Button>
                  </div>
                </div>
              );
            }
            if (entry.kind === 'spawn') {
              return (
                <div key={entry.id} className="rounded border border-border p-3">
                  <div className="font-medium">{entry.label}</div>
                  <div className="mt-2 space-y-2">
                    {entry.subagents.map((sub) => (
                      <div
                        key={sub.runId}
                        className="flex items-center justify-between rounded border border-border px-2 py-1"
                      >
                        <div className="text-xs">
                          {sub.profile ?? 'subagent'} · {sub.task} · {sub.status ?? 'unknown'}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onOpenTask(sub.runId)}
                        >
                          Open
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            if (entry.kind === 'message') {
              return (
                <div key={entry.id} className="rounded border border-border p-3">
                  <div className="font-medium">{entry.label}</div>
                  <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                    {entry.detail}
                  </div>
                </div>
              );
            }
            if (entry.kind === 'sleep') {
              return (
                <div key={entry.id} className="rounded border border-border p-3">
                  <div className="font-medium">{entry.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{entry.detail}</div>
                </div>
              );
            }
            if (entry.kind === 'finish') {
              return (
                <div key={entry.id} className="rounded border border-border p-3">
                  <div className="font-medium">{entry.label}</div>
                </div>
              );
            }
            return null;
          })
        )}
      </div>
    </div>
  );
}

function useRunDetails(runId: string) {
  const [details, setDetails] = useState<RunDetails | null>(null);
  const [children, setChildren] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const lastDetailsSignature = useRef<string>('');
  const lastChildrenSignature = useRef<string>('');

  const reload = useCallback(async () => {
    if (!details) {
      setLoading(true);
    }
    try {
      const res = await fetch(`/api/runs/${runId}`, {
        headers: { 'X-User-Id': DEMO_USER_ID, 'X-Tenant-Id': '00000000-0000-0000-0000-000000000000' },
      });
      const data = (await res.json()) as RunDetails;
      const detailsSignature = [
        data.run.id,
        data.run.status,
        data.run.updatedAt ?? '',
        data.steps.length,
        data.steps[data.steps.length - 1]?.id ?? '',
        data.steps[data.steps.length - 1]?.seq ?? '',
      ].join('|');
      if (detailsSignature !== lastDetailsSignature.current) {
        lastDetailsSignature.current = detailsSignature;
        setDetails(data);
      }

      const childRes = await fetch(`/api/runs/${runId}/children`, {
        headers: { 'X-User-Id': DEMO_USER_ID, 'X-Tenant-Id': '00000000-0000-0000-0000-000000000000' },
      });
      const childData = (await childRes.json()) as { children: RunSummary[] };
      const nextChildren = childData.children || [];
      const childrenSignature = nextChildren
        .map((child) => `${child.id}:${child.status}:${child.updatedAt ?? ''}`)
        .join('|');
      if (childrenSignature !== lastChildrenSignature.current) {
        lastChildrenSignature.current = childrenSignature;
        setChildren(nextChildren);
      }
    } finally {
      if (!details) {
        setLoading(false);
      }
    }
  }, [runId, details]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { details, children, loading, reload };
}

type DialogState = {
  title: string;
  kind?: 'llm_request' | 'llm_response' | 'tool' | 'task' | 'generic';
  content: unknown;
};

export function RunVisualization({ runId }: { runId: string }) {
  const [dialogStack, setDialogStack] = useState<DialogState[]>([]);
  const { details, loading } = useRunDetails(runId);
  const dialog = dialogStack.length > 0 ? dialogStack[dialogStack.length - 1] : null;

  const latestStep = details?.steps?.[details.steps.length - 1];
  const latestLabel = latestStep
    ? latestStep.type === 'tool_call'
      ? `Tool call: ${latestStep.toolName ?? 'unknown'}`
      : latestStep.type === 'tool_result'
        ? `Tool result: ${latestStep.toolName ?? 'unknown'}`
        : latestStep.type
    : 'No steps yet';

  const renderKeyValue = (label: string, value: unknown) => (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      {typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? (
        <div className="text-sm">{String(value)}</div>
      ) : (
        <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(value, null, 2)}</pre>
      )}
    </div>
  );

  const openDialog = (next: DialogState) => {
    setDialogStack((prev) => [...prev, next]);
  };

  const closeDialog = () => setDialogStack([]);

  const goBack = () => {
    setDialogStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  };

  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDialog();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialog]);

  const renderDialogContent = () => {
    if (!dialog) return null;
    const { kind, content } = dialog;

    if (kind === 'llm_request') {
      const payload = content as {
        iteration?: number;
        model?: string;
        fallbackModel?: string | null;
        payload?: any;
      };
      return (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {renderKeyValue('Model', payload.model ?? 'unknown')}
            {renderKeyValue('Fallback', payload.fallbackModel ?? 'none')}
            {renderKeyValue('Iteration', payload.iteration ?? 0)}
          </div>
          {renderKeyValue('Task', payload.payload?.task)}
          {renderKeyValue('Output', payload.payload?.output)}
          {renderKeyValue('Run Kind', payload.payload?.runKind)}
          {renderKeyValue('Profile', payload.payload?.profile)}
          {renderKeyValue('Input', payload.payload?.input)}
          {renderKeyValue('Conversation', payload.payload?.conversation)}
          {renderKeyValue('Transcript', payload.payload?.transcript)}
          {renderKeyValue('Subagents', payload.payload?.subagents)}
        </div>
      );
    }

    if (kind === 'llm_response') {
      const payload = content as { responseText?: string; parsed?: any };
      return (
        <div className="space-y-4 text-sm">
          {renderKeyValue('Response Text', payload.responseText)}
          {renderKeyValue('Parsed Command', payload.parsed)}
        </div>
      );
    }

    if (kind === 'tool') {
      const payload = content as { name: string; args?: unknown; result?: unknown };
      return (
        <div className="space-y-4 text-sm">
          {renderKeyValue('Tool', payload.name)}
          {renderKeyValue('Args', payload.args)}
          {renderKeyValue('Result', payload.result)}
        </div>
      );
    }

    if (kind === 'task') {
      const payload = content as { runId?: string };
      if (!payload?.runId) {
        return <div className="text-xs text-muted-foreground">Missing subagent id.</div>;
      }
      return (
        <TaskDialog
          runId={payload.runId}
          onOpenTask={(id) => openDialog({ title: 'Task', kind: 'task', content: { runId: id } })}
          onOpenTool={(tool) =>
            openDialog({
              title: `Tool: ${tool.name}`,
              kind: 'tool',
              content: tool,
            })
          }
        />
      );
    }

    return (
      <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(content, null, 2)}</pre>
    );
  };

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            openDialog({ title: 'Task', kind: 'task', content: { runId } });
          }}
        >
          View task
        </Button>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {loading
          ? 'Loading activity...'
          : details
            ? `Status: ${details.run.status} · Steps: ${details.steps.length} · Latest: ${latestLabel}`
            : 'No activity yet.'}
      </div>

      {dialog ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={closeDialog}
        >
          <div
            className="max-h-[85vh] w-full max-w-4xl overflow-y-auto rounded bg-background p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {dialogStack.length > 1 ? (
                  <Button variant="ghost" size="sm" onClick={goBack}>
                    Back
                  </Button>
                ) : null}
                <h3 className="text-sm font-semibold">{dialog.title}</h3>
              </div>
              <Button variant="ghost" size="sm" onClick={closeDialog}>
                Close
              </Button>
            </div>
            <div className="mt-3">{renderDialogContent()}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
