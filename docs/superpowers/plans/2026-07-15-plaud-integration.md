# Plaud Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Express app pull a Hebrew round transcript from the presenter's Plaud account at demo time — a picker of recent recordings replaces the browser-mic "Record round" button; the pulled transcript feeds the existing structure → judge → guardrails → commit pipeline unchanged.

**Architecture:** New `server/lib/plaud.js` (DI-injectable REST client over Plaud's developer API, reusing the OAuth token the Plaud MCP login cached at `~/.plaud/tokens-mcp.json`) + `server/routes/plaud.js` (router factory, three GET endpoints). Frontend swaps the mic path for a "Pull from Plaud" button + inline picker. Spec: `docs/superpowers/specs/2026-07-15-plaud-integration-design.md` — read it first; the "Plaud API facts" section is the API contract.

**Tech Stack:** Node 18+ (global `fetch`, `node --test`), Express, vanilla ES-module frontend (no build step), Tailwind via CDN.

**Working directory:** the `plaud-integration` worktree at `C:\Practicum\Practicum_2\.claude\worktrees\plaud-integration`. All paths below are relative to it. Commit after every task.

---

## Chunk 1: Backend

### Task 1: `lib/plaud.js` pure helpers (TDD)

**Files:**
- Create: `server/tests/plaud.test.js`
- Create: `server/lib/plaud.js`

- [ ] **Step 1: Write failing tests for the pure helpers**

Create `server/tests/plaud.test.js`:

```js
// server/tests/plaud.test.js
//
// Plaud integration tests (spec 2026-07-15-plaud-integration-design.md):
//   - pure helpers: transcript payload parsing/joining, token staleness
//   - route contracts via createPlaudRouter(fake client deps) on a bare
//     Express app (in-process HTTP, ephemeral port — same pattern as smoke.mjs)
// No test touches the network or the real ~/.plaud directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseTranscriptPayload,
  joinSegments,
  isTokenStale,
} from '../lib/plaud.js';

// Shape captured from a real GET /open/third-party/files/{id} response.
const FILE_DETAIL = [
  {
    data_id: 'source_transaction:x:y',
    data_type: 'transaction',
    data_title: '',
    data_content: JSON.stringify([
      { content: 'שלום, אני שמואל.', start_time: 30, end_time: 2000, speaker: 'Speaker 1' },
      { content: 'החולה יציב הבוקר.', start_time: 2000, end_time: 4730, speaker: 'Speaker 1' },
    ]),
    data_link: '',
  },
  { data_id: 'source_outline:x:y', data_type: 'outline', data_title: '', data_content: '[]', data_link: '' },
];

test('parseTranscriptPayload extracts segments from the transaction item', () => {
  const segments = parseTranscriptPayload(FILE_DETAIL);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].content, 'שלום, אני שמואל.');
});

test('parseTranscriptPayload returns null when there is no transaction item', () => {
  const detail = FILE_DETAIL.filter((d) => d.data_type !== 'transaction');
  assert.equal(parseTranscriptPayload(detail), null);
});

test('parseTranscriptPayload returns null on malformed data_content JSON', () => {
  const detail = [{ data_type: 'transaction', data_content: 'not json' }];
  assert.equal(parseTranscriptPayload(detail), null);
});

test('parseTranscriptPayload returns null on non-array input', () => {
  assert.equal(parseTranscriptPayload(null), null);
  assert.equal(parseTranscriptPayload({}), null);
});

test('joinSegments joins content strings with newlines, skipping empties', () => {
  const segments = parseTranscriptPayload(FILE_DETAIL);
  assert.equal(joinSegments(segments), 'שלום, אני שמואל.\nהחולה יציב הבוקר.');
  assert.equal(joinSegments([{ content: 'א' }, { content: '' }, {}, { content: 'ב' }]), 'א\nב');
});

test('isTokenStale: absent expires_at is never stale', () => {
  assert.equal(isTokenStale({ access_token: 'x' }, Date.now()), false);
});

test('isTokenStale honors the 60s skew', () => {
  const now = 1_000_000_000;
  assert.equal(isTokenStale({ expires_at: now + 120_000 }, now), false); // fresh
  assert.equal(isTokenStale({ expires_at: now + 30_000 }, now), true);   // inside skew
  assert.equal(isTokenStale({ expires_at: now - 1 }, now), true);        // expired
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/tests/plaud.test.js`
Expected: FAIL — `Cannot find module '.../server/lib/plaud.js'`

- [ ] **Step 3: Create `server/lib/plaud.js` with helpers + client factory**

Full file (the client is exercised by Task 2's tests; writing it now keeps the module whole):

```js
// server/lib/plaud.js
//
// Plaud developer-API client (spec docs/superpowers/specs/
// 2026-07-15-plaud-integration-design.md). Pulls the recording list and a
// recording's Hebrew transcript so the demo can capture a round from the
// presenter's Plaud device instead of the browser mic.
//
// Auth: reuses the OAuth token the Plaud MCP login cached at
// ~/.plaud/tokens-mcp.json ({access_token, refresh_token, token_type,
// expires_at?}). We refresh when stale (same 60s-skew rule as the MCP) or on
// a 401, persist the rotated token back in the same shape, and retry once.
// FRAGILITY: the token file location/shape is an internal detail of
// @plaud-ai/mcp (verified against v0.3.5). If a future MCP version moves it,
// everything degrades to plaud_not_connected and this file needs a one-line
// update.
//
// Deliberately deterministic/testable: fetch, token path, and clock are
// injectable via createPlaudClient({ fetchImpl, tokenPath, now }).
// Tokens are read server-side only and never sent to the browser.

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API_BASE = 'https://platform.plaud.ai/developer/api';
const REFRESH_URL = `${API_BASE}/oauth/third-party/access-token/refresh`;
const TOKEN_SKEW_MS = 60_000;
const LIST_PAGE_SIZE = 10;

const DEFAULT_TOKEN_PATH = join(homedir(), '.plaud', 'tokens-mcp.json');

/** Typed failure; routes map .code to the shared error envelope. */
export class PlaudError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlaudError';
    this.code = code;
  }
}

/** Stale when an expiry exists and we are within 60s of it (MCP's own rule). */
export function isTokenStale(tokenSet, nowMs) {
  if (!tokenSet || typeof tokenSet.expires_at !== 'number') return false;
  return nowMs > tokenSet.expires_at - TOKEN_SKEW_MS;
}

/**
 * Extract transcript segments from a GET /files/{id} payload: the item with
 * data_type "transaction" carries a JSON-encoded segment array in
 * data_content. Returns the parsed segments, or null when the recording has
 * not been transcribed (or the payload is malformed).
 */
export function parseTranscriptPayload(fileDetail) {
  if (!Array.isArray(fileDetail)) return null;
  const item = fileDetail.find((d) => d && d.data_type === 'transaction');
  if (!item || typeof item.data_content !== 'string' || !item.data_content) return null;
  let segments;
  try {
    segments = JSON.parse(item.data_content);
  } catch {
    return null;
  }
  return Array.isArray(segments) ? segments : null;
}

/**
 * Join segment contents with newlines (no speaker labels — spec non-goal).
 * The result is BOTH what the UI displays and what /api/structure receives;
 * the grounding guardrail depends on those being identical.
 */
export function joinSegments(segments) {
  return segments
    .map((s) => (s && typeof s.content === 'string' ? s.content : ''))
    .filter(Boolean)
    .join('\n');
}

export function createPlaudClient({
  fetchImpl = fetch,
  tokenPath = DEFAULT_TOKEN_PATH,
  now = Date.now,
} = {}) {
  async function loadTokens() {
    let raw;
    try {
      raw = await readFile(tokenPath, 'utf8');
    } catch {
      throw new PlaudError(
        'plaud_not_connected',
        'Plaud is not connected on this machine — run the Plaud MCP login first.',
      );
    }
    let tokens;
    try {
      tokens = JSON.parse(raw);
    } catch {
      tokens = null;
    }
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
      throw new PlaudError(
        'plaud_not_connected',
        'The Plaud token file is unreadable — run the Plaud MCP login again.',
      );
    }
    return tokens;
  }

  async function refreshTokens(tokens) {
    if (!tokens.refresh_token) {
      throw new PlaudError(
        'plaud_not_connected',
        'The Plaud session expired and no refresh token is available — run the Plaud MCP login again.',
      );
    }
    let res;
    try {
      res = await fetchImpl(REFRESH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ refresh_token: tokens.refresh_token }),
      });
    } catch (err) {
      throw new PlaudError('plaud_not_connected', `Plaud token refresh failed: ${err.message}`);
    }
    if (!res.ok) {
      throw new PlaudError(
        'plaud_not_connected',
        `Plaud token refresh failed (HTTP ${res.status}) — run the Plaud MCP login again.`,
      );
    }
    const data = await res.json();
    const next = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      token_type: data.token_type ?? 'Bearer',
      ...(data.expires_in ? { expires_at: now() + data.expires_in * 1000 } : {}),
    };
    // Best-effort persist (same shape the MCP writes); an unwritable file
    // only costs us a refresh on the next call.
    try {
      await writeFile(tokenPath, JSON.stringify(next, null, 2), 'utf8');
    } catch { /* ignore */ }
    return next;
  }

  async function doGet(path, tokens) {
    try {
      return await fetchImpl(`${API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new PlaudError('plaud_upstream_error', `Cannot reach Plaud: ${err.message}`);
    }
  }

  /** GET with the full auth dance: pre-refresh if stale, refresh+retry on 401. */
  async function apiGet(path) {
    let tokens = await loadTokens();
    if (isTokenStale(tokens, now())) tokens = await refreshTokens(tokens);
    let res = await doGet(path, tokens);
    if (res.status === 401) {
      tokens = await refreshTokens(tokens);
      res = await doGet(path, tokens);
    }
    if (!res.ok) {
      throw new PlaudError('plaud_upstream_error', `Plaud API error (HTTP ${res.status}).`);
    }
    try {
      return await res.json();
    } catch {
      throw new PlaudError('plaud_upstream_error', 'Plaud API returned malformed JSON.');
    }
  }

  return {
    /** Token file exists and parses — no network call (used by /status). */
    async isConnected() {
      try {
        await loadTokens();
        return true;
      } catch {
        return false;
      }
    },

    /** Newest recordings, trimmed for the picker. Names are user data — verbatim. */
    async listRecordings() {
      const data = await apiGet(`/open/third-party/files/?page=1&page_size=${LIST_PAGE_SIZE}`);
      const rows = Array.isArray(data?.data) ? data.data : [];
      return rows.map((r) => ({
        id: r.id,
        name: r.name ?? '',
        startAt: r.start_at ?? r.created_at ?? null,
        durationMs: typeof r.duration === 'number' ? r.duration : null,
      }));
    },

    /** One plain Hebrew transcript string for the round. */
    async getTranscript(fileId) {
      const detail = await apiGet(`/open/third-party/files/${encodeURIComponent(fileId)}`);
      const segments = parseTranscriptPayload(detail);
      const transcript = segments ? joinSegments(segments) : '';
      if (!transcript) {
        throw new PlaudError(
          'plaud_no_transcript',
          'This recording has no transcript yet — transcribe it in the Plaud app, then retry.',
        );
      }
      return { transcript };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/tests/plaud.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/lib/plaud.js server/tests/plaud.test.js
git commit -m "feat(plaud): REST client lib with injectable fetch/token-path and pure transcript helpers"
```

### Task 2: `routes/plaud.js` router factory (TDD)

**Files:**
- Create: `server/routes/plaud.js`
- Modify: `server/tests/plaud.test.js` (append route-contract tests)

- [ ] **Step 1: Append failing route-contract tests**

Append to `server/tests/plaud.test.js`:

```js
// ── Route contracts ──────────────────────────────────────────────────────────
import express from 'express';
import { createPlaudClient } from '../lib/plaud.js';
import { createPlaudRouter } from '../routes/plaud.js';

const API = 'https://platform.plaud.ai/developer/api';
const LIST_URL = `${API}/open/third-party/files/?page=1&page_size=10`;
const REFRESH = `${API}/oauth/third-party/access-token/refresh`;

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** fake fetch: routes each URL to a queue of responses; records calls. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [prefix, responses] of routes) {
      if (String(url).startsWith(prefix)) {
        const r = responses.shift();
        if (!r) throw new Error(`fakeFetch: exhausted responses for ${prefix}`);
        return typeof r === 'function' ? r() : r;
      }
    }
    throw new Error(`fakeFetch: unrouted URL ${url}`);
  };
  impl.calls = calls;
  return impl;
}

async function withApp(client, fn) {
  const app = express();
  app.use('/api', createPlaudRouter(client));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function tempTokenFile(tokens) {
  const dir = await mkdtemp(join(tmpdir(), 'plaud-test-'));
  const path = join(dir, 'tokens-mcp.json');
  if (tokens) await writeFile(path, JSON.stringify(tokens), 'utf8');
  return { dir, path };
}

const FRESH = { access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer' };
const LISTING = {
  type: 'list',
  data: [
    { id: 'f1', name: 'סבב בוקר', created_at: '2026-07-15T06:57:45', start_at: '2026-07-15T06:57:25', duration: 8000 },
  ],
  page: 1,
  page_size: 10,
};

test('GET /api/plaud/status reflects token-file presence', async () => {
  const missing = createPlaudClient({ fetchImpl: fakeFetch([]), tokenPath: join(tmpdir(), 'nope', 'tokens-mcp.json') });
  await withApp(missing, async (base) => {
    const res = await fetch(`${base}/api/plaud/status`);
    assert.deepEqual(await res.json(), { connected: false });
  });

  const { dir, path } = await tempTokenFile(FRESH);
  try {
    const connected = createPlaudClient({ fetchImpl: fakeFetch([]), tokenPath: path });
    await withApp(connected, async (base) => {
      const res = await fetch(`${base}/api/plaud/status`);
      assert.deepEqual(await res.json(), { connected: true });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/plaud/recordings returns trimmed rows with a Bearer header', async () => {
  const { dir, path } = await tempTokenFile(FRESH);
  try {
    const ff = fakeFetch([[LIST_URL, [jsonRes(LISTING)]]]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path });
    await withApp(client, async (base) => {
      const res = await fetch(`${base}/api/plaud/recordings`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        recordings: [{ id: 'f1', name: 'סבב בוקר', startAt: '2026-07-15T06:57:25', durationMs: 8000 }],
      });
      assert.equal(ff.calls[0].opts.headers.Authorization, 'Bearer AT');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing token file → 503 plaud_not_connected envelope', async () => {
  const client = createPlaudClient({ fetchImpl: fakeFetch([]), tokenPath: join(tmpdir(), 'nope', 'tokens-mcp.json') });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/api/plaud/recordings`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'plaud_not_connected');
    assert.ok(body.error.message);
  });
});

test('stale token → refresh first, rotated token persisted, then data', async () => {
  const now = 2_000_000_000_000;
  const { dir, path } = await tempTokenFile({ ...FRESH, expires_at: now - 1 });
  try {
    const ff = fakeFetch([
      [REFRESH, [jsonRes({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 })]],
      [LIST_URL, [jsonRes(LISTING)]],
    ]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path, now: () => now });
    await withApp(client, async (base) => {
      const res = await fetch(`${base}/api/plaud/recordings`);
      assert.equal(res.status, 200);
    });
    // Refresh happened first, as form-urlencoded refresh_token.
    assert.ok(ff.calls[0].url.startsWith(REFRESH));
    assert.equal(String(ff.calls[0].opts.body), 'refresh_token=RT');
    // Data call used the rotated token.
    assert.equal(ff.calls[1].opts.headers.Authorization, 'Bearer AT2');
    // Rotated set persisted in the MCP's shape.
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(persisted.access_token, 'AT2');
    assert.equal(persisted.refresh_token, 'RT2');
    assert.equal(persisted.expires_at, now + 3_600_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('401 from Plaud → single refresh + retry → success', async () => {
  const { dir, path } = await tempTokenFile(FRESH);
  try {
    const ff = fakeFetch([
      [REFRESH, [jsonRes({ access_token: 'AT2' })]],
      [LIST_URL, [jsonRes({}, 401), jsonRes(LISTING)]],
    ]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path });
    await withApp(client, async (base) => {
      const res = await fetch(`${base}/api/plaud/recordings`);
      assert.equal(res.status, 200);
    });
    assert.equal(ff.calls.length, 3); // list(401) → refresh → list(200)
    assert.equal(ff.calls[2].opts.headers.Authorization, 'Bearer AT2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recording without a transcript → 502 plaud_no_transcript', async () => {
  const { dir, path } = await tempTokenFile(FRESH);
  try {
    const detail = [{ data_type: 'mark_memo', data_content: '' }];
    const ff = fakeFetch([[`${API}/open/third-party/files/f9`, [jsonRes(detail)]]]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path });
    await withApp(client, async (base) => {
      const res = await fetch(`${base}/api/plaud/recordings/f9/transcript`);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.code, 'plaud_no_transcript');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transcript happy path returns the joined Hebrew string', async () => {
  const { dir, path } = await tempTokenFile(FRESH);
  try {
    const ff = fakeFetch([[`${API}/open/third-party/files/f1`, [jsonRes(FILE_DETAIL)]]]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path });
    await withApp(client, async (base) => {
      const res = await fetch(`${base}/api/plaud/recordings/f1/transcript`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { transcript: 'שלום, אני שמואל.\nהחולה יציב הבוקר.' });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test server/tests/plaud.test.js`
Expected: FAIL — `Cannot find module '.../server/routes/plaud.js'`. Note: because the import is a static ESM import in the same file, the **whole file fails to load** — the 7 helper tests won't run again until the module resolves. That is the expected TDD red state here.

- [ ] **Step 3: Create `server/routes/plaud.js`**

```js
// server/routes/plaud.js
//
// GET /api/plaud/status                      -> { connected }
// GET /api/plaud/recordings                  -> { recordings: [{id,name,startAt,durationMs}] }
// GET /api/plaud/recordings/:id/transcript   -> { transcript }
//
// Thin HTTP layer over lib/plaud.js. Exported as a factory so tests inject a
// client built with fake fetch + temp token file (the DI seam from the spec).
// Errors use the shared { error: { code, message } } envelope:
//   plaud_not_connected → 503, everything else → 502.

import { Router } from 'express';
import { createPlaudClient, PlaudError } from '../lib/plaud.js';

function sendPlaudError(res, err) {
  const code = err instanceof PlaudError ? err.code : 'plaud_upstream_error';
  const status = code === 'plaud_not_connected' ? 503 : 502;
  res.status(status).json({
    error: { code, message: err.message || 'Plaud request failed.' },
  });
}

export function createPlaudRouter(plaudClient = createPlaudClient()) {
  const router = Router();

  router.get('/plaud/status', async (_req, res) => {
    res.json({ connected: await plaudClient.isConnected() });
  });

  router.get('/plaud/recordings', async (_req, res) => {
    try {
      res.json({ recordings: await plaudClient.listRecordings() });
    } catch (err) {
      sendPlaudError(res, err);
    }
  });

  router.get('/plaud/recordings/:id/transcript', async (req, res) => {
    try {
      res.json(await plaudClient.getTranscript(req.params.id));
    } catch (err) {
      sendPlaudError(res, err);
    }
  });

  return router;
}

export default createPlaudRouter;
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `node --test server/tests/plaud.test.js`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add server/routes/plaud.js server/tests/plaud.test.js
git commit -m "feat(plaud): /api/plaud routes via injectable router factory"
```

### Task 3: Mount routes + fix mode resolution

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Mount the Plaud router**

In `server/index.js`, after the `emrRoute` import (line 29) add:

```js
import createPlaudRouter from './routes/plaud.js';
```

After `app.use('/api', emrRoute);` (line 64) add:

```js
  app.use('/api', createPlaudRouter());
```

- [ ] **Step 2: LIVE no longer requires the OpenAI key**

The UI no longer calls `/api/transcribe`, so Whisper must not gate liveness (spec "Mode badge"). Replace `resolveMode()` (lines 35–45) with:

```js
/**
 * Resolve the operating mode from the environment.
 * MOCK when DEMO_MODE=mock (forced) or when ANTHROPIC_API_KEY is absent.
 * Structure/judge are the only LLM steps the UI drives (the Plaud pull is
 * plain REST; mic/Whisper was removed from the UI), so Claude alone decides.
 * @returns {'MOCK'|'LIVE'}
 */
export function resolveMode() {
  if ((process.env.DEMO_MODE || '').toLowerCase() === 'mock') return 'MOCK';
  return Boolean((process.env.ANTHROPIC_API_KEY || '').trim()) ? 'LIVE' : 'MOCK';
}
```

- [ ] **Step 3: Update the two stale "Whisper + Claude" mentions**

Line 10 header comment: `LIVE (Whisper + Claude)` → `LIVE (Claude structure/judge)`.
Line 100 startup log: `'  (live Whisper + Claude)'` → `'  (live Claude structure + judge)'`.

- [ ] **Step 4: Verify the whole suite + a real boot**

Run: `npm test`
Expected: PASS (all files, including the 14 plaud tests)

Run (from the worktree root — the import path is cwd-relative): `node -e "const m = await import('./server/index.js'); const s = m.default.listen(0, async () => { const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/plaud/status'); console.log(r.status, await r.json()); s.close(); });" --input-type=module`
Expected: `200 { connected: true }` (this machine has the token file; on a machine without it, `connected: false` — both prove the route is mounted)

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat(plaud): mount /api/plaud routes; LIVE mode keys off Anthropic only"
```

---

## Chunk 2: Frontend + docs

### Task 4: Remove the mic path (HTML, JS, strings)

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`

No server tests cover the frontend; verification is `npm test` (unchanged) + browser check in Task 6.

- [ ] **Step 1: Remove mic markup from `public/index.html`**

Delete the `#btn-record` button block (lines 90–94):

```html
          <button id="btn-record"
                  class="inline-flex items-center gap-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold px-4 py-2.5 shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed">
            <span id="record-dot" class="h-2.5 w-2.5 rounded-full bg-white/90"></span>
            <span id="record-label">Record round</span>
          </button>
```

Delete the whole "Recording indicator + waveform" block, `#record-status` (lines 101–110, including the `recLabel` span, `#waveform` canvas, and `#record-timer`). Change the comment above `#capture-error` from `<!-- Mic-permission / capture error banner -->` to `<!-- Capture error banner -->`.

Update the static English baseline of the two reworded strings:
- stepper (line ~73): `1 · Record / Transcribe` → `1 · Pull / Transcribe`
- transcript placeholder (line ~120): `The transcript will appear here after recording or choosing the scripted round…` → `The transcript will appear here after pulling from Plaud or choosing the scripted round…`

- [ ] **Step 2: Remove mic code from `public/app.js`**

Delete, in the CAPTURE VIEW section:
- the module vars `mediaRecorder`, `audioChunks`, `audioCtx`, `analyser`, `rafId`, `recordTimerId`, `recordStart` (lines 504–506)
- `startRecording`, `stopRecording`, `onRecordingStopped` (lines 546–610)
- the whole `--- waveform + timer ---` block: `startWaveform`, `stopWaveform`, `startTimer`, `stopTimer` (lines 612–655)

Delete in `applyLanguage()` (line 261 — leaving it null-derefs at startup):

```js
  $('#record-label').textContent = state.recording ? t('btnStop') : t('btnRecord');
```

Delete the `recording: false,` key from the `state` object (line 286) and the wiring line in `init()` (line 1000):

```js
  $('#btn-record').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
```

- [ ] **Step 3: Strings — delete mic-only keys, reword shared keys (BOTH `en` and `he`)**

Delete from both dicts: `btnRecord`, `btnStop`, `recLabel`, `transcribing`, `transcribeFailedShort`, `errNoMediaRecorder`, `errMicDenied`, `errNoMic`, `errNoAudio`, `errEmptyTranscript`, `errTranscribe`.

Reword in `en`:

```js
    step1: '1 · Pull / Transcribe',
    transcriptPlaceholder: 'The transcript will appear here after pulling from Plaud or choosing the scripted round…',
    errNoTranscript: 'There is no transcript to structure. Pull from Plaud or choose the scripted round.',
    modeLive: '● LIVE mode (Claude)',
```

Reword in `he`:

```js
    step1: '1 · משיכה / תמלול',
    transcriptPlaceholder: 'התמלול יופיע כאן לאחר משיכה מ-Plaud או בחירת הסבב המתוסרט…',
    errNoTranscript: 'אין תמלול לבנות ממנו. משוך מ-Plaud או בחר את הסבב המתוסרט.',
    modeLive: '● מצב LIVE (Claude)',
```

- [ ] **Step 4: Update the stale header comments in `app.js`**

Line 7 area list: `capture-view   — MediaRecorder + scripted-round fallback + live transcript` → `capture-view   — Plaud pull + scripted-round fallback + live transcript`.

Backend contract block (lines 12–19): remove the `POST /api/transcribe (multipart audio) -> { transcript }` line and add:

```js
//   GET  /api/plaud/status         -> { connected }
//   GET  /api/plaud/recordings     -> { recordings }
//   GET  /api/plaud/recordings/:id/transcript -> { transcript }
```

- [ ] **Step 5: Verify + commit**

Run: `npm test` — Expected: PASS (frontend untested server-side; this catches accidental server edits).
Quick sanity: `node --check public/app.js` — Expected: no output (syntax OK).

```bash
git add public/index.html public/app.js
git commit -m "feat(plaud): remove browser-mic capture path (Plaud replaces it; scripted round remains the offline fallback)"
```

### Task 5: Add the Plaud button + picker

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`

- [ ] **Step 1: Markup**

Where `#btn-record` used to be (before `#btn-scripted`), add:

```html
          <button id="btn-plaud"
                  disabled
                  class="inline-flex items-center gap-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold px-4 py-2.5 shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed">
            <span data-i18n="btnPlaud">Pull from Plaud</span>
          </button>
```

After the buttons row (`</div>` closing `flex flex-wrap gap-3 mb-4`), add the picker panel:

```html
        <!-- Plaud recording picker (hidden until "Pull from Plaud") -->
        <div id="plaud-picker" class="hidden mb-3 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-slate-600" data-i18n="plaudPickerTitle">Choose a Plaud recording</span>
            <button id="plaud-picker-close" class="text-xs text-slate-500 hover:text-slate-700 underline" data-i18n="plaudPickerClose">Close</button>
          </div>
          <div id="plaud-picker-body" class="space-y-1.5"></div>
        </div>
```

- [ ] **Step 2: New strings (BOTH dicts)**

`en` additions:

```js
    btnPlaud: 'Pull from Plaud',
    plaudPickerTitle: 'Choose a Plaud recording',
    plaudPickerClose: 'Close',
    plaudLoading: 'Loading recordings…',
    plaudEmpty: 'No recordings found on this Plaud account.',
    plaudNotConnectedHint: 'Plaud is not connected. Run the Plaud MCP login on this machine first.',
    plaudNoTranscript: 'This recording has no transcript yet. Transcribe it in the Plaud app, then try again.',
    plaudPullFailed: 'Pulling from Plaud failed: {msg}',
```

`he` additions:

```js
    btnPlaud: 'משוך מ-Plaud',
    plaudPickerTitle: 'בחר הקלטת Plaud',
    plaudPickerClose: 'סגור',
    plaudLoading: 'טוען הקלטות…',
    plaudEmpty: 'לא נמצאו הקלטות בחשבון ה-Plaud.',
    plaudNotConnectedHint: 'Plaud אינו מחובר. יש להריץ תחילה התחברות Plaud MCP במחשב זה.',
    plaudNoTranscript: 'להקלטה זו אין עדיין תמלול. יש לתמלל אותה באפליקציית Plaud ולנסות שוב.',
    plaudPullFailed: 'המשיכה מ-Plaud נכשלה: {msg}',
```

- [ ] **Step 3: Controller code**

Add `plaudConnected: false,` to the `state` object.

Add to the CAPTURE VIEW section (after `useScriptedRound`):

```js
// --- Plaud pull ---
async function initPlaudButton() {
  const btn = $('#btn-plaud');
  try {
    const s = await api('/api/plaud/status');
    state.plaudConnected = Boolean(s.connected);
  } catch {
    state.plaudConnected = false;
  }
  btn.disabled = !state.plaudConnected;
  btn.title = state.plaudConnected ? '' : t('plaudNotConnectedHint');
}

function closePlaudPicker() {
  $('#plaud-picker').classList.add('hidden');
}

function plaudErrorMessage(e) {
  if (e.code === 'plaud_not_connected') return t('plaudNotConnectedHint');
  if (e.code === 'plaud_no_transcript') return t('plaudNoTranscript');
  return t('plaudPullFailed', { msg: e.message });
}

function formatDurationMs(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function openPlaudPicker() {
  clearCaptureError();
  const body = $('#plaud-picker-body');
  $('#plaud-picker').classList.remove('hidden');
  body.innerHTML = `<div class="text-sm text-slate-400">${esc(t('plaudLoading'))}</div>`;
  try {
    const data = await api('/api/plaud/recordings');
    renderPlaudRecordings(data.recordings || []);
  } catch (e) {
    closePlaudPicker();
    showCaptureError(plaudErrorMessage(e));
  }
}

function renderPlaudRecordings(recordings) {
  const body = $('#plaud-picker-body');
  if (!recordings.length) {
    body.innerHTML = `<div class="text-sm text-slate-400">${esc(t('plaudEmpty'))}</div>`;
    return;
  }
  body.innerHTML = '';
  for (const r of recordings) {
    const row = el('button',
      'w-full flex items-center justify-between gap-3 rounded-lg bg-white ring-1 ring-slate-200 hover:ring-brand-400 px-3 py-2 text-start text-sm transition disabled:opacity-60');
    const when = r.startAt
      ? new Date(r.startAt).toLocaleString(currentLang === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })
      : '';
    // Recording names are user data — rendered verbatim, dir="auto".
    row.innerHTML = `<span class="font-medium text-slate-700 truncate" dir="auto">${esc(r.name)}</span>
      <span class="shrink-0 text-xs tabular-nums text-slate-500" dir="ltr">${esc(when)} · ${esc(formatDurationMs(r.durationMs))}</span>`;
    row.addEventListener('click', () => pullPlaudTranscript(r.id, row));
    body.appendChild(row);
  }
}

async function pullPlaudTranscript(id, row) {
  row.disabled = true;
  try {
    const data = await api(`/api/plaud/recordings/${encodeURIComponent(id)}/transcript`);
    setTranscript(data.transcript || '');
    closePlaudPicker();
    clearCaptureError();
    setStep('capture');
  } catch (e) {
    // Transcript pane deliberately untouched on failure (spec: no partial state).
    showCaptureError(plaudErrorMessage(e));
  } finally {
    row.disabled = false;
  }
}
```

- [ ] **Step 4: Wiring + language integration**

In `init()`, where the `#btn-record` listener used to be:

```js
  $('#btn-plaud').addEventListener('click', openPlaudPicker);
  $('#plaud-picker-close').addEventListener('click', closePlaudPicker);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlaudPicker(); });
```

At the end of `init()` (next to `detectMode()`): `initPlaudButton();`

In `applyLanguage()`, where the `#record-label` line used to be:

```js
  const plaudBtn = $('#btn-plaud');
  if (plaudBtn) plaudBtn.title = state.plaudConnected ? '' : t('plaudNotConnectedHint');
  closePlaudPicker(); // row timestamps are locale-formatted; reopen re-renders them
```

(Static labels — `btnPlaud`, `plaudPickerTitle`, `plaudPickerClose` — are covered by the `data-i18n` walk.)

- [ ] **Step 5: Verify + commit**

Run: `node --check public/app.js` — Expected: no output.
Run: `npm test` — Expected: PASS.

```bash
git add public/index.html public/app.js
git commit -m "feat(plaud): Pull-from-Plaud button + recording picker in the capture panel"
```

### Task 6: Docs + end-to-end verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/how-to-use-the-demo.html`

- [ ] **Step 1: CLAUDE.md**

After the "MOCK vs LIVE mode" section add:

```markdown
## Plaud capability (live-only)

`server/lib/plaud.js` + `routes/plaud.js` pull a round's Hebrew transcript from
the presenter's Plaud account (`GET /api/plaud/status | /recordings |
/recordings/:id/transcript`). Auth reuses the OAuth token the **Plaud MCP
login** cached at `~/.plaud/tokens-mcp.json` (refresh-and-persist on expiry/401);
there is no in-app OAuth flow — "not connected" means run the MCP login again.
The token file location/shape is an internal detail of `@plaud-ai/mcp`
(verified v0.3.5) — if it moves, update `DEFAULT_TOKEN_PATH` in `lib/plaud.js`.
Plaud has no mock mode: offline demos use the scripted round. The browser-mic
recording path was removed from the UI (Whisper transcribe code remains
server-side but nothing calls it), so LIVE mode is resolved from
`ANTHROPIC_API_KEY` alone (`resolveMode()` in `server/index.js`).
```

Also update the "MOCK vs LIVE mode" sentence "transcribe is live only with `OPENAI_API_KEY` (Whisper)" to note the UI no longer exercises transcribe.

- [ ] **Step 2: Presenter guide**

In `docs/how-to-use-the-demo.html`, find the step describing mic recording ("Record round") and replace it with the Plaud flow: record the round on the Plaud device → let the Plaud app sync + transcribe it → click **Pull from Plaud** → pick the recording. Keep the scripted-round fallback step as-is. Then sweep the **whole file** for other mic/microphone mentions (e.g. line ~102 "live microphone + live AI path") and update them too. Match the file's existing markup/style (read it first; adjust wording, don't restructure).

- [ ] **Step 3: Full suite + live browser verification**

Run: `npm test` — Expected: all pass.
Run: `npm start`, open http://localhost:3000, then verify (Playwright or manually):
1. "Pull from Plaud" button present; mic button gone; no console errors on load (the removed-element null-derefs would throw here).
2. Language toggle EN↔HE flips cleanly with the picker open and closed.
3. Click "Pull from Plaud" → your real recordings listed (this machine is connected) → pick the 2026-07-15 09:57 clip → Hebrew transcript fills the pane → "Structure & check" enables.
4. Scripted round still works end-to-end in MOCK mode (grounding trap intact).
5. With `ANTHROPIC_API_KEY` set in `.env`: badge shows LIVE; a pulled Plaud transcript structures live end-to-end (structure → judge → approve → commit).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/how-to-use-the-demo.html
git commit -m "docs: Plaud capability notes (CLAUDE.md) + presenter guide update"
```
