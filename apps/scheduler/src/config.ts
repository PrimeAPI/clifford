import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadEnv({ path: resolve(__dirname, '../../../.env') });

export const config = {
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  schedulerIntervalMs: parseInt(process.env.SCHEDULER_INTERVAL_MS || '5000', 10),
  autoCloseIntervalMs: parseInt(process.env.AUTO_CLOSE_INTERVAL_MS || '3600000', 10),
  autoCloseInactivityHours: parseInt(process.env.AUTO_CLOSE_INACTIVITY_HOURS || '20', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
};
