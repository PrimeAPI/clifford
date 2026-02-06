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
  inputJson?: unknown;
  outputText?: string | null;
  kind?: string | null;
  profile?: string | null;
  updatedAt?: string;
  wakeAt?: string | null;
  wakeReason?: string | null;
  allowedTools?: unknown;
  contextId?: string | null;
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
  | { id: string; seq: number; kind: 'system_note'; content: string }
  | { id: string; seq: number; kind: 'budget_decision'; action: string; reason?: string | null; maxIterations?: number | null }
  | {
      id: string;
      seq: number;
      kind: 'event';
      label: string;
      details: Array<{ key: string; value: string }>;
      raw?: unknown;
    }
  | {
      id: string;
      seq: number;
      kind: 'spawn_single';
      label: string;
      runId: string;
      detail: string;
      args?: unknown;
    }
  | { id: string; seq: number; kind: 'tool_result'; label: string; toolName: string; result?: unknown }
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
  | { id: string; seq: number; kind: 'finish'; label: string; reason?: string | null }
  | { id: string; seq: number; kind: 'output_update'; label: string; output: string; mode: string }
  | { id: string; seq: number; kind: 'validation_missing'; label: string; detail: string };

type RunStateView = {
  queue: string[];
  inbox: Array<{ fromRunId: string; message: string; at: string }>;
  waitingForParent?: boolean;
};

function getRunState(inputJson: unknown): RunStateView {
  if (!inputJson || typeof inputJson !== 'object') {
    return { queue: [], inbox: [] };
  }
  const state = (inputJson as Record<string, unknown>).state;
  if (!state || typeof state !== 'object') {
    return { queue: [], inbox: [] };
  }
  const record = state as Record<string, unknown>;
  const queue = Array.isArray(record.queue)
    ? record.queue.filter((item) => typeof item === 'string')
    : [];
  const inbox = Array.isArray(record.inbox)
    ? record.inbox
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const entry = item as Record<string, unknown>;
          return {
            fromRunId: typeof entry.fromRunId === 'string' ? entry.fromRunId : 'unknown',
            message: typeof entry.message === 'string' ? entry.message : '',
            at: typeof entry.at === 'string' ? entry.at : '',
          };
        })
    : [];
  const waitingForParent = Boolean(record.waitingForParent);
  return { queue, inbox, waitingForParent };
}

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
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const stateView = useMemo(() => getRunState(details?.run.inputJson), [details]);

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
    const formatEventDetails = (payload: Record<string, unknown> | null | undefined) => {
      if (!payload) return [];
      const entriesList: Array<{ key: string; value: string }> = [];
      Object.entries(payload).forEach(([key, value]) => {
        if (value === undefined) return;
        if (value === null) {
          entriesList.push({ key, value: 'null' });
          return;
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          const text = String(value);
          entriesList.push({ key, value: text.length > 280 ? `${text.slice(0, 280)}…` : text });
          return;
        }
        if (Array.isArray(value)) {
          entriesList.push({ key, value: `list(${value.length})` });
          return;
        }
        entriesList.push({ key, value: 'object' });
      });
      return entriesList;
    };

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

      if (step.type === 'tool_result') {
        items.push({
          id: step.id,
          seq: step.seq,
          kind: 'tool_result',
          label: `${step.toolName ?? 'tool'} result`,
          toolName: step.toolName ?? 'tool',
          result: step.resultJson,
        });
      }

      if (step.type === 'message') {
        const payload = step.resultJson as {
          event?: string;
          subagents?: any;
          reason?: string;
          content?: string;
          action?: string;
          maxIterations?: number;
          feedback?: string;
          queueLength?: number;
          parentRunId?: string;
          subagentRunId?: string;
          retryOf?: string;
          signature?: string;
          count?: number;
          args?: unknown;
          task?: string;
          context?: unknown;
        } | null;
        if (!payload) {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'event',
            label: 'Message',
            details: [],
            raw: payload,
          });
        }
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
        if (payload?.event === 'budget_decision') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'budget_decision',
            action: payload.action ?? 'unknown',
            reason: payload.reason ?? null,
            maxIterations: payload.maxIterations ?? null,
          });
        }
        if (payload?.event === 'queue_op') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Queue update',
            detail: `Action: ${payload.action ?? 'unknown'} · Queue length: ${payload.queueLength ?? 'n/a'}`,
          });
        }
        if (payload?.event === 'request_parent') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Requested parent',
            detail: `Parent run: ${payload.parentRunId ?? 'unknown'}`,
          });
        }
        if (payload?.event === 'reply_subagent') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Replied to subagent',
            detail: `Subagent run: ${payload.subagentRunId ?? 'unknown'}`,
          });
        }
        if (payload?.event === 'retry_subagent') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Retried subagent',
            detail: `Subagent run: ${payload.subagentRunId ?? 'unknown'}${payload.retryOf ? ` · Retry of: ${payload.retryOf}` : ''}`,
          });
        }
        if (payload?.event === 'spawn_attempt') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Spawn attempt',
            detail: `Count: ${payload.count ?? 'n/a'} · Signature: ${payload.signature ? payload.signature.slice(0, 120) : 'n/a'}`,
          });
        }
        if (payload?.event === 'parent_wake_scheduled') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Parent wake scheduled',
            detail: `Delay: ${payload.delaySeconds ?? 'n/a'}s`,
          });
        }
        if (payload?.event === 'parent_wake_queued') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Parent wake queued',
            detail: `Source: ${payload.source ?? 'daemon'}`,
          });
        }
        if (payload?.event === 'deliver_waiting_for_subagent') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Waiting for subagent',
            detail: `Subagent run: ${payload.subagentRunId ?? 'unknown'}`,
          });
        }
        if (payload?.event === 'blocked_finish_waiting') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Finish blocked (waiting)',
            detail: `Active subagents: ${payload.activeSubagentCount ?? 'n/a'}`,
          });
        }
        if (payload?.event === 'auto_spawn_from_tool_call') {
          const argsText = payload.args ? JSON.stringify(payload.args) : '';
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'spawn_single',
            label: 'Auto-spawned from tool call',
            runId: payload.runId ?? 'unknown',
            detail: `Tool: ${payload.tool ?? 'unknown'} · Task: ${payload.task ?? 'n/a'}${argsText ? ` · Args: ${argsText}` : ''}`,
            args: payload.args ?? null,
          });
        }
        if (payload?.event === 'auto_recovery_spawn') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'spawn_single',
            label: 'Auto-recovery spawn',
            runId: payload.subagentRunId ?? 'unknown',
            detail: `Subagent: ${payload.subagentRunId ?? 'unknown'}${payload.task ? ` · Task: ${payload.task}` : ''}`,
            args: payload.context ?? null,
          });
        }
        if (payload?.event === 'plan_loop_detected') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Plan loop detected',
            detail: `Count: ${payload.count ?? 'n/a'}`,
          });
        }
        if (payload?.event === 'spawn_queue_seeded') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Queue seeded',
            detail: `Queue items: ${payload.count ?? 'n/a'}`,
          });
        }
        if (payload?.event === 'spawn_blocked') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Spawn blocked',
            detail: `Reason: ${payload.reason ?? 'unknown'}`,
          });
        }
        if (payload?.event === 'finish_repeat_forced') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Forced finish',
            detail: `Repeated finish output: ${payload.count ?? 'n/a'}`,
          });
        }
        if (payload?.event === 'validation_override_finish') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Validation override',
            detail: 'Finished despite validation feedback (retry not requested).',
          });
        }
        if (payload?.event === 'validation_retry_exhausted') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Validation retries exhausted',
            detail: `Count: ${payload.count ?? 'n/a'} · Forced finish.`,
          });
        }
        if (payload?.event === 'loop_detected' && (payload as any)?.kind === 'spawn') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Spawn loop detected',
            detail: `Task: ${(payload as any)?.task ?? 'unknown'}`,
          });
        }
        if (payload?.event === 'system_note' && payload.content) {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'system_note',
            content: payload.content,
          });
        }
        if (payload?.event === 'validation_feedback') {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Validation feedback',
            detail: payload.feedback ?? 'Validation requested changes.',
          });
        }
        if (payload?.event === 'validation_result') {
          const detailParts = [
            `Decision: ${payload.decision ?? 'send'}`,
            payload.retry !== undefined ? `Retry: ${payload.retry}` : null,
            payload.feedback ? `Feedback: ${payload.feedback}` : null,
            payload.error ? `Error: ${payload.error}` : null,
            payload.reason ? `Reason: ${payload.reason}` : null,
          ].filter(Boolean);
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Validation result',
            detail: detailParts.join(' · '),
          });
        }
        if (payload?.event === 'finish_blocked') {
          const detailParts = [
            payload.reason ? `Reason: ${payload.reason}` : null,
            payload.retry !== undefined ? `Retry: ${payload.retry}` : null,
            payload.feedback ? `Feedback: ${payload.feedback}` : null,
          ].filter(Boolean);
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Finish blocked',
            detail: detailParts.join(' · '),
          });
        }
        if (payload?.event === 'action_blocked') {
          const detailParts = [
            payload.reason ? `Reason: ${payload.reason}` : null,
            payload.detail ? `Detail: ${payload.detail}` : null,
          ].filter(Boolean);
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'message',
            label: 'Action blocked',
            detail: detailParts.join(' · '),
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
        if (
          payload?.event &&
          ![
            'spawn_subagents',
            'sleep',
            'budget_decision',
            'system_note',
            'validation_feedback',
            'queue_op',
            'request_parent',
            'reply_subagent',
            'retry_subagent',
            'spawn_attempt',
            'spawn_queue_seeded',
            'spawn_blocked',
            'finish_repeat_forced',
            'validation_override_finish',
            'validation_retry_exhausted',
            'validation_result',
            'finish_blocked',
            'action_blocked',
            'loop_detected',
            'auto_spawn_from_tool_call',
            'auto_recovery_spawn',
            'plan_loop_detected',
            'parent_wake_scheduled',
            'parent_wake_queued',
            'deliver_waiting_for_subagent',
            'blocked_finish_waiting',
          ].includes(payload.event)
        ) {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'event',
            label: `Event · ${payload.event}`,
            details: formatEventDetails(payload),
            raw: payload,
          });
        }
        if (payload && !payload.event) {
          items.push({
            id: step.id,
            seq: step.seq,
            kind: 'event',
            label: 'Message',
            details: formatEventDetails(payload),
            raw: payload,
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
        const payload = step.resultJson as { reason?: string } | null;
        items.push({
          id: step.id,
          seq: step.seq,
          kind: 'finish',
          label: 'Finished',
          reason: payload?.reason ?? null,
        });
      }

      if (step.type === 'output_update') {
        const payload = step.resultJson as { output?: string; mode?: string } | null;
        items.push({
          id: step.id,
          seq: step.seq,
          kind: 'output_update',
          label: 'Output update',
          output: payload?.output ?? '',
          mode: payload?.mode ?? 'replace',
        });
      }

      if (step.type === 'validation_missing') {
        const payload = step.resultJson as { detail?: string } | null;
        items.push({
          id: step.id,
          seq: step.seq,
          kind: 'validation_missing',
          label: 'Validation missing',
          detail: payload?.detail ?? 'Validation note missing.',
        });
      }

      if (
        !['note', 'decision', 'tool_call', 'tool_result', 'message', 'assistant_message', 'finish', 'output_update', 'validation_missing'].includes(
          step.type
        )
      ) {
        items.push({
          id: step.id,
          seq: step.seq,
          kind: 'event',
          label: `Step · ${step.type}`,
          details: formatEventDetails((step.resultJson as Record<string, unknown> | null) ?? {}),
          raw: step.resultJson,
        });
      }
    });

    return items.sort((a, b) => a.seq - b.seq);
  }, [details, children]);

  const runBudget = useMemo(() => {
    if (!details) return null;
    const reversed = [...details.steps].reverse();
    const budgetStep = reversed.find((step) => {
      if (step.type !== 'message') return false;
      const payload = step.resultJson as { event?: string; maxIterations?: number } | null;
      return payload?.event === 'set_run_limits' && typeof payload.maxIterations === 'number';
    });
    if (!budgetStep) return null;
    const payload = budgetStep.resultJson as { maxIterations?: number; reason?: string } | null;
    return {
      maxIterations: payload?.maxIterations ?? null,
      reason: payload?.reason ?? null,
    };
  }, [details]);

  const finishReason = useMemo(() => {
    if (!details) return null;
    const finishStep = [...details.steps].reverse().find((step) => step.type === 'finish');
    const payload = (finishStep?.resultJson ?? null) as { reason?: string } | null;
    return payload?.reason ?? null;
  }, [details]);

  if (loading || !details) {
    return <div className="text-xs text-muted-foreground">Loading task…</div>;
  }

  const toggleEventExpanded = (id: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const buildTaskText = () => {
    const lines: string[] = [];
    lines.push('Task');
    lines.push('Close');
    lines.push(`Status: ${details.run.status}`);
    lines.push(`Profile: ${details.run.profile ?? details.run.kind ?? 'coordinator'}`);
    lines.push('Run Metadata');
    lines.push(`Run ID: ${details.run.id}`);
    lines.push(`Agent ID: ${details.run.agentId}`);
    lines.push(`Kind: ${details.run.kind ?? 'coordinator'}`);
    lines.push(`Context ID: ${details.run.contextId ?? 'none'}`);
    lines.push(`Updated: ${details.run.updatedAt ?? 'unknown'}`);
    lines.push(`Wake Reason: ${details.run.wakeReason ?? 'none'}`);
    lines.push(`Wake At: ${details.run.wakeAt ?? 'none'}`);
    lines.push(
      `Tools Allowed: ${Array.isArray(details.run.allowedTools) ? details.run.allowedTools.length : 'all'}`
    );
    lines.push(`Run Budget: ${runBudget?.maxIterations ?? 'not set'}`);
    lines.push(`Budget Reason: ${runBudget?.reason ?? 'n/a'}`);
    lines.push(`Finish Reason: ${finishReason ?? 'n/a'}`);
    lines.push(`Queue Length: ${stateView.queue.length}`);
    lines.push(`Inbox Count: ${stateView.inbox.length}`);
    lines.push(`Waiting For Parent: ${stateView.waitingForParent ? 'yes' : 'no'}`);
    lines.push('Task');
    lines.push(details.run.inputText);

    entries.forEach((entry) => {
      if (entry.kind === 'note') {
        lines.push(entry.category);
        lines.push(entry.content);
      } else if (entry.kind === 'decision') {
        lines.push(`decision (${entry.importance})`);
        lines.push(entry.content);
      } else if (entry.kind === 'system_note') {
        lines.push('system_note');
        lines.push(entry.content);
      } else if (entry.kind === 'budget_decision') {
        lines.push(`budget_decision (${entry.action})`);
        if (entry.reason) lines.push(entry.reason);
        if (typeof entry.maxIterations === 'number') {
          lines.push(`maxIterations: ${entry.maxIterations}`);
        }
      } else if (entry.kind === 'tool') {
        lines.push(entry.label);
      } else if (entry.kind === 'tool_result') {
        lines.push(entry.label);
      } else if (entry.kind === 'spawn') {
        lines.push(entry.label);
        entry.subagents.forEach((sub) => {
          lines.push(`${sub.profile ?? 'subagent'} · ${sub.task} · ${sub.status ?? 'unknown'}`);
        });
      } else if (entry.kind === 'message') {
        lines.push(entry.label);
        lines.push(entry.detail);
      } else if (entry.kind === 'spawn_single') {
        lines.push(entry.label);
        lines.push(`${entry.detail}`);
        lines.push(`Run ID: ${entry.runId}`);
      } else if (entry.kind === 'sleep') {
        lines.push(entry.label);
        lines.push(entry.detail);
      } else if (entry.kind === 'event') {
        lines.push(entry.label);
        entry.details.forEach((detail) => {
          lines.push(`${detail.key}: ${detail.value}`);
        });
        if (expandedEvents.has(entry.id)) {
          lines.push('json:');
          lines.push(JSON.stringify(entry.raw ?? {}, null, 2));
        }
      } else if (entry.kind === 'output_update') {
        lines.push(entry.label);
        lines.push(`Mode: ${entry.mode}`);
        lines.push(entry.output);
      } else if (entry.kind === 'validation_missing') {
        lines.push(entry.label);
        lines.push(entry.detail);
      } else if (entry.kind === 'finish') {
        lines.push(entry.label);
        if (entry.reason) lines.push(`Reason: ${entry.reason}`);
      }
    });

    if (details.run.outputText) {
      lines.push('Output');
      lines.push(details.run.outputText);
    }
    if (stateView.queue.length > 0 || stateView.inbox.length > 0) {
      lines.push('State');
      if (stateView.queue.length > 0) {
        lines.push('Queue');
        stateView.queue.forEach((item) => lines.push(`- ${item}`));
      }
      if (stateView.inbox.length > 0) {
        lines.push('Inbox');
        stateView.inbox.forEach((item) =>
          lines.push(`${item.fromRunId}: ${item.message}`)
        );
      }
    }

    return lines.join('\n');
  };

  const copyTaskText = async () => {
    const text = buildTaskText();
    await navigator.clipboard.writeText(text);
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          All events and steps are shown.
        </div>
        <Button variant="outline" size="sm" onClick={copyTaskText}>
          Copy task history
        </Button>
      </div>
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
          <div>Run Budget: {runBudget?.maxIterations ?? 'not set'}</div>
          <div>Budget Reason: {runBudget?.reason ?? 'n/a'}</div>
          <div>Finish Reason: {finishReason ?? 'n/a'}</div>
          <div>Queue Length: {stateView.queue.length}</div>
          <div>Inbox Count: {stateView.inbox.length}</div>
          <div>Waiting For Parent: {stateView.waitingForParent ? 'yes' : 'no'}</div>
        </div>
      </div>
      {(stateView.queue.length > 0 || stateView.inbox.length > 0) && (
        <div className="rounded border border-border p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">State</div>
          {stateView.queue.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-muted-foreground">Queue</div>
              <div className="mt-1 space-y-1 text-xs">
                {stateView.queue.map((item, index) => (
                  <div key={`${details.run.id}-queue-${index}`} className="rounded border border-border px-2 py-1">
                    {item}
                  </div>
                ))}
              </div>
            </div>
          )}
          {stateView.inbox.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-muted-foreground">Inbox</div>
              <div className="mt-1 space-y-2 text-xs">
                {stateView.inbox.map((item, index) => (
                  <div key={`${details.run.id}-inbox-${index}`} className="rounded border border-border px-2 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {item.fromRunId}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap">{item.message}</div>
                    {item.at ? (
                      <div className="mt-1 text-[11px] text-muted-foreground">{item.at}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
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
            if (entry.kind === 'system_note') {
              return (
                <div key={entry.id} className="rounded border border-border bg-amber-50/60 p-3 text-amber-900">
                  <div className="text-[11px] uppercase tracking-wide text-amber-700">System note</div>
                  <div className="mt-1 whitespace-pre-wrap">{entry.content}</div>
                </div>
              );
            }
            if (entry.kind === 'budget_decision') {
              return (
                <div key={entry.id} className="rounded border border-border bg-accent/20 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Budget decision · {entry.action}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap">
                    {entry.reason || 'No reason provided.'}
                  </div>
                  {typeof entry.maxIterations === 'number' ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      New max iterations: {entry.maxIterations}
                    </div>
                  ) : null}
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
            if (entry.kind === 'tool_result') {
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
            if (entry.kind === 'spawn_single') {
              return (
                <div key={entry.id} className="rounded border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{entry.label}</div>
                    {entry.runId ? (
                      <div className="flex items-center gap-2">
                        {entry.args ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onOpenTool({ name: 'auto_spawn_tool', args: entry.args })}
                          >
                            View args
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => onOpenTask(entry.runId)}>
                          Open
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                    {entry.detail}
                  </div>
                </div>
              );
            }
            if (entry.kind === 'event') {
              const isExpanded = expandedEvents.has(entry.id);
              return (
                <div key={entry.id} className="rounded border border-border bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{entry.label}</div>
                    <Button variant="ghost" size="sm" onClick={() => toggleEventExpanded(entry.id)}>
                      {isExpanded ? 'Hide JSON' : 'Show JSON'}
                    </Button>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {entry.details.length === 0 ? (
                      <div>No details.</div>
                    ) : (
                      entry.details.map((detail) => (
                        <div key={`${entry.id}-${detail.key}`}>
                          {detail.key}: {detail.value}
                        </div>
                      ))
                    )}
                  </div>
                  {isExpanded ? (
                    <pre className="mt-2 whitespace-pre-wrap rounded border border-border bg-background p-2 text-[11px] text-muted-foreground">
                      {JSON.stringify(entry.raw ?? {}, null, 2)}
                    </pre>
                  ) : null}
                </div>
              );
            }
            if (entry.kind === 'output_update') {
              return (
                <div key={entry.id} className="rounded border border-border p-3">
                  <div className="font-medium">{entry.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Mode: {entry.mode}</div>
                  <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                    {entry.output || '(empty)'}
                  </div>
                </div>
              );
            }
            if (entry.kind === 'validation_missing') {
              return (
                <div key={entry.id} className="rounded border border-border bg-amber-50/60 p-3 text-amber-900">
                  <div className="text-[11px] uppercase tracking-wide text-amber-700">{entry.label}</div>
                  <div className="mt-1 whitespace-pre-wrap">{entry.detail}</div>
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
                  {entry.reason ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Reason: {entry.reason}
                    </div>
                  ) : null}
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
