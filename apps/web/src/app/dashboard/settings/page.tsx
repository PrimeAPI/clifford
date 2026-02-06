'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTheme } from '@/components/theme-provider';
import { Moon, Sun, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LlmSettings {
  provider: string;
  model: string;
  fallbackModel: string | null;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
}

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState('Demo User');
  const [email, setEmail] = useState('demo@clifford.ai');
  const [notifications, setNotifications] = useState(true);

  const [llmSettings, setLlmSettings] = useState<LlmSettings | null>(null);
  const [llmModel, setLlmModel] = useState('gpt-4o-mini');
  const [llmFallbackModel, setLlmFallbackModel] = useState('');
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
    loadLlmSettings();
    loadSystemPrompt();
    loadContextBridge();
  }, []);

  const loadLlmSettings = async () => {
    setLoadingLlm(true);
    try {
      const res = await fetch('/api/settings/llm', {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = (await res.json()) as LlmSettings;
      setLlmSettings(data);
      setLlmModel(data.model || 'gpt-4o-mini');
      setLlmFallbackModel(data.fallbackModel ?? '');
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
        model?: string;
        fallbackModel?: string | null;
        apiKey?: string | null;
      } = {
        provider: 'openai',
        model: llmModel.trim(),
        fallbackModel: llmFallbackModel.trim() || null,
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
      setLlmApiKey('');
    } catch (err) {
      console.error('Failed to save LLM settings:', err);
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account settings and preferences.</p>
      </div>

      {/* Profile Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Update your personal information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
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

          <Button>Save Changes</Button>
        </CardContent>
      </Card>

      {/* LLM Settings */}
      <Card>
        <CardHeader>
          <CardTitle>LLM Settings</CardTitle>
          <CardDescription>Configure the OpenAI model and API token</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Provider</label>
            <Input value="OpenAI" disabled />
          </div>
          <div className="space-y-2">
            <label htmlFor="llm-model" className="text-sm font-medium">
              Model
            </label>
            <Input
              id="llm-model"
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              placeholder="gpt-4o-mini"
              disabled={loadingLlm}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="llm-fallback-model" className="text-sm font-medium">
              Fallback Model
            </label>
            <Input
              id="llm-fallback-model"
              value={llmFallbackModel}
              onChange={(e) => setLlmFallbackModel(e.target.value)}
              placeholder="gpt-4o-mini"
              disabled={loadingLlm}
            />
            <p className="text-xs text-muted-foreground">
              Used if the default model errors or rate limits.
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="llm-key" className="text-sm font-medium">
              API Key
            </label>
            <Input
              id="llm-key"
              type="password"
              value={llmApiKey}
              onChange={(e) => setLlmApiKey(e.target.value)}
              placeholder={
                llmSettings?.hasApiKey
                  ? `Stored (ends with ${llmSettings.apiKeyLast4 ?? '????'})`
                  : 'sk-...'
              }
              disabled={loadingLlm}
            />
            <p className="text-xs text-muted-foreground">
              Keys are encrypted using the server encryption key and never stored in plaintext.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={saveLlmSettings} disabled={savingLlm || loadingLlm}>
              {savingLlm ? 'Saving…' : 'Save LLM Settings'}
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

      {/* System Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>System Instructions</CardTitle>
          <CardDescription>Default context prompt for Clifford</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="system-prompt" className="text-sm font-medium">
              Default Instructions
            </label>
            <textarea
              id="system-prompt"
              className="min-h-[120px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={defaultSystemPrompt}
              onChange={(e) => setDefaultSystemPrompt(e.target.value)}
              placeholder="You are Clifford, a very skilled and highly complex AI-Assistent!"
              disabled={loadingPrompt}
            />
            <p className="text-xs text-muted-foreground">
              This prompt is injected at the start of every new context.
            </p>
          </div>
          <Button onClick={saveSystemPrompt} disabled={savingPrompt || loadingPrompt}>
            {savingPrompt ? 'Saving…' : 'Save System Instructions'}
          </Button>
        </CardContent>
      </Card>

      {/* Cross-Channel Context */}
      <Card>
        <CardHeader>
          <CardTitle>Cross-Channel Context</CardTitle>
          <CardDescription>Let Clifford see active contexts from other channels.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Enable Context Bridge</p>
              <p className="text-sm text-muted-foreground">
                Includes active context history from other channels.
              </p>
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
          <div className="space-y-2">
            <label htmlFor="context-bridge-limit" className="text-sm font-medium">
              Message Limit (per channel)
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
            {savingBridge ? 'Saving…' : 'Save Context Bridge Settings'}
          </Button>
        </CardContent>
      </Card>

      {/* Theme Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose your preferred theme</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <button
              onClick={() => setTheme('light')}
              className={cn(
                'flex flex-col items-center gap-3 rounded-lg border-2 p-4 transition-colors',
                theme === 'light'
                  ? 'border-primary bg-accent'
                  : 'border-border hover:border-muted-foreground'
              )}
            >
              <Sun className="h-6 w-6" />
              <span className="text-sm font-medium">Light</span>
            </button>

            <button
              onClick={() => setTheme('dark')}
              className={cn(
                'flex flex-col items-center gap-3 rounded-lg border-2 p-4 transition-colors',
                theme === 'dark'
                  ? 'border-primary bg-accent'
                  : 'border-border hover:border-muted-foreground'
              )}
            >
              <Moon className="h-6 w-6" />
              <span className="text-sm font-medium">Dark</span>
            </button>

            <button
              onClick={() => setTheme('system')}
              className={cn(
                'flex flex-col items-center gap-3 rounded-lg border-2 p-4 transition-colors',
                theme === 'system'
                  ? 'border-primary bg-accent'
                  : 'border-border hover:border-muted-foreground'
              )}
            >
              <Monitor className="h-6 w-6" />
              <span className="text-sm font-medium">System</span>
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>Manage your notification preferences</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Email Notifications</p>
              <p className="text-sm text-muted-foreground">
                Receive emails about your agent activity
              </p>
            </div>
            <Button
              variant={notifications ? 'default' : 'outline'}
              size="sm"
              onClick={() => setNotifications(!notifications)}
            >
              {notifications ? 'Enabled' : 'Disabled'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>Irreversible actions for your account</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive">Delete Account</Button>
        </CardContent>
      </Card>
    </div>
  );
}
