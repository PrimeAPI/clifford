import type { FastifyInstance } from 'fastify';
import { buildHealthPayload } from './health.service.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => buildHealthPayload());
}
