// server/scripts/reset.js
//
// Reseeds the mock Chameleon EMR working state by copying patient.seed.json to
// server/data/emr-state.json (overwriting any existing state). Used by
// `npm run reset` and invoked on server start so every class rehearsal begins
// from a clean, identical patient record (spec §9).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const seedPath = join(dataDir, 'patient.seed.json');
const statePath = join(dataDir, 'emr-state.json');

/**
 * Copy the seed file to the working-state file. Validates that the seed is
 * parseable JSON before writing so a corrupt seed fails loudly.
 * @returns {string} the absolute path of the file written
 */
export function resetEmrState() {
  const raw = readFileSync(seedPath, 'utf8');
  // Parse to validate; re-serialize for a normalized, pretty file.
  const seed = JSON.parse(raw);
  writeFileSync(statePath, JSON.stringify(seed, null, 2) + '\n', 'utf8');
  return statePath;
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
