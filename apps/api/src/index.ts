import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { runRoutes } from './routes/runs.js';
import { eventRoutes } from './routes/events.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
});

await app.register(cors);
await app.register(healthRoutes);
await app.register(runRoutes);
await app.register(eventRoutes);

const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`API server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
