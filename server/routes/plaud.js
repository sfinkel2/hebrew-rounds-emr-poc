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
