// server/routes/transcribe.js
//
// POST /api/transcribe  (multipart audio) → { transcript }
//
// Accepts a browser MediaRecorder audio blob, hands the raw bytes to the
// Whisper wrapper (lib/llm.js → transcribeAudio), and returns the Hebrew
// transcript (spec §5). In MOCK mode transcribeAudio returns the canned
// scripted-round transcript, so this endpoint works WITH OR WITHOUT an uploaded
// file (spec §2 mock mode / demo reliability).
//
// Multer uses in-memory storage: the uploaded file is exposed at req.file with
// a `.buffer` (Node Buffer) and `.mimetype`. No file is written to disk.

import { Router } from 'express';
import multer from 'multer';
import { transcribeAudio } from '../lib/llm.js';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

// `upload.single('audio')` accepts an optional file field named "audio".
// In mock mode the absence of a file is fine; transcribeAudio ignores the audio.
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const audioBuffer = req.file ? req.file.buffer : null;
    const mimeType = req.file ? req.file.mimetype : null;

    const transcript = await transcribeAudio(audioBuffer, { mimeType });

    if (typeof transcript !== 'string' || transcript.length === 0) {
      return res.status(502).json({
        error: {
          code: 'transcription_empty',
          message: 'The transcription service returned an empty transcript.',
        },
      });
    }

    res.json({ transcript });
  } catch (err) {
    res.status(502).json({
      error: {
        code: 'transcription_failed',
        message: `Transcription failed: ${err.message}`,
      },
    });
  }
});

export default router;
