'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Send, Globe, MessageSquare, Loader2, Paperclip, X, Download } from 'lucide-react';
import { RunVisualization } from './run-visualization';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Channel {
  id: string;
  type: string;
  name: string;
  activeContextId?: string | null;
}

interface Message {
  id: string;
  content: string;
  direction: string;
  createdAt: string;
  metadata?: string | null;
  contextId?: string | null;
}

interface FileRecord {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  summary?: string | null;
  canInlinePreview?: boolean;
}

interface MessageAttachment {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  summary?: string | null;
}

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

interface ContextItem {
  id: string;
  name: string;
  createdAt: string;
}

export default function ChatPage() {
  const [webChannel, setWebChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [pendingReplyTo, setPendingReplyTo] = useState<string | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [contexts, setContexts] = useState<ContextItem[]>([]);
  const [activeContextId, setActiveContextId] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [composerFiles, setComposerFiles] = useState<FileRecord[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const pendingReplyToRef = useRef<string | null>(null);
  const pendingSinceRef = useRef<number | null>(null);
  const activeContext = contexts.find((context) => context.id === activeContextId) ?? contexts[0];
  const pendingRunId = pendingReplyTo
    ? extractRunId(messages.find((message) => message.id === pendingReplyTo)?.metadata)
    : '';

  const markdownComponents = useMemo(
    () => ({
      a: ({ children, ...props }: any) => (
        <a className="underline text-inherit" target="_blank" rel="noreferrer" {...props}>
          {children}
        </a>
      ),
      code: ({ inline, className, children, ...props }: any) => (
        <code
          className={
            inline
              ? 'rounded bg-muted px-1 py-0.5 text-[0.85em] text-inherit'
              : `block rounded bg-muted p-3 text-xs text-inherit ${className ?? ''}`
          }
          {...props}
        >
          {children}
        </code>
      ),
    }),
    []
  );

  const renderMarkdown = (content: string) => (
    <div className="prose prose-sm max-w-none text-inherit prose-p:text-inherit prose-strong:text-inherit prose-em:text-inherit prose-li:text-inherit prose-headings:text-inherit prose-code:text-inherit prose-a:text-inherit">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );

  useEffect(() => {
    loadWebChannel();
  }, []);

  useEffect(() => {
    if (!webChannel) return;

    loadContexts();
  }, [webChannel]);

  useEffect(() => {
    if (!webChannel) return;

    loadMessages();
    const interval = setInterval(loadMessages, 3000);
    return () => clearInterval(interval);
  }, [webChannel, activeContextId]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return;
    if (lastMessageIdRef.current === lastMessage.id) return;
    lastMessageIdRef.current = lastMessage.id;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (initialLoading || !webChannel) return;
    inputRef.current?.focus();
  }, [initialLoading, webChannel]);

  useEffect(() => {
    pendingReplyToRef.current = pendingReplyTo;
  }, [pendingReplyTo]);

  useEffect(() => {
    pendingSinceRef.current = pendingSince;
  }, [pendingSince]);

  const loadWebChannel = async () => {
    try {
      const res = await fetch('/api/channels', {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = await res.json();
      const web = (data.channels || []).find((c: Channel) => c.type === 'web');
      setWebChannel(web || null);
    } catch (err) {
      console.error('Failed to load web channel:', err);
    } finally {
      setInitialLoading(false);
    }
  };

  const loadMessages = async () => {
    if (!webChannel) return;

    try {
      const contextParam = activeContextId ? `&contextId=${activeContextId}` : '';
      const res = await fetch(`/api/messages?channelId=${webChannel.id}${contextParam}`, {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = await res.json();
      const nextMessages: Message[] = (data.messages || []).reverse();
      setMessages((prev) => {
        if (prev.length !== nextMessages.length) return nextMessages;
        for (let i = 0; i < prev.length; i += 1) {
          const prevMsg = prev[i]!;
          const nextMsg = nextMessages[i]!;
          if (
            prevMsg.id !== nextMsg.id ||
            prevMsg.content !== nextMsg.content ||
            prevMsg.direction !== nextMsg.direction ||
            prevMsg.createdAt !== nextMsg.createdAt ||
            prevMsg.metadata !== nextMsg.metadata ||
            prevMsg.contextId !== nextMsg.contextId
          ) {
            return nextMessages;
          }
        }
        return prev;
      });

      const pendingReplyId = pendingReplyToRef.current;
      const pendingStartedAt = pendingSinceRef.current;
      if (pendingReplyId) {
        const hasReply = nextMessages.some((msg: Message) => {
          if (msg.direction !== 'outbound' || !msg.metadata) return false;
          try {
            const meta = JSON.parse(msg.metadata);
            return meta?.replyTo === pendingReplyId;
          } catch {
            return false;
          }
        });
        let hasFallbackReply = false;
        if (!hasReply) {
          const pendingIndex = nextMessages.findIndex((msg) => msg.id === pendingReplyId);
          if (pendingIndex >= 0) {
            hasFallbackReply = nextMessages
              .slice(pendingIndex + 1)
              .some((msg) => msg.direction === 'outbound');
          }
        }
        let hasTimeFallbackReply = false;
        if (!hasReply && !hasFallbackReply && pendingStartedAt) {
          hasTimeFallbackReply = nextMessages.some((msg) => {
            if (msg.direction !== 'outbound') return false;
            const messageTime = new Date(msg.createdAt).getTime();
            return Number.isFinite(messageTime) && messageTime >= pendingStartedAt - 1000;
          });
        }
        if (hasReply || hasFallbackReply || hasTimeFallbackReply) {
          setPendingReplyTo(null);
          setPendingSince(null);
          pendingReplyToRef.current = null;
          pendingSinceRef.current = null;
        }
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  };

  const loadContexts = async () => {
    if (!webChannel) return;

    setContextLoading(true);
    try {
      const res = await fetch(`/api/contexts?channelId=${webChannel.id}`, {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      const data = await res.json();
      setContexts(data.contexts || []);
      setActiveContextId(data.activeContextId || null);
    } catch (err) {
      console.error('Failed to load contexts:', err);
    } finally {
      setContextLoading(false);
    }
  };

  const handleCreateContext = async () => {
    if (!webChannel || contextLoading) return;

    setContextLoading(true);
    try {
      if (activeContextId) {
        await fetch(`/api/contexts/${activeContextId}/close`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': DEMO_USER_ID,
          },
        });
      }
      const res = await fetch('/api/contexts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify({
          channelId: webChannel.id,
        }),
      });

      const data = await res.json();
      setActiveContextId(data.activeContextId || null);
      await loadContexts();
    } catch (err) {
      console.error('Failed to create context:', err);
    } finally {
      setContextLoading(false);
    }
  };

  const uploadFile = async (file: File): Promise<FileRecord> => {
    if (!webChannel) {
      throw new Error('Web channel not available');
    }

    const dataBase64 = await readFileAsBase64(file);
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': DEMO_USER_ID,
      },
      body: JSON.stringify({
        channelId: webChannel.id,
        contextId: activeContextId ?? undefined,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data?.file) {
      throw new Error(data?.error || 'Upload failed');
    }
    return data.file as FileRecord;
  };

  const handleSelectFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    if (selected.length === 0) return;

    setUploadingFiles(true);
    setUploadError(null);
    try {
      const uploaded = await Promise.all(selected.map((file) => uploadFile(file)));
      setComposerFiles((current) => [...current, ...uploaded]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(errorMessage);
    } finally {
      setUploadingFiles(false);
      event.target.value = '';
    }
  };

  const removeComposerFile = (fileId: string) => {
    setComposerFiles((current) => current.filter((file) => file.id !== fileId));
  };

  const downloadAttachment = async (attachment: MessageAttachment) => {
    try {
      const res = await fetch(`/api/files/${attachment.fileId}/content`, {
        headers: { 'X-User-Id': DEMO_USER_ID },
      });
      if (!res.ok) {
        throw new Error(`Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download attachment:', err);
      setUploadError('Could not download file. Please try again.');
    }
  };

  const handleSend = async () => {
    if ((!input.trim() && composerFiles.length === 0) || !webChannel || loading || uploadingFiles)
      return;

    const content = input.trim();
    const selectedFiles = [...composerFiles];
    setInput('');
    setLoading(true);
    setUploadError(null);
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': DEMO_USER_ID,
        },
        body: JSON.stringify({
          channelId: webChannel.id,
          contextId: activeContextId ?? undefined,
          content,
          fileIds: selectedFiles.map((file) => file.id),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to send message');
      }
      if (data.message?.id) {
        setPendingReplyTo(data.message.id);
        setPendingSince(Date.now());
        pendingReplyToRef.current = data.message.id;
        pendingSinceRef.current = Date.now();
      }
      setComposerFiles([]);

      await loadMessages();
    } catch (err) {
      setInput(content);
      setComposerFiles(selectedFiles);
      console.error('Failed to send message:', err);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (initialLoading) {
    return (
      <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!webChannel) {
    return (
      <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
        <Card className="max-w-md text-center">
          <CardContent className="pt-6">
            <Globe className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <h2 className="text-xl font-semibold">No Web Channel</h2>
            <p className="mt-2 text-muted-foreground">
              Web channel is not configured. Please contact support.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col overflow-hidden">
      <Card className="flex flex-1 min-h-0 flex-col">
        <CardHeader className="border-b border-border">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>
              <div className="flex items-center gap-2">
                <Globe className="h-5 w-5" />
                Web Chat
              </div>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCreateContext}
                disabled={contextLoading}
              >
                New Session
              </Button>
            </div>
          </div>
        </CardHeader>

        {/* Messages */}
        <CardContent className="flex-1 min-h-0 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <MessageSquare className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
                <p className="text-muted-foreground">No messages yet</p>
                <p className="text-sm text-muted-foreground">Send a message to get started</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => {
                const attachments = extractAttachments(message.metadata);
                return (
                  <div
                    key={message.id}
                    className={`flex ${message.direction === 'inbound' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`flex max-w-[88%] items-start gap-2 sm:max-w-[80%] ${
                        message.direction === 'inbound' ? 'flex-row-reverse' : ''
                      }`}
                    >
                      {message.direction !== 'inbound' ? (
                        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                          C
                        </div>
                      ) : null}
                      <div
                        className={`w-fit rounded-2xl px-4 py-2 ${
                          message.direction === 'inbound'
                            ? 'rounded-tr-md bg-primary text-primary-foreground'
                            : 'bg-muted text-foreground'
                        }`}
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                          {message.direction === 'inbound' ? 'You' : 'Clifford'}
                        </p>
                        {message.content.trim() ? (
                          <div className="mt-1 break-words">{renderMarkdown(message.content)}</div>
                        ) : null}
                        {attachments.length > 0 ? (
                          <div className="mt-2 space-y-2">
                            {attachments.map((attachment) => (
                              <div
                                key={attachment.fileId}
                                className={`rounded-lg border px-3 py-2 ${
                                  message.direction === 'inbound'
                                    ? 'border-primary-foreground/30 bg-primary-foreground/10'
                                    : 'border-border bg-background/60'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{attachment.fileName}</p>
                                    <p className="text-xs opacity-70">
                                      {attachment.mimeType} • {formatBytes(attachment.sizeBytes)}
                                    </p>
                                    {attachment.summary ? (
                                      <p className="mt-1 text-xs opacity-80">{attachment.summary}</p>
                                    ) : null}
                                  </div>
                                  {!isInlineMediaType(attachment.mimeType) ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-8 px-2"
                                      onClick={() => downloadAttachment(attachment)}
                                    >
                                      <Download className="h-3.5 w-3.5" />
                                    </Button>
                                  ) : null}
                                </div>
                                {isInlineMediaType(attachment.mimeType) ? (
                                  <InlineMediaPreview attachment={attachment} />
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {message.direction !== 'inbound' && extractRunId(message.metadata) ? (
                          <RunVisualization runId={extractRunId(message.metadata)} />
                        ) : null}
                        <p
                          className={`mt-1 text-xs ${
                            message.direction === 'inbound'
                              ? 'text-primary-foreground/70'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {new Date(message.createdAt).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
              {pendingReplyTo ? (
                <div className="flex justify-start">
                  <div className="flex items-start gap-3">
                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                      C
                    </div>
                    <div className="max-w-[80%] rounded-2xl rounded-tl-md bg-muted px-4 py-2 text-foreground">
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                        Clifford
                      </p>
                      <p className="mt-1 inline-flex items-center gap-2 text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                          <span
                            className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
                            style={{ animationDelay: '180ms' }}
                          />
                          <span
                            className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
                            style={{ animationDelay: '360ms' }}
                          />
                        </span>
                        Clifford is thinking
                      </p>
                      {pendingRunId ? <RunVisualization runId={pendingRunId} /> : null}
                    </div>
                  </div>
                </div>
              ) : null}
              <div ref={messagesEndRef} />
            </div>
          )}
        </CardContent>

        {/* Input */}
        <div className="border-t border-border p-4">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={handleSelectFiles}
          />
          {composerFiles.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {composerFiles.map((file) => (
                <div
                  key={file.id}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs"
                >
                  <span className="max-w-[240px] truncate">
                    {file.fileName} ({formatBytes(file.sizeBytes)})
                  </span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeComposerFile(file.id)}
                    aria-label={`Remove ${file.fileName}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {uploadError ? <p className="mb-2 text-xs text-destructive">{uploadError}</p> : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || uploadingFiles}
            >
              {uploadingFiles ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </Button>
            <textarea
              ref={inputRef}
              className="flex min-h-[38px] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Type a message or attach files..."
              rows={2}
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading || uploadingFiles}
            />
            <Button
              onClick={handleSend}
              disabled={loading || uploadingFiles || (!input.trim() && composerFiles.length === 0)}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
          {uploadingFiles ? (
            <p className="mt-2 text-xs text-muted-foreground">Uploading files...</p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function extractRunId(metadata?: string | null) {
  if (!metadata) return '';
  try {
    const parsed = JSON.parse(metadata) as { runId?: string };
    return parsed.runId ?? '';
  } catch {
    return '';
  }
}

function extractAttachments(metadata?: string | null): MessageAttachment[] {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata) as {
      attachments?: Array<{
        fileId?: string;
        fileName?: string;
        mimeType?: string;
        sizeBytes?: number;
        summary?: string | null;
      }>;
    };
    if (!Array.isArray(parsed.attachments)) return [];
    return parsed.attachments
      .filter(
        (attachment): attachment is Required<Pick<MessageAttachment, 'fileId' | 'fileName' | 'mimeType' | 'sizeBytes'>> &
          Pick<MessageAttachment, 'summary'> =>
          typeof attachment.fileId === 'string' &&
          typeof attachment.fileName === 'string' &&
          typeof attachment.mimeType === 'string' &&
          typeof attachment.sizeBytes === 'number'
      )
      .map((attachment) => ({
        fileId: attachment.fileId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        summary: attachment.summary ?? null,
      }));
  } catch {
    return [];
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? (result.split(',')[1] ?? '') : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function isInlineMediaType(mimeType: string) {
  return mimeType.startsWith('image/') || mimeType.startsWith('audio/');
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function InlineMediaPreview({ attachment }: { attachment: MessageAttachment }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let localUrl: string | null = null;

    const run = async () => {
      try {
        const res = await fetch(`/api/files/${attachment.fileId}/content`, {
          headers: { 'X-User-Id': DEMO_USER_ID },
        });
        if (!res.ok) {
          throw new Error(`Failed to load media (${res.status})`);
        }
        const blob = await res.blob();
        localUrl = URL.createObjectURL(blob);
        if (!cancelled) {
          setObjectUrl(localUrl);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setObjectUrl(null);
          setError(err instanceof Error ? err.message : 'Failed to load media');
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (localUrl) {
        URL.revokeObjectURL(localUrl);
      }
    };
  }, [attachment.fileId]);

  if (error) {
    return <p className="mt-2 text-xs text-destructive">{error}</p>;
  }
  if (!objectUrl) {
    return (
      <p className="mt-2 inline-flex items-center gap-1 text-xs opacity-70">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading preview...
      </p>
    );
  }

  if (attachment.mimeType.startsWith('image/')) {
    return (
      <img
        src={objectUrl}
        alt={attachment.fileName}
        className="mt-2 max-h-64 w-full rounded-md object-contain"
      />
    );
  }

  if (attachment.mimeType.startsWith('audio/')) {
    return <audio className="mt-2 w-full" controls src={objectUrl} preload="metadata" />;
  }

  return null;
}
