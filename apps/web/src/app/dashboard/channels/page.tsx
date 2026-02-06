'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  MessageSquare,
  Plus,
  Trash2,
  Globe,
  X,
  ExternalLink,
  Loader2,
  ChevronRight,
  Copy,
} from 'lucide-react';
import Image from 'next/image';

// Channel type icons - extensible for future channel types
const CHANNEL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  web: Globe,
  discord: MessageSquare,
};

interface Channel {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
}

interface Message {
  id: string;
  content: string;
  direction: string;
  createdAt: string;
  metadata?: string | null;
}

interface DiscordConnection {
  id: string;
  discordUserId: string;
  discordUsername: string;
  discordAvatar: string | null;
}

interface DiscordKnownUser {
  id: string;
  username: string;
  avatar?: string | null;
  lastSeenAt?: string;
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [discordConnections, setDiscordConnections] = useState<DiscordConnection[]>([]);
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [showAddDiscord, setShowAddDiscord] = useState(false);
  const [manualUserId, setManualUserId] = useState('');
  const [showDiscordDmConfig, setShowDiscordDmConfig] = useState(false);
  const [discordDmUserId, setDiscordDmUserId] = useState('');
  const [discordDmUsername, setDiscordDmUsername] = useState('');
  const [discordDmAllowedIds, setDiscordDmAllowedIds] = useState<string[]>([]);
  const [discordDmAllowedUsernames, setDiscordDmAllowedUsernames] = useState<string[]>([]);
  const [discordDmKnownUsers, setDiscordDmKnownUsers] = useState<DiscordKnownUser[]>([]);
  const [discordDmUserMeta, setDiscordDmUserMeta] = useState<
    Record<string, { label: string; note: string }>
  >({});
  const [discordDmSearch, setDiscordDmSearch] = useState('');
  const [discordBotChannel, setDiscordBotChannel] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);

  // Message viewer state
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!selectedChannel) return;

    loadMessages(selectedChannel.id);
    const interval = setInterval(() => loadMessages(selectedChannel.id), 3000);
    return () => clearInterval(interval);
  }, [selectedChannel]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadData = async () => {
    try {
      const userId = '00000000-0000-0000-0000-000000000001';

      const [channelsRes, connectionsRes] = await Promise.all([
        fetch('/api/channels', {
          headers: { 'X-User-Id': userId },
        }),
        fetch('/api/discord/connections', {
          headers: { 'X-User-Id': userId },
        }),
      ]);

      const channelsData = await channelsRes.json();
      const connectionsData = await connectionsRes.json();

      const loadedChannels = channelsData.channels || [];
      setChannels(loadedChannels);
      setDiscordConnections(connectionsData.connections || []);

      const botChannel = loadedChannels.find((channel: Channel) => {
        const config = channel.config || {};
        return channel.type === 'discord' && config.mode === 'bot_dm';
      });
      setDiscordBotChannel(botChannel || null);

      const allowedIds =
        botChannel && Array.isArray(botChannel.config?.allowedDiscordUserIds)
          ? botChannel.config.allowedDiscordUserIds.filter((id: unknown) => typeof id === 'string')
          : [];
      const allowedUsernames =
        botChannel && Array.isArray(botChannel.config?.allowedDiscordUsernames)
          ? botChannel.config.allowedDiscordUsernames.filter(
              (name: unknown) => typeof name === 'string'
            )
          : [];
      const knownUsers =
        botChannel && Array.isArray(botChannel.config?.knownDiscordUsers)
          ? botChannel.config.knownDiscordUsers.filter(
              (user: unknown) =>
                user &&
                typeof user === 'object' &&
                typeof (user as { id?: unknown }).id === 'string' &&
                typeof (user as { username?: unknown }).username === 'string'
            )
          : [];
      const allowedMeta =
        botChannel &&
        botChannel.config?.allowedDiscordUserMeta &&
        typeof botChannel.config.allowedDiscordUserMeta === 'object'
          ? botChannel.config.allowedDiscordUserMeta
          : {};

      setDiscordDmAllowedIds(allowedIds as string[]);
      setDiscordDmAllowedUsernames(allowedUsernames as string[]);
      setDiscordDmKnownUsers(knownUsers as DiscordKnownUser[]);
      setDiscordDmUserMeta(allowedMeta as Record<string, { label: string; note: string }>);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (channelId: string) => {
    try {
      setMessagesLoading(true);
      const userId = '00000000-0000-0000-0000-000000000001';
      const res = await fetch(`/api/messages?channelId=${channelId}`, {
        headers: { 'X-User-Id': userId },
      });
      const data = await res.json();
      setMessages((data.messages || []).reverse());
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleDiscordOAuth = () => {
    const clientId = 'YOUR_DISCORD_CLIENT_ID';
    const redirectUri = encodeURIComponent(`${window.location.origin}/auth/discord/callback`);
    const scope = 'identify';

    window.location.href = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
  };

  const handleManualConnect = async () => {
    if (!manualUserId.trim()) return;

    try {
      const userId = '00000000-0000-0000-0000-000000000001';

      await fetch('/api/channels', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': userId,
        },
        body: JSON.stringify({
          type: 'discord',
          name: `Discord User ${manualUserId}`,
          config: { discordUserId: manualUserId },
        }),
      });

      setManualUserId('');
      setShowAddDiscord(false);
      loadData();
    } catch (err) {
      console.error('Failed to connect:', err);
    }
  };

  const handleAddDiscordDmUser = () => {
    const nextId = discordDmUserId.trim();
    if (!nextId) return;
    if (discordDmAllowedIds.includes(nextId)) {
      setDiscordDmUserId('');
      return;
    }
    setDiscordDmAllowedIds([...discordDmAllowedIds, nextId]);
    setDiscordDmUserId('');
  };

  const handleAddDiscordDmUsername = () => {
    const nextName = discordDmUsername.trim();
    if (!nextName) return;
    if (discordDmAllowedUsernames.includes(nextName)) {
      setDiscordDmUsername('');
      return;
    }
    setDiscordDmAllowedUsernames([...discordDmAllowedUsernames, nextName]);
    setDiscordDmUsername('');
  };

  const handleRemoveDiscordDmUser = (id: string) => {
    setDiscordDmAllowedIds(discordDmAllowedIds.filter((item) => item !== id));
    if (discordDmUserMeta[id]) {
      const nextMeta = { ...discordDmUserMeta };
      delete nextMeta[id];
      setDiscordDmUserMeta(nextMeta);
    }
  };

  const handleRemoveDiscordDmUsername = (name: string) => {
    setDiscordDmAllowedUsernames(discordDmAllowedUsernames.filter((item) => item !== name));
  };

  const handleAllowKnownUser = (user: DiscordKnownUser) => {
    if (discordDmAllowedIds.includes(user.id)) return;
    setDiscordDmAllowedIds([...discordDmAllowedIds, user.id]);
  };

  const handleUpdateDiscordDmMeta = (id: string, field: 'label' | 'note', value: string) => {
    setDiscordDmUserMeta({
      ...discordDmUserMeta,
      [id]: {
        label: discordDmUserMeta[id]?.label || '',
        note: discordDmUserMeta[id]?.note || '',
        [field]: value,
      },
    });
  };

  const handleCopyDiscordId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
    } catch (err) {
      console.error('Failed to copy Discord ID:', err);
    }
  };

  const handleSaveDiscordDmConfig = async () => {
    try {
      const userId = '00000000-0000-0000-0000-000000000001';
      const config = {
        mode: 'bot_dm',
        allowedDiscordUserIds: discordDmAllowedIds,
        allowedDiscordUsernames: discordDmAllowedUsernames,
        knownDiscordUsers: discordDmKnownUsers,
        allowedDiscordUserMeta: discordDmUserMeta,
      };

      if (discordBotChannel) {
        await fetch(`/api/channels/${discordBotChannel.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': userId,
          },
          body: JSON.stringify({ config }),
        });
      } else {
        await fetch('/api/channels', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': userId,
          },
          body: JSON.stringify({
            type: 'discord',
            name: 'Discord DMs',
            config,
          }),
        });
      }

      setShowDiscordDmConfig(false);
      loadData();
    } catch (err) {
      console.error('Failed to save Discord DM config:', err);
    }
  };

  const handleDeleteChannel = async (channelId: string) => {
    if (!confirm('Are you sure you want to delete this channel?')) return;

    try {
      const userId = '00000000-0000-0000-0000-000000000001';

      await fetch(`/api/channels/${channelId}`, {
        method: 'DELETE',
        headers: { 'X-User-Id': userId },
      });

      if (selectedChannel?.id === channelId) {
        setSelectedChannel(null);
        setMessages([]);
      }

      loadData();
    } catch (err) {
      console.error('Failed to delete channel:', err);
    }
  };

  const handleChannelClick = (channel: Channel) => {
    if (channel.type === 'web') {
      // Web channel navigates to chat page (handled by Link)
      return;
    }
    // Other channels open the message viewer
    setSelectedChannel(channel);
  };

  const getChannelIcon = (type: string) => {
    return CHANNEL_ICONS[type] || MessageSquare;
  };

  const getDiscordAvatar = (meta?: {
    discordUserId?: string;
    discordAvatar?: string | null;
    discordUsername?: string;
  }) => {
    if (!meta?.discordUserId) return null;
    if (meta.discordAvatar) {
      return `https://cdn.discordapp.com/avatars/${meta.discordUserId}/${meta.discordAvatar}.png`;
    }
    return null;
  };

  const getInitials = (value?: string) => {
    if (!value) return '?';
    return value.replace(/#\d+$/, '').slice(0, 2).toUpperCase();
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Channels</h1>
          <p className="text-muted-foreground">Configure how you communicate with your agents</p>
        </div>
        <Button onClick={() => setShowAddChannel(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Channel
        </Button>
      </div>

      {/* Channels List */}
      <Card>
        <CardHeader>
          <CardTitle>Active Channels</CardTitle>
          <CardDescription>Your communication channels</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {channels.map((channel) => {
              const Icon = getChannelIcon(channel.type);
              const isWeb = channel.type === 'web';

              const channelContent = (
                <div
                  className={`flex items-center gap-3 rounded-lg border border-border p-4 transition-colors ${
                    !isWeb ? 'cursor-pointer hover:bg-accent' : ''
                  }`}
                  onClick={() => !isWeb && handleChannelClick(channel)}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium">{channel.name}</p>
                    <p className="text-sm text-muted-foreground capitalize">
                      {channel.type} channel
                      {!isWeb && ' (read-only)'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${
                        channel.enabled
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                      }`}
                    >
                      {channel.enabled ? 'Active' : 'Disabled'}
                    </span>
                    {isWeb ? (
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteChannel(channel.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );

              return isWeb ? (
                <Link key={channel.id} href="/dashboard/chat" className="block">
                  {channelContent}
                </Link>
              ) : (
                <div key={channel.id}>{channelContent}</div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Channel Setup */}
      <Card>
        <CardHeader>
          <CardTitle>Channel Setup</CardTitle>
          <CardDescription>Configure Discord integrations and access</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="font-medium">Discord Bot DMs</p>
              <p className="text-sm text-muted-foreground">
                {discordBotChannel ? 'Configured' : 'Not configured'}
              </p>
              {discordBotChannel && (
                <p className="text-xs text-muted-foreground">
                  Allowed users: {discordDmAllowedIds.length}
                </p>
              )}
            </div>
            <Button variant="outline" onClick={() => setShowDiscordDmConfig(true)}>
              {discordBotChannel ? 'Manage' : 'Enable'}
            </Button>
          </div>

          {discordConnections.length > 0 ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">Connected Discord Accounts</p>
              {discordConnections.map((conn) => (
                <div
                  key={conn.id}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  {conn.discordAvatar ? (
                    <Image
                      src={`https://cdn.discordapp.com/avatars/${conn.discordUserId}/${conn.discordAvatar}.png`}
                      alt={conn.discordUsername}
                      width={40}
                      height={40}
                      className="rounded-full"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      {conn.discordUsername[0]}
                    </div>
                  )}
                  <div className="flex-1">
                    <p className="font-medium">{conn.discordUsername}</p>
                    <p className="text-sm text-muted-foreground">ID: {conn.discordUserId}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
              No Discord accounts connected.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Message Viewer Modal (for non-web channels) */}
      {selectedChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="flex h-[80vh] w-full max-w-2xl flex-col">
            <CardHeader className="flex-shrink-0 border-b border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {(() => {
                    const Icon = getChannelIcon(selectedChannel.type);
                    return <Icon className="h-5 w-5" />;
                  })()}
                  <CardTitle>{selectedChannel.name}</CardTitle>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Read-only
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setSelectedChannel(null);
                    setMessages([]);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <CardDescription>
                Messages from {selectedChannel.type} channel. You cannot send messages here.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-4">
              {messagesLoading && messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div>
                    <MessageSquare className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
                    <p className="text-muted-foreground">No messages yet</p>
                    <p className="text-sm text-muted-foreground">
                      Messages from {selectedChannel.type} will appear here
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.map((message) =>
                    (() => {
                      let metadata: {
                        discordUserId?: string;
                        discordUsername?: string;
                        discordAvatar?: string | null;
                      } | null = null;

                      if (message.metadata) {
                        try {
                          metadata = JSON.parse(message.metadata);
                        } catch {
                          metadata = null;
                        }
                      }

                      const showAvatar =
                        selectedChannel.type === 'discord' && message.direction === 'inbound';
                      const avatarUrl = showAvatar ? getDiscordAvatar(metadata || undefined) : null;
                      const avatarLabel = metadata?.discordUsername || metadata?.discordUserId;
                      const metaLabel =
                        metadata?.discordUserId && discordDmUserMeta[metadata.discordUserId]?.label
                          ? discordDmUserMeta[metadata.discordUserId]?.label
                          : null;
                      const metaNote =
                        metadata?.discordUserId && discordDmUserMeta[metadata.discordUserId]?.note
                          ? discordDmUserMeta[metadata.discordUserId]?.note
                          : null;

                      return (
                        <div
                          key={message.id}
                          className={`flex items-end gap-2 ${
                            message.direction === 'outbound' ? 'justify-end' : 'justify-start'
                          }`}
                        >
                          {showAvatar && (
                            <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-muted text-xs text-muted-foreground">
                              {avatarUrl ? (
                                <Image
                                  src={avatarUrl}
                                  alt={avatarLabel || 'Discord avatar'}
                                  width={32}
                                  height={32}
                                />
                              ) : (
                                getInitials(avatarLabel || '')
                              )}
                            </div>
                          )}
                          <div
                            className={`max-w-[70%] rounded-lg px-4 py-2 ${
                              message.direction === 'outbound'
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted'
                            }`}
                          >
                            <p className="whitespace-pre-wrap break-words">{message.content}</p>
                            {metadata?.discordUsername && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {metadata.discordUsername}
                              </p>
                            )}
                            {(metaLabel || metaNote) && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {metaLabel && <span className="font-medium">{metaLabel}</span>}
                                {metaLabel && metaNote && <span> · </span>}
                                {metaNote && <span>{metaNote}</span>}
                              </div>
                            )}
                            <p
                              className={`mt-1 text-xs ${
                                message.direction === 'outbound'
                                  ? 'text-primary-foreground/70'
                                  : 'text-muted-foreground'
                              }`}
                            >
                              {new Date(message.createdAt).toLocaleTimeString()}
                            </p>
                          </div>
                        </div>
                      );
                    })()
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </CardContent>
            <div className="flex-shrink-0 border-t border-border bg-muted/50 p-4">
              <p className="text-center text-sm text-muted-foreground">
                This is a read-only view. To send messages, use the{' '}
                <Link href="/dashboard/chat" className="text-primary hover:underline">
                  Web Chat
                </Link>
                .
              </p>
            </div>
          </Card>
        </div>
      )}

      {/* Discord DM Allowlist Modal */}
      {showDiscordDmConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Allowed Discord DMs</CardTitle>
              <CardDescription>
                Add Discord user IDs or usernames that are allowed to DM your bot.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {discordDmKnownUsers.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Known Discord users</p>
                  <Input
                    placeholder="Search by username or ID"
                    value={discordDmSearch}
                    onChange={(e) => setDiscordDmSearch(e.target.value)}
                  />
                  {discordDmKnownUsers.map((user) => {
                    const search = discordDmSearch.trim().toLowerCase();
                    const matchesSearch =
                      !search ||
                      user.username.toLowerCase().includes(search) ||
                      user.id.toLowerCase().includes(search);
                    if (!matchesSearch) return null;
                    const isAllowed = discordDmAllowedIds.includes(user.id);
                    const avatarUrl = user.avatar
                      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
                      : null;
                    return (
                      <div
                        key={user.id}
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-muted text-xs text-muted-foreground">
                            {avatarUrl ? (
                              <Image src={avatarUrl} alt={user.username} width={32} height={32} />
                            ) : (
                              getInitials(user.username)
                            )}
                          </div>
                          <div>
                            <p className="text-sm">{user.username}</p>
                            <p className="text-xs text-muted-foreground">{user.id}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleCopyDiscordId(user.id)}
                            aria-label="Copy Discord ID"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            variant={isAllowed ? 'outline' : 'default'}
                            size="sm"
                            onClick={() => handleAllowKnownUser(user)}
                            disabled={isAllowed}
                          >
                            {isAllowed ? 'Allowed' : 'Allow'}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">Discord User ID</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="123456789012345678"
                    value={discordDmUserId}
                    onChange={(e) => setDiscordDmUserId(e.target.value)}
                  />
                  <Button onClick={handleAddDiscordDmUser}>Add</Button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Discord Username</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="username#1234"
                    value={discordDmUsername}
                    onChange={(e) => setDiscordDmUsername(e.target.value)}
                  />
                  <Button onClick={handleAddDiscordDmUsername}>Add</Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  You can include the discriminator (username#1234) or just the username. If it
                  matches, the user ID will be auto-added on first DM.
                </p>
              </div>

              {discordDmAllowedIds.length > 0 || discordDmAllowedUsernames.length > 0 ? (
                <div className="space-y-2">
                  {discordDmAllowedIds.map((id) => {
                    const knownUser = discordDmKnownUsers.find((user) => user.id === id);
                    const meta = discordDmUserMeta[id] || { label: '', note: '' };
                    return (
                      <div key={id} className="space-y-2 rounded-lg border border-border px-3 py-2">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm">{knownUser?.username || id}</p>
                            {knownUser?.username && (
                              <p className="text-xs text-muted-foreground">{id}</p>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveDiscordDmUser(id)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                        <div className="grid gap-2">
                          <Input
                            placeholder="Label (e.g., VIP, Friend)"
                            value={meta.label}
                            onChange={(e) => handleUpdateDiscordDmMeta(id, 'label', e.target.value)}
                          />
                          <Input
                            placeholder="Note (optional)"
                            value={meta.note}
                            onChange={(e) => handleUpdateDiscordDmMeta(id, 'note', e.target.value)}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {discordDmAllowedUsernames.map((name) => (
                    <div
                      key={name}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                    >
                      <span className="text-sm">{name}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveDiscordDmUsername(name)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No users added yet.</p>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowDiscordDmConfig(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button onClick={handleSaveDiscordDmConfig} className="flex-1">
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Add Channel Modal */}
      {showAddChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Add Channel</CardTitle>
              <CardDescription>Select the type of channel to configure</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => {
                  setShowAddChannel(false);
                  setShowDiscordDmConfig(true);
                }}
              >
                Discord Bot DMs
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => {
                  setShowAddChannel(false);
                  setShowAddDiscord(true);
                }}
              >
                Discord Account (OAuth or Manual ID)
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => setShowAddChannel(false)}>
                Cancel
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Add Discord Modal */}
      {showAddDiscord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Connect Discord</CardTitle>
              <CardDescription>Link your Discord account to receive messages</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={handleDiscordOAuth} className="w-full">
                <ExternalLink className="mr-2 h-4 w-4" />
                Connect with Discord OAuth
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">Or</span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Manual Discord User ID</label>
                <Input
                  placeholder="123456789012345678"
                  value={manualUserId}
                  onChange={(e) => setManualUserId(e.target.value)}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowAddDiscord(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button onClick={handleManualConnect} className="flex-1">
                  Connect
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
