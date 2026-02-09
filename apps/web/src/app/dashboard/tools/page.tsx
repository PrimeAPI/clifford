'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Brain,
  Calculator,
  CloudSun,
  Database,
  FileText,
  Globe,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

type ToolField = {
  key: string;
  label: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'secret' | 'select';
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
};

type ToolInfo = {
  name: string;
  icon?: string;
  shortDescription: string;
  longDescription: string;
  commands: Array<{ name: string; shortDescription: string }>;
  configFields: ToolField[];
  activation: {
    requiresConfiguration: boolean;
    canActivate: boolean;
    missingRequiredFields: string[];
  };
  enabled: boolean;
  pinned: boolean;
  important: boolean;
  config: Record<string, unknown>;
};

const TOOL_ICON_MAP: Record<string, LucideIcon> = {
  system: ShieldCheck,
  tools: Wrench,
  memory: Brain,
  reminders: Bell,
  weather: CloudSun,
  retrieval: Database,
  web: Globe,
  compute: Calculator,
  files: FileText,
  globe: Globe,
  calculator: Calculator,
  bell: Bell,
  'cloud-sun': CloudSun,
  database: Database,
  'file-text': FileText,
  'shield-check': ShieldCheck,
  wrench: Wrench,
  brain: Brain,
};

function getToolIcon(tool: ToolInfo): LucideIcon {
  return TOOL_ICON_MAP[tool.icon ?? ''] ?? TOOL_ICON_MAP[tool.name] ?? Sparkles;
}

function isEmptyValue(value: unknown) {
  return value === undefined || value === null || value === '';
}

function formatDefaultValue(value: string | number | boolean | undefined) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [availableDialogOpen, setAvailableDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSearch, setActiveSearch] = useState('');
  const [availableSearch, setAvailableSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});

  useEffect(() => {
    void loadTools();
  }, []);

  const loadTools = async (preserveSelection = true) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tools', {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `Failed to load tools (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as { tools: ToolInfo[] };
      const loadedTools = data.tools || [];
      setTools(loadedTools);

      setDrafts((prev) => {
        const nextDrafts: Record<string, Record<string, unknown>> = {};
        for (const tool of loadedTools) {
          nextDrafts[tool.name] = {
            ...(prev[tool.name] ?? {}),
            ...(tool.config ?? {}),
          };
        }
        return nextDrafts;
      });

      if (!preserveSelection || !selectedToolName) {
        const firstActive = loadedTools.find((tool) => tool.enabled);
        const firstTool = loadedTools[0];
        setSelectedToolName(firstActive?.name ?? firstTool?.name ?? null);
        return;
      }

      const stillExists = loadedTools.some((tool) => tool.name === selectedToolName);
      if (!stillExists) {
        const fallback = loadedTools.find((tool) => tool.enabled) ?? loadedTools[0];
        setSelectedToolName(fallback?.name ?? null);
      }
    } catch {
      setError('Failed to load tools. API may be offline.');
    } finally {
      setLoading(false);
    }
  };

  const saveTool = async (tool: ToolInfo, updates: Partial<ToolInfo>) => {
    setSaving(tool.name);
    setError(null);
    try {
      const payload = {
        enabled: updates.enabled ?? tool.enabled,
        pinned: updates.pinned ?? tool.pinned,
        important: updates.important ?? tool.important,
        config: drafts[tool.name] ?? tool.config,
      };
      const res = await fetch(`/api/tools/${tool.name}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data?.missingRequiredFields) && data.missingRequiredFields.length > 0) {
          setError(`Missing required configuration: ${data.missingRequiredFields.join(', ')}`);
        } else {
          setError(data?.error ?? `Failed to save tool settings (HTTP ${res.status}).`);
        }
        return;
      }

      await loadTools();
    } catch {
      setError('Failed to save tool settings.');
    } finally {
      setSaving(null);
    }
  };

  const updateDraft = (toolName: string, key: string, value: unknown) => {
    setDrafts((prev) => ({
      ...prev,
      [toolName]: {
        ...(prev[toolName] ?? {}),
        [key]: value,
      },
    }));
  };

  const clearDraftField = (toolName: string, key: string) => {
    setDrafts((prev) => {
      const next = { ...(prev[toolName] ?? {}) };
      delete next[key];
      return {
        ...prev,
        [toolName]: next,
      };
    });
  };

  const sortedTools = useMemo(() => [...tools].sort((a, b) => a.name.localeCompare(b.name)), [tools]);

  const activeTools = useMemo(() => {
    const query = activeSearch.trim().toLowerCase();
    return sortedTools.filter(
      (tool) =>
        tool.enabled &&
        (query.length === 0 ||
          tool.name.toLowerCase().includes(query) ||
          tool.shortDescription.toLowerCase().includes(query))
    );
  }, [sortedTools, activeSearch]);

  const availableTools = useMemo(() => {
    const query = availableSearch.trim().toLowerCase();
    return sortedTools.filter(
      (tool) =>
        !tool.enabled &&
        (query.length === 0 ||
          tool.name.toLowerCase().includes(query) ||
          tool.shortDescription.toLowerCase().includes(query))
    );
  }, [sortedTools, availableSearch]);

  const availableCount = useMemo(
    () => sortedTools.filter((tool) => !tool.enabled).length,
    [sortedTools]
  );
  const highlightedTools = useMemo(
    () => activeTools.filter((tool) => tool.pinned || tool.important),
    [activeTools]
  );

  const selectedTool = useMemo(
    () => sortedTools.find((tool) => tool.name === selectedToolName) ?? null,
    [sortedTools, selectedToolName]
  );

  const openToolSettings = (toolName: string) => {
    setSelectedToolName(toolName);
    setDrawerOpen(true);
  };

  const renderToolCard = (tool: ToolInfo, inactive = false) => {
    const Icon = getToolIcon(tool);
    const isSelected = selectedToolName === tool.name;

    return (
      <button
        type="button"
        key={tool.name}
        onClick={() => openToolSettings(tool.name)}
        className={`group h-[128px] rounded-lg border p-2.5 text-left transition ${
          isSelected && drawerOpen
            ? 'border-primary bg-primary/5 shadow-sm'
            : 'border-border bg-card hover:border-primary/40 hover:bg-muted/40'
        }`}
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="flex flex-wrap justify-end gap-1">
            {inactive ? null : (
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                Active
              </span>
            )}
            {tool.activation.requiresConfiguration ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                Needs setup
              </span>
            ) : null}
            {tool.pinned ? (
              <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                Pinned
              </span>
            ) : null}
            {tool.important ? (
              <span className="rounded-full bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-700 dark:text-fuchsia-300">
                Important
              </span>
            ) : null}
          </div>
        </div>
        <p className="truncate text-sm font-semibold leading-tight">{tool.name}</p>
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
          {tool.shortDescription}
        </p>
        {inactive ? (
          <div className="mt-2">
            <Button
              size="sm"
              className="h-7 w-full text-xs"
              onClick={(event) => {
                event.stopPropagation();
                setAvailableDialogOpen(false);
                openToolSettings(tool.name);
              }}
            >
              Configure
            </Button>
          </div>
        ) : null}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-xl font-semibold">Tools</h1>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            Active {activeTools.length}
          </span>
          <Button
            variant="default"
            size="sm"
            onClick={() => setAvailableDialogOpen(true)}
            className="h-9"
          >
            {`Add tools (${availableCount})`}
          </Button>
          <div className="ml-auto w-full sm:w-auto">
            <Input
              value={activeSearch}
              onChange={(e) => setActiveSearch(e.target.value)}
              placeholder="Search active tools"
              className="h-9 w-full sm:w-72"
            />
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? <div className="text-sm text-muted-foreground">Loading tools...</div> : null}

      {!loading ? (
        <>
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Active Tools ({activeTools.length})
            </h2>
            {activeTools.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                No active tools match your search.
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
                {activeTools.map((tool) => renderToolCard(tool))}
              </div>
            )}
          </section>

          {highlightedTools.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pinned & Important ({highlightedTools.length})
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
                {highlightedTools.map((tool) => (
                  <div
                    key={`highlight-${tool.name}`}
                    className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{tool.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{tool.shortDescription}</p>
                    </div>
                    <div className="ml-2 flex gap-1">
                      {tool.pinned ? (
                        <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                          Pinned
                        </span>
                      ) : null}
                      {tool.important ? (
                        <span className="rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-[10px] font-medium text-fuchsia-700 dark:text-fuchsia-300">
                          Important
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

        </>
      ) : null}

      {availableDialogOpen ? (
        <>
          <button
            type="button"
            aria-label="Close available tools dialog"
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]"
            onClick={() => setAvailableDialogOpen(false)}
          />
          <div className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(900px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-background shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <p className="text-base font-semibold">Available Tools ({availableTools.length})</p>
                <p className="text-xs text-muted-foreground">
                  Pick a tool to configure it, then activate it in settings.
                </p>
              </div>
              <Button size="icon" variant="ghost" onClick={() => setAvailableDialogOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="border-b border-border px-4 py-3">
              <Input
                value={availableSearch}
                onChange={(e) => setAvailableSearch(e.target.value)}
                placeholder="Search available tools"
                className="h-9 w-full"
              />
            </div>
            <div className="max-h-[56vh] overflow-y-auto p-4">
              {availableTools.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                  No inactive tools match your search.
                </div>
              ) : (
                <div className="space-y-2">
                  {availableTools.map((tool) => {
                    const Icon = getToolIcon(tool);
                    return (
                      <div
                        key={`available-${tool.name}`}
                        className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                      >
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold">{tool.name}</p>
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                                tool.activation.requiresConfiguration
                                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                  : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              }`}
                            >
                              {tool.activation.requiresConfiguration ? 'Needs setup' : 'Ready'}
                            </span>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {tool.shortDescription}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8"
                          onClick={() => {
                            setAvailableDialogOpen(false);
                            openToolSettings(tool.name);
                          }}
                        >
                          Configure
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}

      {drawerOpen && selectedTool ? (
        <>
          <button
            type="button"
            aria-label="Close settings"
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="fixed inset-y-0 right-0 z-50 w-full border-l border-border bg-background shadow-2xl sm:w-[min(520px,38vw)]">
            <div className="flex h-full flex-col">
              <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
                <div>
                  <p className="text-lg font-semibold">{selectedTool.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedTool.commands.length} commands
                  </p>
                </div>
                <Button size="icon" variant="ghost" onClick={() => setDrawerOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
                <p className="text-sm text-muted-foreground">{selectedTool.longDescription}</p>

                {selectedTool.activation.requiresConfiguration ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                    Missing required settings: {selectedTool.activation.missingRequiredFields.join(', ')}
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={selectedTool.enabled ? 'outline' : 'default'}
                    size="sm"
                    disabled={saving === selectedTool.name}
                    onClick={() => saveTool(selectedTool, { enabled: !selectedTool.enabled })}
                  >
                    {selectedTool.enabled ? 'Deactivate' : 'Activate'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving === selectedTool.name || !selectedTool.enabled}
                    onClick={() =>
                      saveTool(selectedTool, {
                        pinned: !selectedTool.pinned,
                        important: false,
                      })
                    }
                  >
                    {selectedTool.pinned ? 'Unpin' : 'Pin'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving === selectedTool.name || !selectedTool.enabled}
                    onClick={() =>
                      saveTool(selectedTool, {
                        important: !selectedTool.important,
                        pinned: false,
                      })
                    }
                  >
                    {selectedTool.important ? 'Unmark Important' : 'Mark Important'}
                  </Button>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold">Configuration</p>
                    <Button
                      size="sm"
                      disabled={saving === selectedTool.name}
                      onClick={() => saveTool(selectedTool, {})}
                    >
                      {saving === selectedTool.name ? 'Saving...' : 'Save settings'}
                    </Button>
                  </div>

                  {selectedTool.configFields.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No settings available.</p>
                  ) : (
                    <div className="grid gap-2.5 md:grid-cols-2">
                      {selectedTool.configFields.map((field) => {
                        const draft = drafts[selectedTool.name] ?? {};
                        const rawValue = draft[field.key];
                        const defaultLabel = formatDefaultValue(field.defaultValue);
                        const clearable = !isEmptyValue(rawValue);
                        const usingDefault = !clearable && Boolean(defaultLabel);

                        return (
                          <div key={field.key} className="rounded-md border border-border p-2.5">
                            <div className="mb-1.5 flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-medium">{field.label}</p>
                                <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                                  {field.description}
                                </p>
                              </div>
                              <div className="flex flex-wrap justify-end gap-1">
                                {field.required ? (
                                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                    Required
                                  </span>
                                ) : null}
                                {defaultLabel ? (
                                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    Default: {defaultLabel}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            {field.type === 'boolean' ? (
                              <button
                                type="button"
                                onClick={() => updateDraft(selectedTool.name, field.key, !Boolean(rawValue))}
                                className={`inline-flex h-9 w-full items-center justify-between rounded-md border px-2.5 text-sm transition ${
                                  Boolean(rawValue)
                                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                    : 'border-border bg-background text-muted-foreground'
                                }`}
                              >
                                <span>{Boolean(rawValue) ? 'Enabled' : 'Disabled'}</span>
                                <span
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
                                    Boolean(rawValue) ? 'bg-emerald-500' : 'bg-muted'
                                  }`}
                                >
                                  <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                                      Boolean(rawValue) ? 'translate-x-4' : 'translate-x-0.5'
                                    }`}
                                  />
                                </span>
                              </button>
                            ) : field.type === 'select' ? (
                              <select
                                className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm"
                                value={(rawValue as string) ?? ''}
                                onChange={(e) => updateDraft(selectedTool.name, field.key, e.target.value)}
                              >
                                <option value="">
                                  {defaultLabel ? `Use default (${defaultLabel})` : 'Use default'}
                                </option>
                                {(field.options ?? []).map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <Input
                                type={
                                  field.type === 'number'
                                    ? 'number'
                                    : field.type === 'secret'
                                      ? 'password'
                                      : 'text'
                                }
                                value={
                                  typeof rawValue === 'string' || typeof rawValue === 'number'
                                    ? rawValue
                                    : ''
                                }
                                onChange={(e) => {
                                  if (field.type === 'number') {
                                    const next = e.target.value;
                                    updateDraft(
                                      selectedTool.name,
                                      field.key,
                                      next === '' ? undefined : Number(next)
                                    );
                                    return;
                                  }
                                  updateDraft(selectedTool.name, field.key, e.target.value);
                                }}
                                min={field.min}
                                max={field.max}
                                className="h-9"
                                placeholder={
                                  field.required ? 'Required' : 'Optional'
                                }
                              />
                            )}

                            <div className="mt-1.5 flex items-center justify-between gap-2">
                              <p className="text-[10px] text-muted-foreground">
                                {usingDefault
                                  ? `Using default: ${defaultLabel}`
                                  : field.type === 'number' &&
                                      field.min !== undefined &&
                                      field.max !== undefined
                                    ? `${field.min} to ${field.max}`
                                    : ' '}
                              </p>
                              {clearable ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => clearDraftField(selectedTool.name, field.key)}
                                >
                                  Clear
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
