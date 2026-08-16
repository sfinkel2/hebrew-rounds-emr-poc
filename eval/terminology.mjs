// eval/terminology.mjs
//
// Terminology-fidelity scorer, in its own module so it can be applied both
// during a live eval run and re-applied to a saved result set without
// re-spending on the API (and without a second copy of the logic).

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Terminology fidelity — is the clinical vocabulary right?
 *
 * Separate from order recall, and they diverge: an order can reach the correct
 * chart while the diagnosis attached to it names a different disease.
 *
 * Two comparisons with different owners:
 *   document -> audio  transcription fidelity (the microphone's problem)
 *   audio    -> note   documentation fidelity (the system's problem)
 *
 * Verdicts on the second, which is what grades the system:
 *   faithful    the note records the term as it was actually spoken — correct,
 *               even where the recording itself contradicts the script
 *   interpreted the note supplies vocabulary the audio never contained. Benign
 *               for a mangled spelling, a clinical assertion when it names an
 *               organ or disease. Always surfaced for review.
 *   omitted     the term was destroyed and the note declined to guess — the
 *               safe outcome, not a failure
 *   invented    the note asserts a term destroyed beyond recognition
 */
export function scoreTerminology(terms, segScores) {
  const noteFor = (label) => {
    const row = segScores.find((s) => s.label === label);
    return norm((row?._note || []).map((f) => f.value).join('  '));
  };

  const rows = terms.map((t) => {
    const note = noteFor(t.patient);
    const hasFaithful = (t.faithful || []).some((k) => note.includes(norm(k)));
    const hasInferred = (t.inferred || []).some((k) => note.includes(norm(k)));
    const hasAltered = (t.alteredTo || []).some((k) => note.includes(norm(k)));
    const destroyed = t.spokenAs == null;

    let verdict;
    if (hasFaithful) verdict = 'faithful';
    else if (hasInferred) verdict = destroyed ? 'invented' : 'interpreted';
    // Distinct from `omitted`, and worse: dropping a term the transcription
    // mangled is safe, but replacing it with a different clinical term puts a
    // fact in the chart that nobody said. The reviewer sees a plausible note
    // with no signal that anything was substituted.
    else if (hasAltered) verdict = 'altered';
    else verdict = 'omitted';

    return {
      patient: t.patient, category: t.category, en: t.en,
      docTerm: t.docTerm, spokenAs: t.spokenAs,
      survivedTranscription: !destroyed && t.spokenAs === t.docTerm,
      verdict, note: t.note,
    };
  });

  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return {
    total: rows.length,
    survivedTranscription: rows.filter((r) => r.survivedTranscription).length,
    faithful: count('faithful'),
    interpreted: count('interpreted'),
    altered: count('altered'),
    omitted: count('omitted'),
    invented: count('invented'),
    // Documentation fidelity = of the terms the system could act on, how many
    // were recorded as spoken. Destroyed terms are excluded — the system cannot
    // faithfully record a word it never received.
    score: (() => {
      const actionable = rows.filter((r) => r.spokenAs != null);
      return actionable.length
        ? actionable.filter((r) => r.verdict === 'faithful').length / actionable.length
        : 0;
    })(),
    rows,
  };
}
