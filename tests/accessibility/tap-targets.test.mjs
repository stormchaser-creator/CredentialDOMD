// Every symbol- or icon-only button in the app's source, and every text
// button drawn with no vertical padding, held to the QA lab's 32 x 32 phone
// floor (tap-target-audit.mjs), including the ones that only appear after a
// tap. The lab's phone pass measured the Favorites list's "Remove from
// Favorites" star at 35 x 31 (7 px by 9 px of padding around a 17 px icon)
// and bare × buttons at 11 x 20; a new one fails here by file:line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import { auditTapTargets, rendersOnlyAtDesk } from './tap-target-audit.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? sources(join(dir, d.name)) : /\.jsx$/.test(d.name) ? [join(dir, d.name)] : []));
const files = sources(join(root, 'src')).map(file => ({ file: relative(root, file), src: readFileSync(file, 'utf8') }));

// Components the app draws only at desk width: their buttons are the desk
// layout. Each is checked below to be rendered only under isDesktop.
const DESK_ONLY = { SideNav: 'src/components/shared/SideNav.jsx' };

test('every symbol- or icon-only button in src is at least 32 x 32 on a phone', () => {
  const problems = files.filter(f => !Object.values(DESK_ONLY).includes(f.file)).flatMap(f => auditTapTargets(f.src, f.file, { kinds: ['symbol'] }));
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('no text button in src is drawn with no vertical padding and no 32 px minimum height', () => {
  const problems = files.filter(f => !Object.values(DESK_ONLY).includes(f.file)).flatMap(f => auditTapTargets(f.src, f.file, { kinds: ['text'] }));
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('the components left out as desk-only are rendered only at desk width', () => {
  for (const [name, file] of Object.entries(DESK_ONLY)) {
    const users = files.filter(f => f.file !== file && new RegExp(`<${name}\\b`).test(f.src));
    assert.ok(users.length > 0, `${name} is rendered somewhere`);
    for (const f of users) assert.ok(rendersOnlyAtDesk(f.src, name), `${f.file} renders <${name}> where a phone can see it`);
  }
});

test('the Favorites list\'s Remove from Favorites star is held to 32 x 32 (the lab measured 35 x 31)', () => {
  const app = files.find(f => f.file === 'src/App.jsx');
  const ast = espree.parse(app.src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true, loc: true });
  const stars = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'JSXElement' && n.openingElement.name.name === 'button'
      && n.openingElement.attributes.some(a => a.name?.name === 'aria-label' && a.value?.value === 'Remove from Favorites')) stars.push(n);
    for (const [k, v] of Object.entries(n)) { if (k !== 'loc' && k !== 'range') (Array.isArray(v) ? v : [v]).forEach(visit); }
  };
  visit(ast);
  assert.equal(stars.length, 1, 'the Favorites list has one Remove from Favorites star');
  const line = stars[0].loc.start.line;
  const problems = auditTapTargets(app.src, 'src/App.jsx', { kinds: ['symbol'] }).filter(p => p.startsWith(`src/App.jsx:${line} `));
  assert.deepEqual(problems, []);
});

// The reader, on source it must refuse and must accept.
const audit = (jsx, kinds = ['symbol', 'text']) => auditTapTargets(`import { cardActionSize, TAP_MIN, dismissButtonStyle, actionButtonStyle } from "../shared/actionButton";\n${jsx}`, 'x.jsx', { kinds });

test('the tap-target reader refuses a symbol or icon button that is not held to 32 x 32', () => {
  const bad = [
    // The Favorites star as the lab measured it, and a bare ×.
    'const x = <button aria-label="Remove from Favorites" style={{ padding: "7px 9px", display: "flex" }}><StarIcon filled size={17} /></button>;',
    'const x = <button aria-label="Dismiss" onClick={f} style={{ border: "none", background: "none" }}>&times;</button>;',
    'const x = <button aria-label="Remove" onClick={f}>✕</button>;',
    'const x = <button aria-label="Previous month" style={{ padding: "6px 12px" }}>‹</button>;',
    'const x = <button aria-label="Fewer" style={{ padding: "4px 9px" }}>−</button>;',
    'const x = <button aria-label="Attach" style={{ padding: "12px 13px", fontSize: 16 }}>📎</button>;',
    'const x = <button aria-label="Dictate" style={{ padding: "10px 12px" }}>{on ? "◼" : "🎤"}</button>;',
    // Only one side held, or a switch drawn as its own 24 px target.
    'const x = <button aria-label="Close" style={{ minWidth: 32 }}>×</button>;',
    'const x = <button aria-label="Monthly backup" style={{ width: 44, height: 24 }}><div /></button>;',
    'const x = <button aria-label="Remove" style={{ width: 22, height: 22 }}>&times;</button>;',
    // A floor that only one way the condition goes carries.
    'const star = (item, card) => <button aria-label="Star" style={{ padding: "6px 8px", ...(card ? cardActionSize : null) }}><StarIcon /></button>;',
    'const x = <button aria-label="Close" style={{ minWidth: 32, minHeight: big ? 32 : 20 }}>×</button>;',
    // A style this reader cannot see into.
    'function R({ s }) { return <button aria-label="Close" style={s}>×</button>; }',
    'const x = <button aria-label="Close" style={{ ...props.style }}>×</button>;',
    // Shown on a phone: the alternate of an isDesktop condition.
    'const x = isDesktop ? null : <button aria-label="Edit" style={{ width: 26, height: 26 }}><EditIcon /></button>;',
  ];
  for (const jsx of bad) assert.notDeepEqual(audit(jsx), [], jsx);
});

test('the tap-target reader accepts a 32 x 32 floor, however the style is built, and leaves the desk alone', () => {
  const good = [
    'const x = <button aria-label="Remove from Favorites" style={{ padding: "7px 9px", ...cardActionSize }}><StarIcon filled size={17} /></button>;',
    'const x = <button aria-label="Dismiss" style={dismissButtonStyle(T.danger)}>&times;</button>;',
    'const x = <button aria-label="Dismiss" style={{ ...dismissButtonStyle(T.warning), margin: "-6px -8px -6px 0" }}>&times;</button>;',
    'const x = <button aria-label="Close" style={{ minWidth: TAP_MIN, minHeight: TAP_MIN }}>×</button>;',
    'const x = <button aria-label="Close" style={{ width: 36, height: 36 }}><CloseIcon /></button>;',
    'const x = <button aria-label="Close" style={{ minWidth: "32px", minHeight: "32px" }}>×</button>;',
    'const MIN = 36; const x = <button aria-label="More" style={{ minWidth: MIN, minHeight: MIN }}>…</button>;',
    'const SW = { width: 44, height: 36 }; const x = <button aria-label="On" style={{ width: SW.width, minHeight: SW.height }}><span /></button>;',
    'const box = { minWidth: 32, minHeight: 32 }; const x = <button aria-label="Close" style={{ ...box, color: "red" }}>×</button>;',
    'const d = (c) => ({ minWidth: 32, minHeight: 32, color: c }); const x = <button aria-label="Close" style={d(T.a)}>×</button>;',
    'function d(c) { if (c) return { minWidth: 32, minHeight: 32 }; return { width: 40, height: 40 }; } const x = <button aria-label="Close" style={d(1)}>×</button>;',
    // A floor on a phone, the desk's own size at desk width.
    'const star = (item, card) => <button aria-label="Star" style={{ padding: "6px 8px", ...(card || !isDesktop ? cardActionSize : null) }}><StarIcon /></button>;',
    'const x = <button aria-label="Close" style={{ minWidth: 32, minHeight: isDesktop ? 20 : 32 }}>×</button>;',
    // Desk only: an isDesktop branch, or a function only called in one.
    'const x = isDesktop ? <button aria-label="Edit" style={{ width: 26, height: 26 }}><EditIcon /></button> : null;',
    'const x = isDesktop && rows ? <Table actions={r => <button aria-label="Edit" style={deskBtn}><EditIcon /></button>} /> : <List />;',
    'const x = <div>{isDesktop && <button aria-label="Edit"><EditIcon /></button>}</div>;',
    'function P() { const desk = () => <button aria-label="Edit" style={{ width: 26 }}><EditIcon /></button>; return isDesktop ? desk() : null; }',
    // A button with words in it is not a symbol button.
    'const x = <button aria-label="Close" style={{ padding: "6px 10px" }}>× Close</button>;',
    'const x = <button style={{ padding: "6px 10px" }}><StarIcon /> Favorites</button>;',
  ];
  for (const jsx of good) assert.deepEqual(audit(jsx), [], jsx);
});

test('the tap-target reader refuses a text button with no vertical padding and no minimum, and accepts the rest', () => {
  const bad = [
    'const x = <button onClick={f} style={{ padding: 0, border: "none", background: "none" }}>Open Settings</button>;',
    'const x = <button onClick={f} style={{ padding: "0 12px" }}>Show</button>;',
    'const x = <button onClick={f} style={{ border: "none", fontSize: 13 }}>Back to all entries</button>;',
    'const x = <button onClick={f}>Manage paid subscription</button>;',
    'const link = { padding: "6px 0" }; const x = <button style={{ ...link, padding: 0 }}>Dismiss</button>;',
    'const x = <div role="button" tabIndex={0} onClick={f} style={{ cursor: "pointer" }}>Open</div>;',
  ];
  for (const jsx of bad) assert.notDeepEqual(audit(jsx, ['text']), [], jsx);
  const good = [
    'const x = <button onClick={f} style={{ padding: 0, minHeight: 32 }}>Open Settings</button>;',
    'const x = <button onClick={f} style={{ padding: "0 12px", minHeight: TAP_MIN }}>Show</button>;',
    'const x = <button onClick={f} style={{ padding: "6px 0" }}>Review in full</button>;',
    'const x = <button onClick={f} style={{ padding: "8px 12px" }}>Resend</button>;',
    'const x = <button onClick={f} style={actionButtonStyle(T, { isDesktop })}>Sign out</button>;',
    'const x = <button onClick={f} style={{ height: 40 }}>Save</button>;',
    'const x = isDesktop ? <button style={{ padding: 0 }}>refresh</button> : null;',
  ];
  for (const jsx of good) assert.deepEqual(audit(jsx, ['text']), [], jsx);
});
