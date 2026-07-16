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
  toClientSegments,
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

// The live GET /open/third-party/files/{id} endpoint returns a file OBJECT
// with the data items under `source_list` (the Plaud MCP unwraps that field
// in its get_transcript tool — verified against @plaud-ai/mcp v0.3.5 and a
// real API response on 2026-07-15).
test('parseTranscriptPayload unwraps the file-object source_list shape', () => {
  const fileObject = { id: 'f1', name: 'סבב בוקר', source_list: FILE_DETAIL };
  const segments = parseTranscriptPayload(fileObject);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].content, 'שלום, אני שמואל.');
  assert.equal(parseTranscriptPayload({ id: 'f1', source_list: [] }), null);
});

test('joinSegments joins content strings with newlines, skipping empties', () => {
  const segments = parseTranscriptPayload(FILE_DETAIL);
  assert.equal(joinSegments(segments), 'שלום, אני שמואל.\nהחולה יציב הבוקר.');
  assert.equal(joinSegments([{ content: 'א' }, { content: '' }, {}, { content: 'ב' }]), 'א\nב');
});

test('toClientSegments trims to {content, startMs, endMs} and nulls bad times', () => {
  const raw = parseTranscriptPayload(FILE_DETAIL);
  assert.deepEqual(toClientSegments(raw), [
    { content: 'שלום, אני שמואל.', startMs: 30, endMs: 2000 },
    { content: 'החולה יציב הבוקר.', startMs: 2000, endMs: 4730 },
  ]);
  assert.deepEqual(toClientSegments([{ content: 'א', start_time: 'x', end_time: null }]), [
    { content: 'א', startMs: null, endMs: null },
  ]);
});

// The client matches spans against these segments assuming their joined
// contents ARE the transcript — same keep/drop rule as joinSegments.
test('toClientSegments alignment invariant with joinSegments', () => {
  const raw = [
    { content: 'א', start_time: 0, end_time: 1 },
    { content: '', start_time: 1, end_time: 2 },
    {},
    { content: 'ב', start_time: 2, end_time: 3 },
  ];
  assert.equal(
    toClientSegments(raw).map((s) => s.content).join('\n'),
    joinSegments(raw),
  );
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

test('network failure during refresh → 502 plaud_upstream_error (not not_connected)', async () => {
  const now = 2_000_000_000_000;
  const { dir, path } = await tempTokenFile({ ...FRESH, expires_at: now - 1 });
  try {
    const ff = fakeFetch([
      [REFRESH, [() => { throw new Error('boom'); }]],
    ]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path, now: () => now });
    await withApp(client, async (base) => {
      const res = await fetch(`${base}/api/plaud/recordings`);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.code, 'plaud_upstream_error');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent stale requests share one refresh (single-flight)', async () => {
  const now = 2_000_000_000_000;
  const { dir, path } = await tempTokenFile({ ...FRESH, expires_at: now - 1 });
  try {
    const ff = fakeFetch([
      [REFRESH, [jsonRes({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 })]],
      [LIST_URL, [jsonRes(LISTING), jsonRes(LISTING)]],
    ]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path, now: () => now });
    await withApp(client, async (base) => {
      const [a, b] = await Promise.all([
        fetch(`${base}/api/plaud/recordings`),
        fetch(`${base}/api/plaud/recordings`),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
    });
    assert.equal(ff.calls.filter((c) => c.url.startsWith(REFRESH)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh 200 without access_token → 502 and nothing persisted', async () => {
  const now = 2_000_000_000_000;
  const { dir, path } = await tempTokenFile({ ...FRESH, expires_at: now - 1 });
  try {
    const ff = fakeFetch([
      [REFRESH, [jsonRes({})]],
    ]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path, now: () => now });
    await withApp(client, async (base) => {
      const res = await fetch(`${base}/api/plaud/recordings`);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.code, 'plaud_upstream_error');
    });
    // The malformed response must not have been written over the shared token file.
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.access_token, 'AT');
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

// Real file-OBJECT shape (live-verified 2026-07-16): presigned_url is a 24h
// S3 MP3 link used by the review-pane listen buttons.
const AUDIO_URL = 'https://s3.example/rec.mp3?X-Amz-Expires=86400&sig=abc';
const FILE_OBJECT = { id: 'f1', name: 'סבב בוקר', presigned_url: AUDIO_URL, source_list: FILE_DETAIL };

test('transcript happy path returns transcript + timed segments + audioUrl', async () => {
  const { dir, path } = await tempTokenFile(FRESH);
  try {
    const ff = fakeFetch([[`${API}/open/third-party/files/f1`, [jsonRes(FILE_OBJECT)]]]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path });
    await withApp(client, async (base) => {
      const res = await fetch(`${base}/api/plaud/recordings/f1/transcript`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        transcript: 'שלום, אני שמואל.\nהחולה יציב הבוקר.',
        segments: [
          { content: 'שלום, אני שמואל.', startMs: 30, endMs: 2000 },
          { content: 'החולה יציב הבוקר.', startMs: 2000, endMs: 4730 },
        ],
        audioUrl: AUDIO_URL,
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bare-array file payload yields audioUrl null (segments still present)', async () => {
  const { dir, path } = await tempTokenFile(FRESH);
  try {
    const ff = fakeFetch([[`${API}/open/third-party/files/f1`, [jsonRes(FILE_DETAIL)]]]);
    const client = createPlaudClient({ fetchImpl: ff, tokenPath: path });
    await withApp(client, async (base) => {
      const body = await (await fetch(`${base}/api/plaud/recordings/f1/transcript`)).json();
      assert.equal(body.audioUrl, null);
      assert.equal(body.segments.length, 2);
      assert.equal(body.transcript, 'שלום, אני שמואל.\nהחולה יציב הבוקר.');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
