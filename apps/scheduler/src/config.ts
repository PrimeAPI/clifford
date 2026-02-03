import { config as loadEnv } from 'dotenv';

loadEnv();

export const config = {
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  schedulerIntervalMs: parseInt(process.env.SCHEDULER_INTERVAL_MS || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
};
