// A stand-in for eslint in synthetic gate tests: every line containing
// LINT_ERROR is one error, every line containing HOOKS_ERROR one
// react-hooks error. Same --format json output shape eslint prints.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let input = '';
if (args.includes('--stdin')) for await (const chunk of process.stdin) input += chunk;
const named = args.includes('--stdin') ? args[args.indexOf('--stdin-filename') + 1] : args.filter(a => !a.startsWith('--') && a !== 'json').at(-1);
const text = args.includes('--stdin') ? input : readFileSync(named, 'utf8');
const messages = [];
text.split('\n').forEach((line, i) => {
  if (line.includes('LINT_ERROR')) messages.push({ ruleId: 'no-unused-vars', severity: 2, line: i + 1 });
  if (line.includes('HOOKS_ERROR')) messages.push({ ruleId: 'react-hooks/rules-of-hooks', severity: 2, line: i + 1 });
});
console.log(JSON.stringify([{ filePath: named, messages, errorCount: messages.length }]));
process.exitCode = messages.length ? 1 : 0;
