import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => {
    return { ok: true, service: 'api', ts: new Date().toISOString() };
  });
}
