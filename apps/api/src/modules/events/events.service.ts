import type { FastifyBaseLogger } from 'fastify';

export function logDiscordEvent(logger: FastifyBaseLogger, payload: Record<string, unknown>) {
  logger.info(payload, 'Discord event received');
}
