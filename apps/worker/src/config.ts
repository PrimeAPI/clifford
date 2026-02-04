import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadEnv({ path: resolve(__dirname, '../../../.env') });

export const config = {
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
  maxTurnsPerContext: parseInt(process.env.MAX_TURNS_PER_CONTEXT || '60', 10),
  memoryWriterMaxMessages: parseInt(process.env.MEMORY_WRITER_MAX_MESSAGES || '40', 10),
  runMaxIterations: parseInt(process.env.RUN_MAX_ITERATIONS || '20', 10),
  runMaxIterationsHardCap: parseInt(process.env.RUN_MAX_ITERATIONS_HARD_CAP || '200', 10),
  runTranscriptLimit: parseInt(process.env.RUN_TRANSCRIPT_LIMIT || '50', 10),
  runTranscriptTokenLimit: parseInt(process.env.RUN_TRANSCRIPT_TOKEN_LIMIT || '1200', 10),
  runMaxJsonRetries: parseInt(process.env.RUN_MAX_JSON_RETRIES || '1', 10),
  runMaxToolRetries: parseInt(process.env.RUN_MAX_TOOL_RETRIES || '1', 10),
  runDebugPrompts:
    process.env.RUN_DEBUG_PROMPTS === 'true' ||
    (process.env.NODE_ENV || 'development') === 'development',
  encryptionKey: process.env.DATA_ENCRYPTION_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
};
