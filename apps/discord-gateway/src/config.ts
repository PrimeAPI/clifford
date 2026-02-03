import { config as loadEnv } from 'dotenv';

loadEnv();

export const config = {
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  apiUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
  tenantId: process.env.TENANT_ID || '00000000-0000-0000-0000-000000000000',
  logLevel: process.env.LOG_LEVEL || 'info',
};
