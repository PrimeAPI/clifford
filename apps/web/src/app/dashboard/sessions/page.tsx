'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

type Channel = {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
};

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

type Context = {
  id: string;
  userId: string;
  channelId: string;
  name: string;
  lastUserInteractionAt: string;
  turnCount: number;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Message = {
  id: string;
  userId: string;
  channelId: string;
  contextId: string | null;
  content: string;
  direction: string;
  metadata: string | null;
  deliveryStatus: string;
  deliveryError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

type RunStep = {
  id: string;
  runId: string;
  seq: number;
  type: string;
  toolName: string | null;
  argsJson: any;
  resultJson: any;
  status: string;
  idempotencyKey: string;
  createdAt: string;
};

type Run = {
  id: string;
  tenantId: string;
  agentId: string;
  userId: string | null;
  channelId: string | null;
  contextId: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  kind: string;
  profile: string | null;
  inputText: string;
  inputJson: any;
  outputText: string | null;
  allowedTools: any;
  wakeAt: string | null;
  wakeReason: string | null;
  status: string;
  cancelReason: string | null;
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
  createdAt: string;
  updatedAt: string;
  agentName: string | null;
  steps: RunStep[];
};

type ContextExport = {
  context: Context;
  messages: Message[];
  runs: Run[];
};

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleString();
};

const formatExportText = (exportData: ContextExport) => {
  let text = `# Session Export\n\n`;
  text += `## Context Information\n`;
  text += `- ID: ${exportData.context.id}\n`;
  text += `- Name: ${exportData.context.name}\n`;
  text += `- Created: ${formatDate(exportData.context.createdAt)}\n`;
  text += `- Last Interaction: ${formatDate(exportData.context.lastUserInteractionAt)}\n`;
  text += `- Turn Count: ${exportData.context.turnCount}\n`;
  text += `- Status: ${exportData.context.closedAt ? 'Closed' : 'Active'}\n`;
  if (exportData.context.closedAt) {
    text += `- Closed: ${formatDate(exportData.context.closedAt)}\n`;
  }
  text += `\n`;

  // Messages
  text += `## Messages (${exportData.messages.length})\n\n`;
  for (const msg of exportData.messages) {
    text += `### Message ${msg.id}\n`;
    text += `- Direction: ${msg.direction}\n`;
    text += `- Created: ${formatDate(msg.createdAt)}\n`;
    text += `- Content:\n${msg.content}\n\n`;
    if (msg.metadata) {
      text += `- Metadata: ${msg.metadata}\n\n`;
    }
  }

  // Runs
  text += `## Runs (${exportData.runs.length})\n\n`;
  for (const run of exportData.runs) {
    text += `### Run ${run.id}\n`;
    text += `- Agent: ${run.agentName || run.agentId}\n`;
    text += `- Status: ${run.status}\n`;
    text += `- Kind: ${run.kind}\n`;
    text += `- Created: ${formatDate(run.createdAt)}\n`;
    text += `- Updated: ${formatDate(run.updatedAt)}\n`;
    if (run.profile) {
      text += `- Profile: ${run.profile}\n`;
    }
    text += `- Input: ${run.inputText}\n`;
    if (run.inputJson) {
      text += `- Input JSON:\n\`\`\`json\n${JSON.stringify(run.inputJson, null, 2)}\n\`\`\`\n`;
    }
    if (run.outputText) {
      text += `- Output: ${run.outputText}\n`;
    }
    if (run.allowedTools) {
      text += `- Allowed Tools:\n\`\`\`json\n${JSON.stringify(run.allowedTools, null, 2)}\n\`\`\`\n`;
    }
    if (run.wakeAt) {
      text += `- Wake At: ${formatDate(run.wakeAt)}\n`;
      text += `- Wake Reason: ${run.wakeReason}\n`;
    }
    if (run.cancelReason) {
      text += `- Cancel Reason: ${run.cancelReason}\n`;
    }
    text += `\n`;

    // Steps
    if (run.steps.length > 0) {
      text += `#### Run Steps (${run.steps.length})\n\n`;
      for (const step of run.steps) {
        text += `##### Step #${step.seq} (${step.type})\n`;
        text += `- ID: ${step.id}\n`;
        text += `- Status: ${step.status}\n`;
        text += `- Created: ${formatDate(step.createdAt)}\n`;
        if (step.toolName) {
          text += `- Tool: ${step.toolName}\n`;
        }
        if (step.argsJson) {
          text += `- Arguments:\n\`\`\`json\n${JSON.stringify(step.argsJson, null, 2)}\n\`\`\`\n`;
        }
        if (step.resultJson) {
          text += `- Result:\n\`\`\`json\n${JSON.stringify(step.resultJson, null, 2)}\n\`\`\`\n`;
        }
        text += `\n`;
      }
    }
    text += `\n`;
  }

  return text;
};

export default function SessionsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [contexts, setContexts] = useState<Context[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'closed'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exportData, setExportData] = useState<ContextExport | null>(null);
  const [loadingExport, setLoadingExport] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load channels on mount
  useEffect(() => {
    const loadChannels = async () => {
      try {
        console.log('[Sessions] Loading channels...');
        const res = await fetch('/api/channels', {
          headers: { 'X-User-Id': DEMO_USER_ID },
        });
        console.log('[Sessions] Channels response status:', res.status);
        if (!res.ok) return;
        const data = (await res.json()) as { channels: Channel[] };
        const channelList = data.channels ?? [];
        console.log('[Sessions] Loaded channels:', channelList);
        setChannels(channelList);
        
        // Auto-select first web channel
        const webChannel = channelList.find((ch) => ch.type === 'web');
        console.log('[Sessions] Selected web channel:', webChannel);
        if (webChannel) {
          setSelectedChannelId(webChannel.id);
        }
      } catch (err) {
        console.error('[Sessions] Failed to load channels:', err);
      }
    };
    loadChannels();
  }, []);

  const loadContexts = useCallback(async () => {
    if (!selectedChannelId) {
      console.log('[Sessions] No channel selected, skipping context load');
      return;
    }
    
    console.log('[Sessions] Loading contexts for channel:', selectedChannelId);
    setLoading(true);
    try {
      const res = await fetch(`/api/contexts?channelId=${selectedChannelId}`, {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      console.log('[Sessions] Contexts response status:', res.status);
      if (!res.ok) {
        throw new Error('Failed to load contexts');
      }
      const data = (await res.json()) as { contexts: Context[] };
      console.log('[Sessions] Loaded contexts:', data.contexts);
      setContexts(data.contexts ?? []);
    } catch (err) {
      console.error('[Sessions] Error loading contexts:', err);
      setContexts([]);
    } finally {
      setLoading(false);
    }
  }, [selectedChannelId]);

  useEffect(() => {
    if (selectedChannelId) {
      loadContexts();
    }
  }, [selectedChannelId, loadContexts]);

  const filteredContexts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return contexts.filter((ctx) => {
      if (statusFilter === 'active' && ctx.closedAt) return false;
      if (statusFilter === 'closed' && !ctx.closedAt) return false;
      if (!query) return true;

      return (
        ctx.name.toLowerCase().includes(query) ||
        ctx.id.toLowerCase().includes(query) ||
        formatDate(ctx.createdAt).toLowerCase().includes(query)
      );
    });
  }, [contexts, searchQuery, statusFilter]);

  const loadExport = useCallback(async (contextId: string) => {
    setLoadingExport(true);
    setExportData(null);
    try {
      const res = await fetch(`/api/contexts/${contextId}/export`, {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      if (!res.ok) {
        throw new Error('Failed to load export');
      }
      const data = (await res.json()) as ContextExport;
      setExportData(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingExport(false);
    }
  }, []);

  const toggleExpand = useCallback(
    (contextId: string) => {
      if (expandedId === contextId) {
        setExpandedId(null);
        setExportData(null);
      } else {
        setExpandedId(contextId);
        loadExport(contextId);
      }
    },
    [expandedId, loadExport]
  );

  const copyToClipboard = useCallback(async () => {
    if (!exportData) return;
    const text = formatExportText(exportData);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [exportData]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
        <p className="text-muted-foreground">View and export past conversation sessions.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>All Sessions</CardTitle>
              <CardDescription>Browse, search, and export session data for debugging.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={loadContexts} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {channels.length > 0 && (
            <div>
              <label className="mb-2 block text-sm font-medium">Channel</label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={selectedChannelId ?? ''}
                onChange={(e) => setSelectedChannelId(e.target.value)}
              >
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name} ({ch.type})
                  </option>
                ))}
              </select>
            </div>
          )}
          
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, ID, or date"
            />
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'closed')}
            >
              <option value="all">All Sessions</option>
              <option value="active">Active Only</option>
              <option value="closed">Closed Only</option>
            </select>
          </div>

          {filteredContexts.length ? (
            <div className="space-y-3">
              {filteredContexts.map((ctx) => (
                <div key={ctx.id} className="rounded-lg border border-border">
                  <div
                    className="flex cursor-pointer items-center justify-between p-4 hover:bg-muted/50"
                    onClick={() => toggleExpand(ctx.id)}
                  >
                    <div className="flex items-center gap-3">
                      {expandedId === ctx.id ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div>
                        <p className="font-medium">{ctx.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(ctx.createdAt)} • {ctx.turnCount} turns
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={cn(
                          'inline-block rounded-full px-2 py-1 text-xs font-medium',
                          ctx.closedAt
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
                        )}
                      >
                        {ctx.closedAt ? 'Closed' : 'Active'}
                      </span>
                    </div>
                  </div>

                  {expandedId === ctx.id && (
                    <div className="border-t border-border p-4">
                      {loadingExport ? (
                        <p className="text-sm text-muted-foreground">Loading session data...</p>
                      ) : exportData ? (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium">
                              {exportData.messages.length} messages, {exportData.runs.length} runs
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={copyToClipboard}
                              disabled={copied}
                            >
                              {copied ? (
                                <>
                                  <Check className="mr-2 h-4 w-4" />
                                  Copied!
                                </>
                              ) : (
                                <>
                                  <Copy className="mr-2 h-4 w-4" />
                                  Copy Full Export
                                </>
                              )}
                            </Button>
                          </div>

                          <div className="space-y-3">
                            <div>
                              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                                Messages
                              </p>
                              <div className="space-y-2">
                                {exportData.messages.map((msg) => (
                                  <div
                                    key={msg.id}
                                    className="rounded-md border border-border bg-muted/30 p-3 text-sm"
                                  >
                                    <p className="text-xs text-muted-foreground">
                                      {msg.direction} • {formatDate(msg.createdAt)}
                                    </p>
                                    <p className="mt-1">{msg.content}</p>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {exportData.runs.length > 0 && (
                              <div>
                                <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                                  Runs
                                </p>
                                <div className="space-y-3">
                                  {exportData.runs.map((run) => (
                                    <div
                                      key={run.id}
                                      className="rounded-md border border-border p-3"
                                    >
                                      <div className="flex items-center justify-between">
                                        <p className="text-sm font-medium">
                                          {run.agentName || run.agentId}
                                        </p>
                                        <span className="text-xs font-medium capitalize">
                                          {run.status}
                                        </span>
                                      </div>
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        {run.inputText}
                                      </p>
                                      {run.outputText && (
                                        <p className="mt-2 text-xs">Output: {run.outputText}</p>
                                      )}

                                      {run.steps.length > 0 && (
                                        <div className="mt-3 space-y-2">
                                          <p className="text-xs font-medium text-muted-foreground">
                                            Steps ({run.steps.length})
                                          </p>
                                          {run.steps.map((step) => (
                                            <div
                                              key={step.id}
                                              className="rounded bg-muted p-2 text-xs"
                                            >
                                              <p className="font-medium">
                                                #{step.seq} {step.type}
                                                {step.toolName && ` - ${step.toolName}`}
                                              </p>
                                              {step.argsJson && (
                                                <pre className="mt-1 whitespace-pre-wrap break-words text-[10px]">
                                                  Args: {JSON.stringify(step.argsJson, null, 2)}
                                                </pre>
                                              )}
                                              {step.resultJson && (
                                                <pre className="mt-1 whitespace-pre-wrap break-words text-[10px]">
                                                  Result: {JSON.stringify(step.resultJson, null, 2)}
                                                </pre>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">Failed to load session data.</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm font-medium">
                {loading ? 'Loading sessions...' : 'No sessions match your filters'}
              </p>
              <p className="text-xs text-muted-foreground">
                {loading 
                  ? 'Please wait' 
                  : contexts.length === 0 
                    ? 'No sessions found for this channel. Start a new conversation.'
                    : 'Try clearing filters or start a new conversation.'}
              </p>
              {!loading && (
                <div className="mt-4 text-left text-xs text-muted-foreground">
                  <p>Debug info:</p>
                  <p>- Channels loaded: {channels.length}</p>
                  <p>- Selected channel: {selectedChannelId ?? 'none'}</p>
                  <p>- Total contexts: {contexts.length}</p>
                  <p>- Filtered contexts: {filteredContexts.length}</p>
                  <p>- Status filter: {statusFilter}</p>
                  <p>- Search query: "{searchQuery}"</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
