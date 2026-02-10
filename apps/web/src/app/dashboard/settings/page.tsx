'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTheme } from '@/components/theme-provider';
import {
  AlertCircle,
  BrainCircuit,
  CheckCircle2,
  KeyRound,
  Monitor,
  Moon,
  Shield,
  Sparkles,
  Sun,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface LlmSettings {
  provider: string;
  model: string;
  fallbackModel: string | null;
  autoSelectLowestCost: boolean;
  routing: {
    enabledModelIds: string[];
    active: ModelRoutingConfig;
    draft: ModelRoutingConfig;
    activatedAt: string | null;
  };
  availableModels: Array<{
    id: string;
    name: string;
    costLevel: 'low' | 'medium' | 'high';
    bestFor: string;
    enabled: boolean;
  }>;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
}

interface RoutingModelSpec {
  model: string;
  fallbackModel: string | null;
  instruction: string;
}

interface ModelRoutingConfig {
  planner: RoutingModelSpec;
  executor: RoutingModelSpec;
  verifier: RoutingModelSpec;
}

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

const DEFAULT_ROUTING: ModelRoutingConfig = {
  planner: {
    model: 'gpt-4o',
    fallbackModel: 'gpt-4o-mini',
    instruction: 'Use for task decomposition and difficult reasoning.',
  },
  executor: {
    model: 'gpt-4o-mini',
    fallbackModel: 'gpt-4.1-nano',
    instruction: 'Use for tool calls and action execution.',
  },
  verifier: {
    model: 'gpt-4o-mini',
    fallbackModel: 'gpt-4.1-nano',
    instruction: 'Use for checks, validation, and concise summaries.',
  },
};

const PHASES: Array<keyof ModelRoutingConfig> = ['planner', 'executor', 'verifier'];

function costClass(costLevel: 'low' | 'medium' | 'high') {
  if (costLevel === 'low') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (costLevel === 'medium') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300';
}

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState('Demo User');
  const [email, setEmail] = useState('demo@clifford.ai');
  const [notifications, setNotifications] = useState(true);

  const [llmSettings, setLlmSettings] = useState<LlmSettings | null>(null);
  const [llmRoutingDraft, setLlmRoutingDraft] = useState<ModelRoutingConfig>(DEFAULT_ROUTING);
  const [llmRoutingActive, setLlmRoutingActive] = useState<ModelRoutingConfig>(DEFAULT_ROUTING);
  const [llmEnabledModelIds, setLlmEnabledModelIds] = useState<string[]>([]);
  const [autoSelectLowestCost, setAutoSelectLowestCost] = useState(true);
  const [llmApiKey, setLlmApiKey] = useState('');
  const [savingLlm, setSavingLlm] = useState(false);
  const [loadingLlm, setLoadingLlm] = useState(true);

  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState('');
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(true);

  const [contextBridgeEnabled, setContextBridgeEnabled] = useState(true);
  const [contextBridgeLimit, setContextBridgeLimit] = useState('12');
  const [savingBridge, setSavingBridge] = useState(false);
  const [loadingBridge, setLoadingBridge] = useState(true);

  useEffect(() => {
    void loadLlmSettings();
    void loadSystemPrompt();
    void loadContextBridge();
  }, []);

  const loadLlmSettings = async () => {
    setLoadingLlm(true);
    try {
      const res = await fetch('/api/settings/llm', {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = (await res.json()) as LlmSettings;
      setLlmSettings(data);
      setLlmRoutingDraft(data.routing?.draft ?? DEFAULT_ROUTING);
      setLlmRoutingActive(data.routing?.active ?? DEFAULT_ROUTING);
      setLlmEnabledModelIds(
        data.routing?.enabledModelIds && data.routing.enabledModelIds.length > 0
          ? data.routing.enabledModelIds
          : (data.availableModels ?? []).map((model) => model.id)
      );
      setAutoSelectLowestCost(data.autoSelectLowestCost ?? true);
    } catch (err) {
      console.error('Failed to load LLM settings:', err);
    } finally {
      setLoadingLlm(false);
    }
  };

  const saveLlmSettings = async () => {
    setSavingLlm(true);
    try {
      const payload: {
        provider?: string;
        autoSelectLowestCost?: boolean;
        enabledModelIds?: string[];
        routingDraft?: ModelRoutingConfig;
        apiKey?: string | null;
      } = {
        provider: 'openai',
        autoSelectLowestCost,
        enabledModelIds: llmEnabledModelIds,
        routingDraft: llmRoutingDraft,
      };

      if (llmApiKey.trim()) {
        payload.apiKey = llmApiKey.trim();
      }

      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to save LLM settings:', error);
        return;
      }

      const data = (await res.json()) as LlmSettings;
      setLlmSettings(data);
      setLlmRoutingDraft(data.routing?.draft ?? DEFAULT_ROUTING);
      setLlmRoutingActive(data.routing?.active ?? DEFAULT_ROUTING);
      setLlmEnabledModelIds(
        data.routing?.enabledModelIds && data.routing.enabledModelIds.length > 0
          ? data.routing.enabledModelIds
          : (data.availableModels ?? []).map((model) => model.id)
      );
      setLlmApiKey('');
    } catch (err) {
      console.error('Failed to save LLM settings:', err);
    } finally {
      setSavingLlm(false);
    }
  };

  const activateLlmRouting = async () => {
    setSavingLlm(true);
    try {
      const payload = {
        provider: 'openai',
        autoSelectLowestCost,
        enabledModelIds: llmEnabledModelIds,
        routingDraft: llmRoutingDraft,
        activateDraft: true,
      };

      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to activate LLM routing:', error);
        return;
      }

      const data = (await res.json()) as LlmSettings;
      setLlmSettings(data);
      setLlmRoutingDraft(data.routing?.draft ?? DEFAULT_ROUTING);
      setLlmRoutingActive(data.routing?.active ?? DEFAULT_ROUTING);
      setLlmEnabledModelIds(
        data.routing?.enabledModelIds && data.routing.enabledModelIds.length > 0
          ? data.routing.enabledModelIds
          : (data.availableModels ?? []).map((model) => model.id)
      );
    } catch (err) {
      console.error('Failed to activate LLM routing:', err);
    } finally {
      setSavingLlm(false);
    }
  };

  const clearLlmKey = async () => {
    setSavingLlm(true);
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify({ apiKey: null }),
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to clear LLM key:', error);
        return;
      }

      const data = (await res.json()) as LlmSettings;
      setLlmSettings(data);
      setLlmRoutingDraft(data.routing?.draft ?? DEFAULT_ROUTING);
      setLlmRoutingActive(data.routing?.active ?? DEFAULT_ROUTING);
      setLlmEnabledModelIds(
        data.routing?.enabledModelIds && data.routing.enabledModelIds.length > 0
          ? data.routing.enabledModelIds
          : (data.availableModels ?? []).map((model) => model.id)
      );
      setLlmApiKey('');
    } catch (err) {
      console.error('Failed to clear LLM key:', err);
    } finally {
      setSavingLlm(false);
    }
  };

  const loadSystemPrompt = async () => {
    setLoadingPrompt(true);
    try {
      const res = await fetch('/api/settings/system-prompt', {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = (await res.json()) as { defaultSystemPrompt?: string };
      setDefaultSystemPrompt(
        data.defaultSystemPrompt ||
          'You are Clifford, a very skilled and highly complex AI-Assistent!'
      );
    } catch (err) {
      console.error('Failed to load system prompt:', err);
    } finally {
      setLoadingPrompt(false);
    }
  };

  const saveSystemPrompt = async () => {
    setSavingPrompt(true);
    try {
      const res = await fetch('/api/settings/system-prompt', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify({
          defaultSystemPrompt: defaultSystemPrompt.trim() || null,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to save system prompt:', error);
        return;
      }

      const data = (await res.json()) as { defaultSystemPrompt?: string };
      if (data.defaultSystemPrompt) {
        setDefaultSystemPrompt(data.defaultSystemPrompt);
      }
    } catch (err) {
      console.error('Failed to save system prompt:', err);
    } finally {
      setSavingPrompt(false);
    }
  };

  const loadContextBridge = async () => {
    setLoadingBridge(true);
    try {
      const res = await fetch('/api/settings/context-bridge', {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = (await res.json()) as { enabled?: boolean; limit?: number };
      setContextBridgeEnabled(data.enabled ?? true);
      setContextBridgeLimit(String(data.limit ?? 12));
    } catch (err) {
      console.error('Failed to load context bridge settings:', err);
    } finally {
      setLoadingBridge(false);
    }
  };

  const saveContextBridge = async () => {
    setSavingBridge(true);
    try {
      const payload: { enabled?: boolean; limit?: number } = {
        enabled: contextBridgeEnabled,
      };
      const parsedLimit = Number(contextBridgeLimit);
      if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
        payload.limit = parsedLimit;
      }

      const res = await fetch('/api/settings/context-bridge', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to save context bridge settings:', error);
        return;
      }

      const data = (await res.json()) as { enabled?: boolean; limit?: number };
      setContextBridgeEnabled(data.enabled ?? true);
      setContextBridgeLimit(String(data.limit ?? 12));
    } catch (err) {
      console.error('Failed to save context bridge settings:', err);
    } finally {
      setSavingBridge(false);
    }
  };

  const updateRoutingDraft = (
    phase: keyof ModelRoutingConfig,
    field: keyof RoutingModelSpec,
    value: string
  ) => {
    setLlmRoutingDraft((prev) => ({
      ...prev,
      [phase]: {
        ...prev[phase],
        [field]: field === 'fallbackModel' ? value || null : value,
      },
    }));
  };

  const enabledModelOptions = (llmSettings?.availableModels ?? []).filter((model) =>
    llmEnabledModelIds.includes(model.id)
  );

  const toggleModelEnabled = (modelId: string) => {
    setLlmEnabledModelIds((prev) => {
      const next = prev.includes(modelId)
        ? prev.filter((id) => id !== modelId)
        : [...prev, modelId];

      if (next.length === 0) {
        return prev;
      }

      setLlmRoutingDraft((draft) => {
        const fallbackModelId = next[0] ?? modelId;
        const alignPhase = (phase: RoutingModelSpec): RoutingModelSpec => {
          const model = next.includes(phase.model) ? phase.model : fallbackModelId;
          const fallback =
            phase.fallbackModel &&
            next.includes(phase.fallbackModel) &&
            phase.fallbackModel !== model
              ? phase.fallbackModel
              : null;
          return {
            ...phase,
            model,
            fallbackModel: fallback,
          };
        };

        return {
          planner: alignPhase(draft.planner),
          executor: alignPhase(draft.executor),
          verifier: alignPhase(draft.verifier),
        };
      });

      return next;
    });
  };

  const hasDraftChanges =
    JSON.stringify(llmRoutingDraft) !== JSON.stringify(llmRoutingActive) ||
    JSON.stringify(llmEnabledModelIds) !==
      JSON.stringify(llmSettings?.routing?.enabledModelIds ?? []) ||
    autoSelectLowestCost !== (llmSettings?.autoSelectLowestCost ?? true);

  const enabledCount = llmEnabledModelIds.length;
  const totalModelCount = llmSettings?.availableModels.length ?? 0;

  const activeSummary = useMemo(() => {
    const activeAt = llmSettings?.routing?.activatedAt;
    if (!activeAt) return 'No active routing timestamp yet';
    return `Activated ${new Date(activeAt).toLocaleString()}`;
  }, [llmSettings?.routing?.activatedAt]);

  return (
    <div className="relative space-y-6 pb-10">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-24 right-[-10%] h-64 w-64 rounded-full bg-cyan-500/15 blur-3xl" />
        <div className="absolute top-1/3 left-[-8%] h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <Card className="overflow-hidden border-0 bg-gradient-to-br from-slate-900 via-cyan-900 to-emerald-900 text-white shadow-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs">
                <Sparkles className="h-3.5 w-3.5" />
                Settings Control Center
              </div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Settings</h1>
              <p className="max-w-2xl text-sm text-white/80 sm:text-base">
                Tune model routing, activation flow, context behavior, and account preferences in one place.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs sm:text-sm">
              <div className="rounded-lg border border-white/15 bg-white/10 px-3 py-2">
                <p className="text-white/70">Enabled models</p>
                <p className="font-semibold">{enabledCount}/{totalModelCount}</p>
              </div>
              <div className="rounded-lg border border-white/15 bg-white/10 px-3 py-2">
                <p className="text-white/70">Draft status</p>
                <p className="font-semibold">{hasDraftChanges ? 'Needs activation' : 'In sync'}</p>
              </div>
              <div className="rounded-lg border border-white/15 bg-white/10 px-3 py-2">
                <p className="text-white/70">Provider</p>
                <p className="font-semibold">OpenAI</p>
              </div>
              <div className="rounded-lg border border-white/15 bg-white/10 px-3 py-2">
                <p className="text-white/70">API key</p>
                <p className="font-semibold">{llmSettings?.hasApiKey ? 'Configured' : 'Missing'}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">AI & Agents</h2>
        <p className="text-sm text-muted-foreground">
          Configure model access, routing policy, and activation workflow.
        </p>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
        <div className="space-y-6">
          <Card className="border-cyan-500/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BrainCircuit className="h-5 w-5 text-cyan-500" />
                Model Access
              </CardTitle>
              <CardDescription>
                Enable only the models this workspace is allowed to use.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {(llmSettings?.availableModels ?? []).map((modelInfo) => {
                  const enabled = llmEnabledModelIds.includes(modelInfo.id);
                  return (
                    <div
                      key={modelInfo.id}
                      className={cn(
                        'rounded-xl border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm',
                        enabled ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-border bg-card'
                      )}
                    >
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <div>
                          <p className="font-medium leading-tight">{modelInfo.name}</p>
                          <p className="text-xs text-muted-foreground">{modelInfo.id}</p>
                        </div>
                        <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', costClass(modelInfo.costLevel))}>
                          {modelInfo.costLevel}
                        </span>
                      </div>
                      <p className="mb-3 text-xs text-muted-foreground">{modelInfo.bestFor}</p>
                      <Button
                        type="button"
                        size="sm"
                        variant={enabled ? 'default' : 'outline'}
                        onClick={() => toggleModelEnabled(modelInfo.id)}
                        disabled={
                          loadingLlm ||
                          (llmEnabledModelIds.length === 1 && llmEnabledModelIds.includes(modelInfo.id))
                        }
                        className="w-full"
                      >
                        {enabled ? 'Enabled' : 'Disabled'}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                At least one model must stay enabled.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Phase Routing</CardTitle>
              <CardDescription>
                Choose model behavior for planning, execution, and verification.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-xl border bg-muted/40 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">Auto-select lowest cost model</p>
                  <p className="text-xs text-muted-foreground">
                    Uses the cheapest enabled model that still meets quality floor for the phase.
                  </p>
                </div>
                <Button
                  variant={autoSelectLowestCost ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setAutoSelectLowestCost((value) => !value)}
                  disabled={loadingLlm}
                >
                  {autoSelectLowestCost ? 'Enabled' : 'Disabled'}
                </Button>
              </div>

              <div className="grid gap-4">
                {PHASES.map((phase) => (
                  <div key={phase} className="rounded-xl border p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-semibold capitalize">{phase}</p>
                      <span className="rounded-full bg-muted px-2 py-1 text-[11px] uppercase text-muted-foreground">
                        {phase === 'planner' ? 'reasoning' : phase === 'executor' ? 'actions' : 'validation'}
                      </span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium">Primary model</label>
                        <select
                          value={llmRoutingDraft[phase].model}
                          onChange={(e) => updateRoutingDraft(phase, 'model', e.target.value)}
                          disabled={loadingLlm}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          {enabledModelOptions.map((modelInfo) => (
                            <option key={`${phase}-primary-${modelInfo.id}`} value={modelInfo.id}>
                              {modelInfo.name} ({modelInfo.costLevel})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium">Fallback model</label>
                        <select
                          value={llmRoutingDraft[phase].fallbackModel ?? ''}
                          onChange={(e) => updateRoutingDraft(phase, 'fallbackModel', e.target.value)}
                          disabled={loadingLlm}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">None</option>
                          {enabledModelOptions
                            .filter((modelInfo) => modelInfo.id !== llmRoutingDraft[phase].model)
                            .map((modelInfo) => (
                              <option key={`${phase}-fallback-${modelInfo.id}`} value={modelInfo.id}>
                                {modelInfo.name} ({modelInfo.costLevel})
                              </option>
                            ))}
                        </select>
                      </div>
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <label className="text-xs font-medium">Phase instruction</label>
                      <Input
                        value={llmRoutingDraft[phase].instruction}
                        onChange={(e) => updateRoutingDraft(phase, 'instruction', e.target.value)}
                        placeholder="Short policy instruction"
                        disabled={loadingLlm}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>System Instructions</CardTitle>
              <CardDescription>
                Global behavior prompt applied to new contexts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <textarea
                id="system-prompt"
                className="min-h-[150px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={defaultSystemPrompt}
                onChange={(e) => setDefaultSystemPrompt(e.target.value)}
                placeholder="You are Clifford, a very skilled and highly complex AI-Assistent!"
                disabled={loadingPrompt}
              />
              <div className="flex justify-end">
                <Button onClick={saveSystemPrompt} disabled={savingPrompt || loadingPrompt}>
                  {savingPrompt ? 'Saving…' : 'Save Instructions'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 xl:sticky xl:top-6 xl:h-fit">
          <Card className="border-emerald-500/25">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-emerald-500" />
                Activation Panel
              </CardTitle>
              <CardDescription>
                Draft changes are inert until activation.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={cn(
                  'rounded-lg border px-3 py-2 text-sm',
                  hasDraftChanges
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                )}
              >
                {hasDraftChanges ? (
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    Draft differs from active config.
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    Draft and active config are in sync.
                  </div>
                )}
              </div>

              <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {activeSummary}
              </div>

              <div className="space-y-2">
                <label htmlFor="llm-key" className="text-sm font-medium">
                  API Key
                </label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="llm-key"
                    type="password"
                    className="pl-9"
                    value={llmApiKey}
                    onChange={(e) => setLlmApiKey(e.target.value)}
                    placeholder={
                      llmSettings?.hasApiKey
                        ? `Stored (ends with ${llmSettings.apiKeyLast4 ?? '????'})`
                        : 'sk-...'
                    }
                    disabled={loadingLlm}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Stored encrypted server-side. Not persisted in client state.
                </p>
              </div>

              <div className="grid gap-2">
                <Button onClick={saveLlmSettings} disabled={savingLlm || loadingLlm}>
                  {savingLlm ? 'Saving…' : 'Save Draft'}
                </Button>
                <Button
                  onClick={activateLlmRouting}
                  disabled={savingLlm || loadingLlm || !hasDraftChanges}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  {savingLlm ? 'Saving…' : 'Activate Draft'}
                </Button>
                <Button
                  variant="outline"
                  onClick={clearLlmKey}
                  disabled={savingLlm || !llmSettings?.hasApiKey}
                >
                  Clear API Key
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Provider Routing (Planned)</CardTitle>
              <CardDescription>Roadmap preview for multi-provider orchestration.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                Multiple providers (for example OpenAI + Claude) will be added later so routing can
                choose across providers. Current setup keeps a single provider active by design.
              </div>
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-3 text-xs text-cyan-800 dark:text-cyan-200">
                No behavior changes here yet. This is a roadmap placeholder only.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">Workspace</h2>
        <p className="text-sm text-muted-foreground">
          Theme and shared context behavior for this environment.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Choose your preferred theme.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3">
              <button
                onClick={() => setTheme('light')}
                className={cn(
                  'flex items-center justify-between rounded-lg border-2 p-3 text-left transition-all hover:shadow-sm',
                  theme === 'light'
                    ? 'border-cyan-500 bg-cyan-500/10'
                    : 'border-border hover:border-cyan-500/40'
                )}
              >
                <div>
                  <p className="text-sm font-medium">Light</p>
                  <p className="text-xs text-muted-foreground">Bright interface</p>
                </div>
                <Sun className="h-4 w-4" />
              </button>

              <button
                onClick={() => setTheme('dark')}
                className={cn(
                  'flex items-center justify-between rounded-lg border-2 p-3 text-left transition-all hover:shadow-sm',
                  theme === 'dark'
                    ? 'border-cyan-500 bg-cyan-500/10'
                    : 'border-border hover:border-cyan-500/40'
                )}
              >
                <div>
                  <p className="text-sm font-medium">Dark</p>
                  <p className="text-xs text-muted-foreground">Low-light mode</p>
                </div>
                <Moon className="h-4 w-4" />
              </button>

              <button
                onClick={() => setTheme('system')}
                className={cn(
                  'flex items-center justify-between rounded-lg border-2 p-3 text-left transition-all hover:shadow-sm',
                  theme === 'system'
                    ? 'border-cyan-500 bg-cyan-500/10'
                    : 'border-border hover:border-cyan-500/40'
                )}
              >
                <div>
                  <p className="text-sm font-medium">System</p>
                  <p className="text-xs text-muted-foreground">Follow device</p>
                </div>
                <Monitor className="h-4 w-4" />
              </button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cross-Channel Context</CardTitle>
            <CardDescription>Share active context across channels.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Context Bridge</p>
                <p className="text-xs text-muted-foreground">Include active history from other channels.</p>
              </div>
              <Button
                variant={contextBridgeEnabled ? 'default' : 'outline'}
                size="sm"
                onClick={() => setContextBridgeEnabled(!contextBridgeEnabled)}
                disabled={loadingBridge}
              >
                {contextBridgeEnabled ? 'Enabled' : 'Disabled'}
              </Button>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="context-bridge-limit" className="text-xs font-medium">
                Message limit per channel
              </label>
              <Input
                id="context-bridge-limit"
                type="number"
                min="1"
                max="50"
                value={contextBridgeLimit}
                onChange={(e) => setContextBridgeLimit(e.target.value)}
                disabled={loadingBridge}
              />
            </div>

            <Button onClick={saveContextBridge} disabled={savingBridge || loadingBridge}>
              {savingBridge ? 'Saving…' : 'Save Context Bridge'}
            </Button>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">Account</h2>
        <p className="text-sm text-muted-foreground">
          Profile identity, notifications, and account-level safety actions.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Basic identity shown in app surfaces.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="name" className="text-xs font-medium">
                Name
              </label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="email" className="text-xs font-medium">
                Email
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <Button>Save Profile</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notifications</CardTitle>
            <CardDescription>Control alert delivery preferences.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Email notifications</p>
                <p className="text-xs text-muted-foreground">Receive activity updates by email.</p>
              </div>
              <Button
                variant={notifications ? 'default' : 'outline'}
                size="sm"
                onClick={() => setNotifications(!notifications)}
              >
                {notifications ? 'Enabled' : 'Disabled'}
              </Button>
            </div>

            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p className="mb-2 text-sm font-medium text-destructive">Danger Zone</p>
              <p className="mb-3 text-xs text-muted-foreground">
                Permanently delete your account and settings.
              </p>
              <Button variant="destructive">Delete Account</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
