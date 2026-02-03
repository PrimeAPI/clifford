import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from project root
config({ path: resolve(__dirname, '../.env') });

async function seedChannels() {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://clifford:clifford@localhost:5433/clifford';
  console.log('Connecting to database...');
  const client = postgres(connectionString);
  const db = drizzle(client);

  console.log('Seeding channels...');

  // Create default user (if not exists)
  const userId = '00000000-0000-0000-0000-000000000001';
  await db.execute(`
    INSERT INTO users (id, email, name, password_hash)
    VALUES ('${userId}', 'demo@clifford.ai', 'Demo User', 'hashed_password')
    ON CONFLICT (id) DO NOTHING
  `);

  // Create default web channel
  await db.execute(`
    INSERT INTO channels (id, user_id, type, name, enabled)
    VALUES (
      '${userId}-web',
      '${userId}',
      'web',
      'Web Interface',
      true
    )
    ON CONFLICT DO NOTHING
  `);

  console.log('Channels seeded!');
  console.log('User ID:', userId);
  console.log('Web Channel ID:', `${userId}-web`);

  await client.end();
}

seedChannels().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
