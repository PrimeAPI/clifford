'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

interface MemoryItem {
  id: string;
  level: number;
  module: string;
  key: string;
  value: string;
  confidence: number;
  pinned: boolean;
  lastSeenAt: string | null;
}

interface MemoryResponse {
  enabled: boolean;
  memories: MemoryItem[];
}

export default function MemoriesPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);
  const [newMemory, setNewMemory] = useState({
    level: '2',
    module: 'preferences',
    key: '',
    value: '',
    confidence: '0.6',
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void loadMemories();
  }, []);

  const loadMemories = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/memories', {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = (await res.json()) as MemoryResponse;
      setMemories(data.memories ?? []);
      setMemoryEnabled(data.enabled ?? true);
    } catch (err) {
      console.error('Failed to load memories', err);
    } finally {
      setLoading(false);
    }
  };

  const saveMemory = async (memory: MemoryItem) => {
    setSavingId(memory.id);
    try {
      const res = await fetch(`/api/memories/${memory.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify({
          level: memory.level,
          module: memory.module,
          key: memory.key,
          value: memory.value,
          confidence: memory.confidence,
          pinned: memory.pinned,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to save memory', error);
        return;
      }

      await loadMemories();
    } catch (err) {
      console.error('Failed to save memory', err);
    } finally {
      setSavingId(null);
    }
  };

  const deleteMemory = async (memoryId: string) => {
    setDeletingId(memoryId);
    try {
      const res = await fetch(`/api/memories/${memoryId}`, {
        method: 'DELETE',
        headers: {
          'X-User-Id': DEMO_USER_ID,
        },
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to delete memory', error);
        return;
      }

      setMemories((prev) => prev.filter((item) => item.id !== memoryId));
    } catch (err) {
      console.error('Failed to delete memory', err);
    } finally {
      setDeletingId(null);
    }
  };

  const toggleMemory = async (next: boolean) => {
    setSavingToggle(true);
    try {
      const res = await fetch('/api/settings/memory', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify({ enabled: next }),
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to toggle memory', error);
        return;
      }

      setMemoryEnabled(next);
      if (next) {
        await loadMemories();
      } else {
        setMemories([]);
      }
    } catch (err) {
      console.error('Failed to toggle memory', err);
    } finally {
      setSavingToggle(false);
    }
  };

  const createMemory = async () => {
    setCreating(true);
    try {
      const payload = {
        level: Number(newMemory.level),
        module: newMemory.module.trim(),
        key: newMemory.key.trim(),
        value: newMemory.value.trim(),
        confidence: Number(newMemory.confidence),
      };

      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const error = await res.json();
        console.error('Failed to create memory', error);
        return;
      }

      setNewMemory({
        level: '2',
        module: 'preferences',
        key: '',
        value: '',
        confidence: '0.6',
      });

      await loadMemories();
    } catch (err) {
      console.error('Failed to create memory', err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Memories</h1>
        <p className="text-muted-foreground">
          View and edit the memories currently loaded into chat prompts.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Memory Toggle</CardTitle>
          <CardDescription>
            Disable to stop memory loading and writing. Warning: enabling memory can increase token
            usage for each chat.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(e) => void toggleMemory(e.target.checked)}
              disabled={savingToggle}
            />
            Enable memory
          </label>
          {savingToggle && <span className="text-xs text-muted-foreground">Saving...</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Loaded Memories</CardTitle>
          <CardDescription>
            Showing the memory set injected into chat prompts (latest 5 per level).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button onClick={() => setShowCreate(true)} disabled={!memoryEnabled}>
              Add Memory
            </Button>
            <p className="text-xs text-muted-foreground">
              Latest 5 memories per level are shown below.
            </p>
          </div>
          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {!loading && memories.length === 0 && (
            <p className="text-sm text-muted-foreground">No active memories loaded.</p>
          )}
          {[0, 1, 2, 3, 4, 5].map((level) => {
            const rows = memories.filter((memory) => memory.level === level);
            if (rows.length === 0) return null;
            return (
              <div key={level} className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">Level {level}</p>
                  <p className="text-xs text-muted-foreground">{rows.length} items</p>
                </div>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="min-w-full text-sm">
                    <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">Module</th>
                        <th className="px-3 py-2 text-left">Key</th>
                        <th className="px-3 py-2 text-left">Value</th>
                        <th className="px-3 py-2 text-left">Confidence</th>
                        <th className="px-3 py-2 text-left">Pinned</th>
                        <th className="px-3 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((memory) => (
                        <tr key={memory.id} className="border-t border-border">
                          <td className="px-3 py-2">{memory.module}</td>
                          <td className="px-3 py-2">{memory.key}</td>
                          <td className="px-3 py-2">{memory.value}</td>
                          <td className="px-3 py-2">{memory.confidence.toFixed(2)}</td>
                          <td className="px-3 py-2">{memory.pinned ? 'Yes' : 'No'}</td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditingId(memory.id)}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void deleteMemory(memory.id)}
                                disabled={deletingId === memory.id}
                              >
                                {deletingId === memory.id ? 'Deleting...' : 'Delete'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {showCreate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowCreate(false)} />
          <div className="relative w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Add Memory</h2>
              <p className="text-sm text-muted-foreground">Create a new memory entry.</p>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Level (0-5)</label>
                <Input
                  value={newMemory.level}
                  onChange={(e) => setNewMemory((prev) => ({ ...prev, level: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Module</label>
                <Input
                  value={newMemory.module}
                  onChange={(e) => setNewMemory((prev) => ({ ...prev, module: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Key</label>
                <Input
                  value={newMemory.key}
                  onChange={(e) => setNewMemory((prev) => ({ ...prev, key: e.target.value }))}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium">Value</label>
                <Input
                  value={newMemory.value}
                  onChange={(e) => setNewMemory((prev) => ({ ...prev, value: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Confidence (0-1)</label>
                <Input
                  value={newMemory.confidence}
                  onChange={(e) =>
                    setNewMemory((prev) => ({ ...prev, confidence: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button onClick={() => void createMemory()} disabled={creating || !memoryEnabled}>
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {editingId ? (
        <EditMemoryDialog
          memory={memories.find((item) => item.id === editingId) ?? null}
          savingId={savingId}
          memoryEnabled={memoryEnabled}
          onClose={() => setEditingId(null)}
          onSave={(memory) => void saveMemory(memory)}
        />
      ) : null}
    </div>
  );
}

function EditMemoryDialog({
  memory,
  savingId,
  memoryEnabled,
  onClose,
  onSave,
}: {
  memory: MemoryItem | null;
  savingId: string | null;
  memoryEnabled: boolean;
  onClose: () => void;
  onSave: (memory: MemoryItem) => void;
}) {
  const [draft, setDraft] = useState<MemoryItem | null>(memory);

  useEffect(() => {
    setDraft(memory);
  }, [memory]);

  if (!draft) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Edit Memory</h2>
          <p className="text-sm text-muted-foreground">Update memory details.</p>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Level (0-5)</label>
            <Input
              value={draft.level}
              onChange={(e) =>
                setDraft((prev) => (prev ? { ...prev, level: Number(e.target.value) } : prev))
              }
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Module</label>
            <Input
              value={draft.module}
              onChange={(e) =>
                setDraft((prev) => (prev ? { ...prev, module: e.target.value } : prev))
              }
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Key</label>
            <Input
              value={draft.key}
              onChange={(e) => setDraft((prev) => (prev ? { ...prev, key: e.target.value } : prev))}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium">Value</label>
            <Input
              value={draft.value}
              onChange={(e) =>
                setDraft((prev) => (prev ? { ...prev, value: e.target.value } : prev))
              }
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Confidence (0-1)</label>
            <Input
              value={draft.confidence}
              onChange={(e) =>
                setDraft((prev) => (prev ? { ...prev, confidence: Number(e.target.value) } : prev))
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.pinned}
              onChange={(e) =>
                setDraft((prev) => (prev ? { ...prev, pinned: e.target.checked } : prev))
              }
            />
            <span className="text-sm">Pinned</span>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => draft && onSave(draft)}
            disabled={savingId === draft.id || !memoryEnabled}
          >
            {savingId === draft.id ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
