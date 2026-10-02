// Writes tests/profession/golden/md-do.json: the MD and DO outputs the PA and
// NP work must leave unchanged (DESIGN 7.1). Run only at the base commit:
//   GOLDEN_UPDATE=1 node scripts/capture-profession-golden.mjs
// It refuses anywhere else, so a golden cannot be "updated" to match a
// regression. Every case is synthetic.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE_COMMIT, computeGolden } from '../tests/profession/golden-cases.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.env.GOLDEN_UPDATE !== '1') {
  console.error('Set GOLDEN_UPDATE=1 to write the goldens.');
  process.exit(2);
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!head.startsWith(BASE_COMMIT)) {
  console.error(`Refusing: HEAD is ${head.slice(0, 8)}, goldens are captured only at the base commit ${BASE_COMMIT}.`);
  process.exit(1);
}
const { hashes, full } = await computeGolden();
writeFileSync(new URL('../tests/profession/golden/md-do.json', import.meta.url), JSON.stringify({ base: BASE_COMMIT, frozen: '2026-10-01T12:00 local', cases: Object.keys(hashes).length, hashes }, null, 1) + '\n');
writeFileSync(new URL('../tests/profession/golden/md-do-full.json', import.meta.url), JSON.stringify(full) + '\n');
console.log(`Wrote ${Object.keys(hashes).length} golden cases.`);
