import { config } from '../../config.js';

export function requireDiscordOutboxToken(req: any, reply: any) {
  const token = req.headers['x-discord-outbox-token'] as string | undefined;
  if (!config.discordOutboxToken || token !== config.discordOutboxToken) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
