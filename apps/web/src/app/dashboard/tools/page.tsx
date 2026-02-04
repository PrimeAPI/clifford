'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronRight } from 'lucide-react';

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

type ToolField = {
  key: string;
  label: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'secret' | 'select';
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
};

type ToolInfo = {
  name: string;
  shortDescription: string;
  longDescription: string;
  commands: Array<{ name: string; shortDescription: string }>;
  configFields: ToolField[];
  enabled: boolean;
  pinned: boolean;
  important: boolean;
  config: Record<string, unknown>;
};

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});

  useEffect(() => {
    loadTools();
  }, []);

  const loadTools = async () => {
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
      setTools(data.tools || []);
      const nextDrafts: Record<string, Record<string, unknown>> = {};
      for (const tool of data.tools || []) {
        nextDrafts[tool.name] = { ...(tool.config ?? {}) };
      }
      setDrafts(nextDrafts);
    } catch (err) {
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
        setError(data?.error ?? `Failed to save tool settings (HTTP ${res.status}).`);
        return;
      }

      await loadTools();
    } catch (err) {
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

  const sortedTools = useMemo(() => {
    return [...tools].sort((a, b) => a.name.localeCompare(b.name));
  }, [tools]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Tools</h1>
        <p className="text-sm text-muted-foreground">
          Enable tools, mark a single pinned or important tool, and configure tool settings.
        </p>
      </div>

      {error ? <div className="text-sm text-destructive">{error}</div> : null}
      {loading ? <div className="text-sm text-muted-foreground">Loading tools…</div> : null}

      <div className="grid gap-4">
        {sortedTools.map((tool) => {
          const isOpen = expanded === tool.name;
          const draft = drafts[tool.name] ?? {};
          return (
            <Card key={tool.name}>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-lg">{tool.name}</CardTitle>
                  <CardDescription>{tool.shortDescription}</CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpanded(isOpen ? null : tool.name)}
                >
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      onChange={(e) => saveTool(tool, { enabled: e.target.checked })}
                      disabled={saving === tool.name}
                    />
                    Enabled
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="pinned-tool"
                      checked={tool.pinned}
                      onChange={() => saveTool(tool, { pinned: true, important: false })}
                      disabled={saving === tool.name || !tool.enabled}
                    />
                    Pinned
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="important-tool"
                      checked={tool.important}
                      onChange={() => saveTool(tool, { important: true, pinned: false })}
                      disabled={saving === tool.name || !tool.enabled}
                    />
                    Important
                  </label>
                </div>

                {isOpen ? (
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm font-medium">Commands</p>
                      <ul className="text-sm text-muted-foreground">
                        {tool.commands.map((command) => (
                          <li key={command.name}>{command.name}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="space-y-3">
                      <p className="text-sm font-medium">Configuration</p>
                      {tool.configFields.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No settings available.</p>
                      ) : (
                        tool.configFields.map((field) => (
                          <div key={field.key} className="space-y-1">
                            <label className="text-sm font-medium">{field.label}</label>
                            <p className="text-xs text-muted-foreground">{field.description}</p>
                            {field.type === 'boolean' ? (
                              <label className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={Boolean(draft[field.key])}
                                  onChange={(e) => updateDraft(tool.name, field.key, e.target.checked)}
                                  disabled={!tool.enabled}
                                />
                                Enabled
                              </label>
                            ) : field.type === 'select' ? (
                              <select
                                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                                value={(draft[field.key] as string) ?? ''}
                                onChange={(e) => updateDraft(tool.name, field.key, e.target.value)}
                                disabled={!tool.enabled}
                              >
                                <option value="">Select…</option>
                                {(field.options ?? []).map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <Input
                                type={field.type === 'number' ? 'number' : field.type === 'secret' ? 'password' : 'text'}
                                value={(draft[field.key] as string | number | undefined) ?? ''}
                                onChange={(e) =>
                                  updateDraft(
                                    tool.name,
                                    field.key,
                                    field.type === 'number'
                                      ? Number(e.target.value)
                                      : e.target.value
                                  )
                                }
                                placeholder={field.required ? 'Required' : ''}
                                disabled={!tool.enabled}
                              />
                            )}
                          </div>
                        ))
                      )}
                    </div>

                    <div className="flex gap-2">
                      <Button
                        onClick={() => saveTool(tool, {})}
                        disabled={saving === tool.name || !tool.enabled}
                      >
                        {saving === tool.name ? 'Saving…' : 'Save Settings'}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
