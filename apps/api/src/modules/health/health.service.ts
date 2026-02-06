export function buildHealthPayload() {
  return { ok: true, service: 'api', ts: new Date().toISOString() };
}
