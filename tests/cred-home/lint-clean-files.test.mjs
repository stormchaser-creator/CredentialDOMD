import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

// Files this branch changed that lint clean, kept clean. `eslint .` still
// reports pre-existing errors elsewhere (tests/hooks-rules.test.mjs gates the
// crash rules repo-wide); these files had none on main, and the branch had
// added two react-hooks/set-state-in-effect errors (the Screenings deep-link
// effects) and a react-refresh/only-export-components error (FollowUpHistory
// exporting a helper beside its component).
const root = fileURLToPath(new URL('../..', import.meta.url));
const FILES = [
  'src/components/features/ScreeningsSection.jsx',
  'src/components/features/CMESection.jsx',
  'src/utils/cmeTranscriptPdf.js',
  'src/components/shared/FollowUpHistory.jsx',
  'src/utils/followUps.js',
];

test('the changed Screenings, CME, transcript and follow-up files have no lint errors', async () => {
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(FILES.map(f => `${root}${f}`));
  const errors = results.flatMap(r => r.messages.filter(m => m.severity === 2)
    .map(m => `${r.filePath.slice(root.length)}:${m.line} ${m.ruleId} ${m.message.split('\n')[0]}`));
  assert.deepEqual(errors, []);
});
