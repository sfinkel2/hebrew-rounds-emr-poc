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
// update. The file is also co-owned by the Plaud MCP process, so a
// cross-process refresh race (both refreshing the same rotated token) is
// inherent to the shared-file design and accepted for this demo; in-process
// concurrency is single-flighted.
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
      // Transient network failure — NOT a login problem; don't tell the
      // presenter to re-run the MCP login for a blip.
      throw new PlaudError('plaud_upstream_error', `Plaud token refresh failed: ${err.message}`);
    }
    if (!res.ok) {
      throw new PlaudError(
        'plaud_not_connected',
        `Plaud token refresh failed (HTTP ${res.status}) — run the Plaud MCP login again.`,
      );
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new PlaudError('plaud_upstream_error', 'Plaud token refresh returned malformed JSON.');
    }
    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new PlaudError('plaud_upstream_error', 'Plaud token refresh returned no access token.');
    }
    const next = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      token_type: data.token_type ?? 'Bearer',
      ...(data.expires_in ? { expires_at: now() + data.expires_in * 1000 } : {}),
    };
    // Best-effort persist (same shape the MCP writes); an unwritable file
    // only costs us a refresh on the next call. The write is not atomic — a
    // crash mid-write leaves invalid JSON, which loadTokens degrades to
    // plaud_not_connected.
    try {
      await writeFile(tokenPath, JSON.stringify(next, null, 2), 'utf8');
    } catch { /* ignore */ }
    return next;
  }

  // Plaud rotates refresh tokens: each one is single-use, so two concurrent
  // refreshes with the same token would burn it and could persist a dead set.
  // Single-flight: concurrent callers share one in-flight refresh.
  let refreshInFlight = null;
  function refreshOnce(tokens) {
    refreshInFlight ??= refreshTokens(tokens).finally(() => { refreshInFlight = null; });
    return refreshInFlight;
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
    if (isTokenStale(tokens, now())) tokens = await refreshOnce(tokens);
    let res = await doGet(path, tokens);
    if (res.status === 401) {
      tokens = await refreshOnce(tokens);
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
