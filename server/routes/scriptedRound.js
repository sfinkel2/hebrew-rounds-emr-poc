// server/routes/scriptedRound.js
//
// GET /api/scripted-round
//
// Serves the canned Hebrew round transcript + (optional) audio asset for the
// on-stage fallback path (spec §5, §2 "scripted round as on-stage fallback").
// This route reads server/data/scripted-round.json verbatim and returns it as
// { transcript, audioUrl }. It performs no LLM work and never fails on missing
// API keys, so it is always available as the reliable classroom fallback.

import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptedRoundPath = join(__dirname, '..', 'data', 'scripted-round.json');

const router = Router();

router.get('/scripted-round', async (_req, res) => {
  try {
    const raw = await readFile(scriptedRoundPath, 'utf8');
    const data = JSON.parse(raw);
    // Normalize to the documented shape { transcript, audioUrl }.
    res.json({
      transcript: data.transcript ?? '',
      audioUrl: data.audioUrl ?? null,
    });
  } catch (err) {
    res.status(500).json({
      error: {
        code: 'scripted_round_unavailable',
        message: `Failed to load scripted round: ${err.message}`,
      },
    });
  }
});

export default router;
