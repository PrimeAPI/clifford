import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadEnv({ path: resolve(__dirname, '../../../.env') });

const envSchema = z
  .object({
    API_PORT: z.coerce.number().int().min(1).default(3001),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    DATA_ENCRYPTION_KEY: z.string().min(1),
    DELIVERY_TOKEN: z.string().min(1).optional(),
    DISCORD_OUTBOX_TOKEN: z.string().min(1).optional(),
    NODE_ENV: z.string().default('development'),
    LOG_LEVEL: z.string().default('info'),
    ALLOWED_DISCORD_USER_IDS: z.string().optional(),
    ALLOWED_DISCORD_USERNAMES: z.string().optional(),
    KNOWN_DISCORD_USERS: z.string().optional(),
    FILE_STORAGE_DIR: z.string().default('/tmp/clifford-uploads'),
    MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
    API_BODY_LIMIT: z.coerce.number().int().min(1024).default(25 * 1024 * 1024),
    MAX_EXTRACTED_TEXT_CHARS: z.coerce.number().int().min(1000).default(30000),
  })
  .refine((env) => env.DELIVERY_TOKEN || env.DISCORD_OUTBOX_TOKEN, {
    message: 'DELIVERY_TOKEN or DISCORD_OUTBOX_TOKEN is required',
    path: ['DELIVERY_TOKEN'],
  });

const env = envSchema.parse(process.env);

function parseJson<T>(value: string | undefined, label: string, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Invalid JSON in ${label}`);
  }
}

const allowedDiscordUserIds = parseJson<unknown[]>(
  env.ALLOWED_DISCORD_USER_IDS,
  'ALLOWED_DISCORD_USER_IDS',
  []
);
const allowedDiscordUsernames = parseJson<unknown[]>(
  env.ALLOWED_DISCORD_USERNAMES,
  'ALLOWED_DISCORD_USERNAMES',
  []
);
const knownDiscordUsers = parseJson<unknown[]>(env.KNOWN_DISCORD_USERS, 'KNOWN_DISCORD_USERS', []);

export const config = {
  port: env.API_PORT,
  host: env.API_HOST,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  encryptionKey: env.DATA_ENCRYPTION_KEY,
  deliveryToken: env.DELIVERY_TOKEN || env.DISCORD_OUTBOX_TOKEN || '',
  discordOutboxToken: env.DISCORD_OUTBOX_TOKEN || '',
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  allowedDiscordUserIds,
  allowedDiscordUsernames,
  knownDiscordUsers,
  fileStorageDir: env.FILE_STORAGE_DIR,
  maxUploadBytes: env.MAX_UPLOAD_BYTES,
  apiBodyLimit: env.API_BODY_LIMIT,
  maxExtractedTextChars: env.MAX_EXTRACTED_TEXT_CHARS,
};
