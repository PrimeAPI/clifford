import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { getDb, runs } from '@clifford/db';
import { and, desc, eq, gte } from 'drizzle-orm';

type Case = {
  id: string;
  channelId: string;
  content: string;
};

type RunRow = {
  id: string;
  status: string;
  outputText: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const BASE_URL = process.env.HARNESS_BASE_URL ?? 'http://localhost:3000';
const USER_ID = process.env.HARNESS_USER_ID ?? '00000000-0000-0000-0000-000000000001';
const TENANT_ID = process.env.HARNESS_TENANT_ID ?? '00000000-0000-0000-0000-000000000000';
const CASES_PATH = process.env.HARNESS_CASES_PATH ?? 'scripts/run-harness-cases.json';
const TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS ?? 60000);
const POLL_MS = Number(process.env.HARNESS_POLL_MS ?? 1500);

async function postMessage(channelId: string, content: string) {
  const res = await fetch(`${BASE_URL}/api/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': USER_ID,
      'x-tenant-id': TENANT_ID,
    },
    body: JSON.stringify({ channelId, content }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/messages failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function findRun(channelId: string, content: string, since: Date): Promise<RunRow | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      outputText: runs.outputText,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
    })
    .from(runs)
    .where(
      and(eq(runs.channelId, channelId), eq(runs.inputText, content), gte(runs.createdAt, since))
    )
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function waitForCompletion(runId: string): Promise<RunRow> {
  const db = getDb();
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({
        id: runs.id,
        status: runs.status,
        outputText: runs.outputText,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (row && (row.status === 'completed' || row.status === 'failed')) {
      return row;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Run ${runId} did not complete within ${TIMEOUT_MS}ms`);
}

async function main() {
  const raw = await readFile(CASES_PATH, 'utf8');
  const cases: Case[] = JSON.parse(raw);
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('No cases found in harness input.');
  }

  const results: Array<{ id: string; runId: string; status: string; ok: boolean }> = [];
  for (const testCase of cases) {
    const start = new Date();
    await postMessage(testCase.channelId, testCase.content);
    const run = await findRun(testCase.channelId, testCase.content, start);
    if (!run) {
      throw new Error(`No run found for case ${testCase.id}`);
    }
    const finalRun = await waitForCompletion(run.id);
    const ok = finalRun.status === 'completed' && Boolean(finalRun.outputText?.trim());
    results.push({ id: testCase.id, runId: finalRun.id, status: finalRun.status, ok });
  }

  const failed = results.filter((item) => !item.ok);
  if (failed.length > 0) {
    console.error('Harness failures:', failed);
    process.exit(1);
  }
  console.log('Harness passed:', results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
