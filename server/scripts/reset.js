// server/scripts/reset.js
//
// Reseeds the mock Chameleon EMR working state by copying patient.seed.json to
// server/data/emr-state.json (overwriting any existing state). Used by
// `npm run reset` and invoked on server start so every class rehearsal begins
// from a clean, identical patient record (spec §9).

import { fileURLToPath } from 'node:url';

import { seedEmrState, getStatePath } from '../lib/emrStore.js';

/**
 * Copy the seed file to the working-state file. Delegates to
 * emrStore.seedEmrState so there is ONE implementation: it validates the seed,
 * writes atomically (temp + rename), and honours EMR_STATE_PATH. A second copy
 * of this logic here previously wrote the default path non-atomically, which
 * produced torn reads when a test process reset the file while another read it.
 *
 * @returns {string} the absolute path of the file written
 */
export function resetEmrState() {
  seedEmrState();
  return getStatePath();
}

// Run as a script (node server/scripts/reset.js).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const written = resetEmrState();
    console.log(`[reset] EMR working state reseeded from patient.seed.json → ${written}`);
  } catch (err) {
    console.error(`[reset] FAILED to reseed EMR state: ${err.message}`);
    process.exitCode = 1;
  }
}
