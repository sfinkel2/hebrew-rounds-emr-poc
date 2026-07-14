// server/tests/smoke.mjs
//
// End-to-end smoke test of the full pipeline in MOCK mode (no API keys, no
// outbound network). Exercises the real Express app in-process:
//
//   reset EMR → GET /api/scripted-round → POST /api/structure
//     → POST /api/judge → approve grounded non-high-risk fields in code
//     → POST /api/commit
//
// and asserts:
//   - the pipeline returns FieldRecord[] at each stage,
//   - the fabricated "no fever" (objective.vitals.temp) field was NOT
//     auto-committed (its grounding fails),
//   - the high-risk opioid (decisions.medications) was NOT auto-committed
//     (high-risk always requires explicit confirmation),
//   - the mock Chameleon EMR state actually updated for the approved fields.
//
// Run AFTER routes/app integration (the Verify phase):  node server/tests/smoke.mjs
// Prints "SMOKE OK" on success; throws (non-zero exit) on any failure.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Force deterministic mock mode regardless of any local .env.
process.env.DEMO_MODE = 'mock';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const __dirname = dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  throw new Error(`SMOKE FAILED: ${msg}`);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

// ── Reset the mock EMR so the smoke run is hermetic. ──────────────────────────
const { resetEmrState } = await import('../scripts/reset.js');
resetEmrState();

// Fixtures (for expectations only; the pipeline itself drives the data).
const { readFileSync } = await import('node:fs');
const dataDir = join(__dirname, '..', 'data');
const seed = JSON.parse(readFileSync(join(dataDir, 'patient.seed.json'), 'utf8'));
const PATIENT_ID = seed.patientId;

// ── Resolve and start the Express app on an ephemeral port. ───────────────────
const appModule = await import('../index.js');
const appCandidate =
  appModule.app ||
  appModule.default ||
  (typeof appModule.createApp === 'function' ? await appModule.createApp() : null);
assert(appCandidate, 'could not resolve an Express app from server/index.js (expected `app`, default, or createApp())');

const server = await new Promise((resolve, reject) => {
  try {
    const s = appCandidate.listen(0, () => resolve(s));
    s.on('error', reject);
  } catch (err) {
    reject(err);
  }
});
const { port } = server.address();
const BASE = `http://127.0.0.1:${port}`;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    fail(`${method} ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    fail(`${method} ${path} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  }
  return json;
}

try {
  // 1) Scripted round.
  const round = await api('GET', '/api/scripted-round');
  assert(round.transcript && typeof round.transcript === 'string', 'scripted-round must return a transcript');
  const transcript = round.transcript;

  // 2) Structure.
  const structResp = await api('POST', '/api/structure', { transcript });
  assert(Array.isArray(structResp.fields) && structResp.fields.length > 0, 'structure must return fields[]');

  // 3) Judge (also runs guardrails server-side and merges results).
  const judgeResp = await api('POST', '/api/judge', { transcript, fields: structResp.fields });
  assert(Array.isArray(judgeResp.fields) && judgeResp.fields.length > 0, 'judge must return fields[]');

  const byId = Object.fromEntries(judgeResp.fields.map((f) => [f.fieldId, f]));

  // The fabricated temp field must have FAILED grounding / require confirmation.
  const temp = byId['objective.vitals.temp'];
  assert(temp, 'judge output must include objective.vitals.temp');
  assert(
    temp.guardrail && (temp.guardrail.passed === false || temp.guardrail.requiresConfirmation === true),
    'the fabricated "no fever" temp field must be flagged by the grounding guardrail',
  );

  // The opioid must be flagged high-risk → requires confirmation despite grounding.
  const meds = byId['decisions.medications'];
  assert(meds, 'judge output must include decisions.medications');
  assert(
    meds.guardrail && meds.guardrail.requiresConfirmation === true,
    'the high-risk opioid must require confirmation',
  );

  // 4) Approve ONLY grounded, non-high-risk fields that need no confirmation.
  //    (This simulates the clinician approving the safe fields; the fabricated
  //     temp and the opioid are deliberately NOT approved.)
  const toCommit = judgeResp.fields.map((f) => {
    const safe =
      f.guardrail &&
      f.guardrail.passed === true &&
      f.guardrail.requiresConfirmation === false &&
      f.judge &&
      f.judge.verdict === 'grounded' &&
      f.judge.highRisk === false;
    return { ...f, status: safe ? 'approved' : f.status };
  });

  const approvedIds = toCommit.filter((f) => f.status === 'approved').map((f) => f.fieldId);
  assert(approvedIds.length > 0, 'expected at least one auto-approvable safe field');
  assert(!approvedIds.includes('objective.vitals.temp'), 'fabricated temp must NOT be auto-approved');
  assert(!approvedIds.includes('decisions.medications'), 'high-risk opioid must NOT be auto-approved');

  // 5) Commit.
  const commitResp = await api('POST', '/api/commit', { patientId: PATIENT_ID, fields: toCommit });
  const emrState = commitResp.emrState || commitResp;
  const note = emrState.note || emrState.fields || {};

  // Approved fields are present in the EMR; the two flagged fields are not
  // newly committed by this run.
  for (const id of approvedIds) {
    assert(note[id], `committed field ${id} must appear in the EMR note`);
  }
  assert(
    note['objective.vitals.temp'] === undefined,
    'the fabricated temp field must NOT be committed to the EMR',
  );
  // decisions.medications is not in the seed note; it must not have been added.
  assert(
    note['decisions.medications'] === undefined,
    'the high-risk opioid must NOT be auto-committed to the EMR',
  );

  // Audit entries exist for the committed fields.
  const audit = commitResp.auditEntries || emrState.auditLog || [];
  assert(Array.isArray(audit) && audit.length >= approvedIds.length, 'audit log must record committed fields');

  console.log(`SMOKE OK (committed ${approvedIds.length} field(s): ${approvedIds.join(', ')})`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
