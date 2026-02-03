import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadEnv({ path: resolve(__dirname, '../../../.env') });

export const config = {
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  apiUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
  tenantId: process.env.TENANT_ID || '00000000-0000-0000-0000-000000000000',
  logLevel: process.env.LOG_LEVEL || 'info',
};
