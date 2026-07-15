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
