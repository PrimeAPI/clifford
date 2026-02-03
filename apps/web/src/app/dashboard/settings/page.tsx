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
  const [llmApiKey, setLlmApiKey] = useState('');
  const [savingLlm, setSavingLlm] = useState(false);
  const [loadingLlm, setLoadingLlm] = useState(true);

  useEffect(() => {
    loadLlmSettings();
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
    } catch (err) {
      console.error('Failed to load LLM settings:', err);
    } finally {
      setLoadingLlm(false);
    }
  };

  const saveLlmSettings = async () => {
    setSavingLlm(true);
    try {
      const payload: { provider?: string; model?: string; apiKey?: string | null } = {
        provider: 'openai',
        model: llmModel.trim(),
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
