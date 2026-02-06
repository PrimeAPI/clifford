import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();

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
