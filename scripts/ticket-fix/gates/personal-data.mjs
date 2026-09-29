// G10: nothing personal and no secret in a commit bound for the public
// repository (design G10, stage 2 review finding 7).
//
// Runs on the host, over the lines base..head adds and the files it adds or
// changes, before anything can be pushed: as a G2 check (so a failure resumes
// the worker once with the rule names) and again in the merge (mergeRun).
//   email          an address outside example.*, *.example, .test, .invalid,
//                  .localhost and credentialdomd.com
//   phone          a North American number outside 555-0100 to 555-0199
//   npi            a 10-digit number that passes the NPI Luhn check
//   dea            a DEA number with a valid checksum
//   ssn            ddd-dd-dddd
//   base64_blob    a long base64 run (an embedded image or document)
//   media_in_tests an image, PDF or font added or changed under tests/
//   ticket_text    8 or more words in a row copied from the ticket thread
//   credential     the runner's own model credential, or a token shape
//                  (sk-ant-, sbp_, ghp_/gho_/ghu_/ghs_/ghr_, github_pat_, a
//                  JWT, a private key block)
// A value that already occurs in the base tree is already public and is not
// counted (fixtures copy synthetic values); the runner's own credentials and
// ticket text never get that exemption. The report names rules and files
// only: a matched value is never logged, written or sent to the model.
import path from 'node:path';
import { git, attrFrom, DIFF_TEXT, MEDIA_EXCLUDES } from '../worktree.mjs';

const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,}))\b/g;
const ALLOWED_DOMAIN = /(?:^|\.)(?:example(?:\.(?:com|org|net))?|test|invalid|localhost|credentialdomd\.com)$/i;
const FILE_TLD = /^(?:png|jpe?g|gif|svg|webp|ico|js|mjs|jsx|css|html?|json|md|pdf|txt|map)$/i;
const PHONE = /(?<![\w.-])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-](\d{3})[\s.-](\d{4})(?![\w-])/g;
const NPI = /(?<![\w.-])([12]\d{9})(?![\w.-])/g;
const DEA = /(?<![\w])([A-Z][A-Z9])(\d{7})(?![\w])/g;
const SSN = /(?<![\w-])(\d{3})-(\d{2})-(\d{4})(?![\w-])/g;
const BASE64 = /[A-Za-z0-9+/]{400,}={0,2}/g;
const TOKENS = [/sk-ant-[A-Za-z0-9_-]{20,}/g, /\bsbp_[A-Za-z0-9]{20,}/g, /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];
const MEDIA = /\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp|pdf|ico|woff2?|ttf|otf)$/i;
// Synthetic values the repository's own tests use.
const ALLOWED_NPI = new Set(['1234567893']);

export function luhnNpi(digits) {
  const all = `80840${digits}`;
  let sum = 0;
  for (let i = all.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = Number(all[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
export function deaValid(letters, digits) {
  const d = [...digits].map(Number);
  return (d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5])) % 10 === d[6] && /^[ABCDEFGHJKLMPRSTUX]/.test(letters);
}
const words = text => String(text ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? [];
// Every 8-word run in the ticket thread.
export function evidenceShingles(context, size = 8) {
  const texts = [];
  for (const t of context?.tickets ?? []) {
    texts.push(t.subject, t.body);
    for (const m of t.messages ?? []) texts.push(m.body);
  }
  const shingles = new Set();
  for (const text of texts) {
    const w = words(text);
    for (let i = 0; i + size <= w.length; i++) shingles.add(w.slice(i, i + size).join(' '));
  }
  return shingles;
}

// Candidate values on one added line, each { rule, value }.
export function lineFindings(line, { secrets = [] } = {}) {
  const found = [];
  for (const m of line.matchAll(EMAIL)) if (!ALLOWED_DOMAIN.test(m[1]) && !FILE_TLD.test(m[2])) found.push({ rule: 'email', value: m[0] });
  for (const m of line.matchAll(PHONE)) if (!(m[2] === '555' && /^01\d\d$/.test(m[3]))) found.push({ rule: 'phone', value: m[0].trim() });
  for (const m of line.matchAll(NPI)) if (luhnNpi(m[1]) && !ALLOWED_NPI.has(m[1])) found.push({ rule: 'npi', value: m[1] });
  for (const m of line.matchAll(DEA)) if (deaValid(m[1], m[2])) found.push({ rule: 'dea', value: m[0] });
  for (const m of line.matchAll(SSN)) found.push({ rule: 'ssn', value: m[0] });
  for (const m of line.matchAll(BASE64)) found.push({ rule: 'base64_blob', value: m[0] });
  for (const pattern of TOKENS) for (const m of line.matchAll(pattern)) found.push({ rule: 'credential', value: m[0] });
  for (const secret of secrets) if (secret && secret.length >= 12 && line.includes(secret)) found.push({ rule: 'credential', value: secret, never_public: true });
  return found;
}

// The report for base..head. evidence: the run's context (ticket thread);
// secrets: the runner's own credential values.
export function personalDataReport({ dir, base, head, context = null, secrets = [], binary = 'git' }) {
  const hits = [];
  const add = (rule, file) => { if (!hits.some(h => h.rule === rule && h.file === file)) hits.push({ rule, file }); };
  const status = git(dir, [...attrFrom(base), 'diff', '--name-status', '-z', '--no-renames', base, head], { binary }).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < status.length; i += 2) files.push({ status: status[i], file: status[i + 1] });
  for (const { status: s, file } of files) if (s !== 'D' && MEDIA.test(file) && file.startsWith('tests/')) add('media_in_tests', file);
  const diff = git(dir, [...attrFrom(base), 'diff', '-U0', ...DIFF_TEXT, '--no-renames', base, head, '--', '.', ...MEDIA_EXCLUDES], { binary, allowFail: true }) || '';
  const added = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(6); continue; }
    if (line.startsWith('diff --git ')) { file = null; continue; }
    if (file && line.startsWith('+')) { if (!added.has(file)) added.set(file, []); added.get(file).push(line.slice(1)); }
  }
  const atBase = new Map();
  const publicAtBase = value => {
    if (!atBase.has(value)) atBase.set(value, git(dir, ['grep', '-q', '-F', '-e', value, base, '--'], { binary, allowFail: true }) !== null);
    return atBase.get(value);
  };
  const shingles = evidenceShingles(context);
  for (const [name, lines] of added) {
    for (const line of lines) {
      for (const f of lineFindings(line, { secrets })) if (f.never_public || !publicAtBase(f.value)) add(f.rule, name);
    }
    if (shingles.size) {
      const w = words(lines.join('\n'));
      for (let i = 0; i + 8 <= w.length; i++) if (shingles.has(w.slice(i, i + 8).join(' '))) { add('ticket_text', name); break; }
    }
  }
  return { pass: hits.length === 0, hits, files: files.length };
}

// The one-line form for a gate detail or a repair prompt: rule names and
// file names, never values.
export const personalDataSummary = report => report.hits.map(h => `${h.rule} in ${path.normalize(h.file)}`).join('; ');
