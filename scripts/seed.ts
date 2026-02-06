import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

async function seed() {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://clifford:clifford@localhost:5432/clifford';
  const client = postgres(connectionString);
  const db = drizzle(client);

  console.log('Seeding database...');

  // Insert demo tenant
  const tenantId = '00000000-0000-0000-0000-000000000000';
  await db.execute(`
    INSERT INTO tenants (id, name)
    VALUES ('${tenantId}', 'Demo Tenant')
    ON CONFLICT (id) DO NOTHING
  `);

  // Insert demo agent
  const agentId = '00000000-0000-0000-0000-000000000001';
  await db.execute(`
    INSERT INTO agents (id, tenant_id, name, enabled, policy_profile)
    VALUES ('${agentId}', '${tenantId}', 'Demo Agent', true, 'default')
    ON CONFLICT (id) DO NOTHING
  `);

  console.log('Seed completed!');
  console.log('Tenant ID:', tenantId);
  console.log('Agent ID:', agentId);

  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
