// server/index.js
//
// Express app entry point for the Hebrew Voice Rounds → Mock Chameleon EMR POC.
//
// Responsibilities (spec §5, §9):
//   - Load environment (.env) via dotenv.
//   - Reseed the mock EMR working state from patient.seed.json on startup so
//     every `npm start` begins from a clean, identical patient (spec §9).
//   - Resolve and print the operating MODE — MOCK (deterministic, no network) vs
//     LIVE (Claude structure/judge) — using the same rule the lib layer uses:
//       MOCK when DEMO_MODE=mock, or when an API key is missing.
//   - Serve the static frontend from /public (no build step).
//   - Mount all API routes under /api.
//   - Listen on PORT (default 3000) ONLY when run directly; export `app` so
//     tests can drive it with in-process requests.

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resetEmrState } from './scripts/reset.js';

import transcribeRoute from './routes/transcribe.js';
import structureRoute from './routes/structure.js';
import judgeRoute from './routes/judge.js';
import commitRoute from './routes/commit.js';
import scriptedRoundRoute from './routes/scriptedRound.js';
import emrRoute from './routes/emr.js';
import createPlaudRouter from './routes/plaud.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const publicDir = join(__dirname, '..', 'public');

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

/** Build (but do not start) the Express app. */
export function createApp() {
  const app = express();

  // JSON bodies for /api/structure, /api/judge, /api/commit. Hebrew transcripts
  // can be sizable; raise the limit comfortably above the default 100kb.
  app.use(express.json({ limit: '2mb' }));

  // Static modern + legacy frontend (no bundler).
  app.use(express.static(publicDir));

  // API routes (spec §5). transcribe.js owns its own multer middleware.
  app.use('/api', transcribeRoute);
  app.use('/api', structureRoute);
  app.use('/api', judgeRoute);
  app.use('/api', commitRoute);
  app.use('/api', scriptedRoundRoute);
  app.use('/api', emrRoute);
  app.use('/api', createPlaudRouter());

  // Common error envelope for unexpected/uncaught errors (spec §5/§8).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({
      error: {
        code: 'internal_error',
        message: err?.message || 'Unexpected server error.',
      },
    });
  });

  return app;
}

const app = createApp();

export default app;

// Start listening only when this module is run directly (node server/index.js).
if (process.argv[1] === thisFile) {
  // Reseed the mock EMR so every rehearsal starts clean (spec §9).
  try {
    resetEmrState();
    console.log('[startup] EMR working state reseeded from patient.seed.json');
  } catch (err) {
    console.error(`[startup] FAILED to reseed EMR state: ${err.message}`);
    process.exit(1);
  }

  const mode = resolveMode();
  const port = Number(process.env.PORT) || 3000;

  app.listen(port, () => {
    console.log(`\n  Hebrew Rounds → Mock Chameleon EMR POC`);
    console.log(`  Mode: ${mode}${mode === 'MOCK' ? '  (deterministic, no network — scripted round)' : '  (live Claude structure + judge)'}`);
    console.log(`  URL:  http://localhost:${port}\n`);
  });
}
