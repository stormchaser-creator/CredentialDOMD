// Every control a finger taps in the app's source, held to the QA lab's
// 32 x 32 phone floor (tap-target-audit.mjs), including the ones that only
// appear after a tap: symbol- and icon-only buttons by their own width and
// height, and every text button, link, disclosure and role=button element by
// the box the browser draws for it. The lab's phone pass measured the
// Favorites list's "Remove from Favorites" star at 35 x 31, bare × buttons at
// 11 x 20, and the Requests screen's underlined text buttons at 28 px tall
// (6 px of padding around 13 px text); a new one fails here by file:line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import { auditTapTargets, rendersOnlyAtDesk, textBoxes } from './tap-target-audit.mjs';
import { TAP_MIN, inlineLinkTap } from '../../src/components/shared/actionButton.js';

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

test('every text button, link, disclosure and role=button control in src is at least 32 px on a phone', () => {
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
const audit = (jsx, kinds = ['symbol', 'text']) => auditTapTargets(`import { cardActionSize, TAP_MIN, dismissButtonStyle, actionButtonStyle, inlineLinkTap } from "../shared/actionButton";\n${jsx}`, 'x.jsx', { kinds });

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
  for (const jsx of good) assert.deepEqual(audit(jsx, ['symbol']), [], jsx);
});

test('the tap-target reader refuses a text control under 32 px on a phone, however little padding it has', () => {
  const bad = [
    // No vertical padding.
    'const x = <button onClick={f} style={{ padding: 0, border: "none", background: "none" }}>Open Settings</button>;',
    'const x = <button onClick={f} style={{ padding: "0 12px" }}>Show</button>;',
    'const x = <button onClick={f} style={{ border: "none", fontSize: 13 }}>Back to all entries</button>;',
    'const x = <button onClick={f}>Manage paid subscription</button>;',
    'const link = { padding: "6px 0" }; const x = <button style={{ ...link, padding: 0 }}>Dismiss</button>;',
    'const x = <div role="button" tabIndex={0} onClick={f} style={{ cursor: "pointer" }}>Open</div>;',
    // Small but not zero padding: the Requests links (28), a share chip (30), a pill (19).
    'const linkBtn = { padding: "6px 0", border: "none", background: "none", font: "inherit", fontSize: 13, fontWeight: 700 }; const x = <button style={linkBtn}>Review in full</button>;',
    'const x = <button onClick={f} style={{ padding: "6px 0" }}>Review in full</button>;',
    'const x = <button style={{ padding: "6px 14px", fontSize: 13, borderRadius: 20, border: `1px solid ${T.border}` }}>{t.l}</button>;',
    'const x = <button style={{ padding: "3px 10px", fontSize: 11, border: "none" }}>Find CME Courses</button>;',
    // A link in a sentence, a disclosure, a link whose padding below lies under the next line.
    'const x = <p style={{ fontSize: 13 }}>See <a href="/help">the guides</a>.</p>;',
    'const x = <details><summary>Source passages</summary></details>;',
    'const x = <p>See <a href="/help" style={{ paddingTop: 10, paddingBottom: 10 }}>the guides</a>.</p>;',
    // A min-height on an inline link does nothing.
    'const x = <p>See <a href="/help" style={{ minHeight: 32 }}>the guides</a>.</p>;',
    // Tall enough but too narrow: "Edit" in 13 px bold is 24 px wide.
    'const x = <button style={{ padding: "8px 0", fontSize: 13, fontWeight: 700, border: "none" }}>Edit</button>;',
    // A floor at desk width only, and one after a spread this reader cannot see into.
    'const x = <button style={{ padding: "6px 12px", minHeight: isDesktop ? TAP_MIN : undefined }}>Refresh</button>;',
    'function R({ s }) { return <button style={{ ...s, padding: "6px 12px" }}>Refresh</button>; }',
    // Inherited small text read from the element around it.
    'const x = <div style={{ fontSize: 11, lineHeight: 1.2 }}><button style={{ font: "inherit", padding: "5px 0", border: "none" }}>Remove</button></div>;',
    // Padding pulled back by a negative margin with no position: the rows it
    // overlaps take the taps there (Chromium: a 36 px summary answers over 27.5 px, or 18).
    'const x = <details><summary style={{ padding: "9px 0", margin: "-9px 0" }}>Activity</summary><p>body</p></details>;',
    'const linkBtn = { padding: "9px 0", margin: "-3px 0", border: "none", background: "none", font: "inherit", fontSize: 13 }; const x = <button style={linkBtn}>Review in full</button>;',
    'const x = <div><button style={{ display: "block", padding: "9px 0", margin: "-9px 0", border: "none", fontSize: 13 }}>Review in full</button><div>Next row</div></div>;',
    'const x = <div style={{ display: "flex", flexDirection: "column" }}><a href="/x" style={{ padding: "9px 0", margin: "-9px 0", fontSize: 13 }}>CO board</a><span>Next row</span></div>;',
    'const x = <a href="/x" style={{ display: "block", padding: "5px 0", margin: "-5px 0 3px", fontSize: 15, lineHeight: 1.55 }}>CO board</a>;',
    'const x = <button style={{ padding: "0 0 0 12px", minHeight: 32, margin: "-6px 0", border: "none", fontSize: 13 }}>View All</button>;',
    'const x = <p>Every ask is clear. <button style={{ display: "inline-flex", minHeight: TAP_MIN, margin: "-8px 0", padding: 0, border: "none" }}>Change it in Settings</button> and more.</p>;',
    'function R({ s }) { return <button style={{ ...s, minHeight: 32, margin: "-6px 0" }}>Refresh</button>; }',
    // A flex property of its own does not make a link in a sentence a flex item
    // (Chromium: 15, 27 and 15 px answer the tap), nor does a component around it.
    'const x = <p style={{ fontSize: 12 }}>See <a href="/x" style={{ flexShrink: 0, minHeight: 32 }}>the guides</a> now.</p>;',
    'const x = <p>See <a href="/x" style={{ alignSelf: "center", padding: "10px 0" }}>the guides</a></p>;',
    'const x = <p style={{ fontSize: 12 }}>See <a href="/x" style={{ display: "inline", flex: 1, minHeight: 40 }}>the guides</a> now.</p>;',
    'const x = <Row><a href="/x" style={{ whiteSpace: "nowrap", flexShrink: 0, minHeight: 32 }}>Source</a></Row>;',
    'const x = <p>See <a href="/x" style={{ flex: 1, position: "relative", padding: "10px 0" }}>Go</a> now.</p>;',
  ];
  for (const jsx of bad) assert.notDeepEqual(audit(jsx, ['text']), [], jsx);
  const good = [
    'const x = <button onClick={f} style={{ padding: 0, minHeight: 32 }}>Open Settings</button>;',
    'const x = <button onClick={f} style={{ padding: "0 12px", minHeight: TAP_MIN }}>Show</button>;',
    'const x = <button onClick={f} style={{ padding: "8px 12px" }}>Resend</button>;',
    'const x = <button onClick={f} style={actionButtonStyle(T, { isDesktop })}>Sign out</button>;',
    'const x = <button onClick={f} style={{ height: 40, padding: "0 12px" }}>Save</button>;',
    'const x = isDesktop ? <button style={{ padding: 0 }}>refresh</button> : null;',
    // The fixes: a floor on a phone only, padding pulled back by the margin, a positioned link in a sentence.
    'const x = <button style={{ padding: "6px 14px", minHeight: isDesktop ? undefined : TAP_MIN, fontSize: 13 }}>{t.l}</button>;',
    'const linkBtn = { position: "relative", padding: "9px 0", margin: "-3px 0", border: "none", font: "inherit", fontSize: 13 }; const x = <button style={linkBtn}>Review in full</button>;',
    'const x = <p style={{ fontSize: 12 }}>See <a href="/help" style={{ color: T.accent, ...inlineLinkTap }}>the guides</a>.</p>;',
    'const x = <p style={{ fontSize: 11 }}>See <a href="/help" style={inlineLinkTap}>the guides</a>.</p>;',
    'const x = <details><summary style={{ position: "relative", padding: "9px 0", margin: "-9px 0" }}>Activity</summary></details>;',
    'const x = <a href="/x" style={{ display: "block", position: "relative", padding: "5px 0", margin: "-5px 0 3px", fontSize: 15, lineHeight: 1.55 }}>CO board</a>;',
    'const x = <button style={{ position: "relative", padding: "0 0 0 12px", minHeight: 32, margin: "-6px 0", border: "none", fontSize: 13 }}>View All</button>;',
    'const x = <div style={{ display: "flex", flexDirection: "column" }}><a href="/x" style={{ position: "relative", padding: "9px 0", margin: "-9px 0", fontSize: 13 }}>CO board</a><span>Next row</span></div>;',
    'function R({ s }) { return <button style={{ ...s, minHeight: 32 }}>Refresh</button>; }',
    'function R({ s }) { return <button style={{ ...s, position: "relative", minHeight: 32, margin: "-6px 0" }}>Refresh</button>; }',
    // A flex item by the element around it: its min-height holds.
    'const x = <div style={{ display: "flex", gap: 8 }}><span>Label</span><a href="/x" style={{ flexShrink: 0, minHeight: 32 }}>Open the guides</a></div>;',
    // Wide words, a full-width row, a value as the label, a thumbnail link.
    'const x = <button style={{ padding: "9px 0", fontSize: 13, fontWeight: 700, border: "none" }}>Edit this record</button>;',
    'const x = <button style={{ padding: "9px 0", width: "100%", border: "none" }}>Cancel</button>;',
    'const x = <button style={{ padding: "9px 0", fontSize: 13, border: "none" }}>{label}</button>;',
    'const x = <a href={u}><img src={u} alt="Attachment 1" /></a>;',
  ];
  for (const jsx of good) assert.deepEqual(audit(jsx, ['text']), [], jsx);
});

// The reader's box model against the browser's own: each case was measured in
// Chromium at 375 x 812 with the app's base.css and Inter loaded. The reader
// may read a control smaller than the browser draws it, never larger.
test('the reader works out a text control\'s box the way the browser draws it (never larger)', () => {
  const measured = [
    // [jsx, Chromium height, Chromium width or null]
    ['<button style={{ padding: "6px 0", border: "none", background: "none", fontSize: 13, fontWeight: 700 }}>Review in full</button>', 28, 83.9],
    ['<div style={{ lineHeight: 1.5 }}><button style={{ padding: "6px 0", border: "none", font: "inherit", fontSize: 13, fontWeight: 700 }}>Review in full</button></div>', 31.5, 83.9],
    ['<button style={{ padding: "6px 14px", fontSize: 13, fontWeight: 600, border: "1px solid #aaa" }}>All</button>', 30, 46.3],
    ['<button style={{ padding: 0, border: "none", fontSize: 13, fontWeight: 700 }}>Edit</button>', 16, 24.4],
    ['<button style={{ padding: 0, border: "none", fontSize: 12, fontWeight: 600 }}>None</button>', 15, 30.9],
    ['<p style={{ fontSize: 13 }}>See <a href="/help">Open link</a>.</p>', 16, null],
    ['<p style={{ fontSize: 12, lineHeight: 1.5 }}>See <a href="/x" style={{ fontWeight: 700, position: "relative", paddingTop: 10, paddingBottom: 10 }}>Open the download</a> now.</p>', 35, null],
  ];
  for (const [jsx, h, w] of measured) {
    const [box] = textBoxes(`const x = ${jsx};`);
    assert.ok(box.h <= h + 0.25 && box.h >= h - 1.5, `${jsx}: reads ${box.h} px tall, Chromium drew ${h}`);
    if (w !== null) assert.ok(box.w <= w + 0.5 && box.w >= w - 2, `${jsx}: reads ${box.w} px wide, Chromium drew ${w}`);
  }
  // Chromium, the same sentence: a padded link that is not positioned is hit
  // only down to its own line (26 px of 35); the reader counts none of the padding below it.
  const [unpositioned] = textBoxes('const x = <p style={{ fontSize: 12, lineHeight: 1.5 }}>See <a href="/x" style={{ paddingTop: 10, paddingBottom: 10 }}>Open the download</a> now.</p>;');
  assert.ok(unpositioned.h <= 26, `reads ${unpositioned.h}`);
  // Chromium, the height that answers a tap (elementFromPoint down the box)
  // where the reader must not read more: padding pulled back by a negative
  // margin with no position, and links in a sentence with a flex property of their own.
  const hit = [
    ['<details style={{ fontSize: 12 }}><summary style={{ padding: "9px 0", margin: "-9px 0" }}>Activity</summary><p>body text line one here</p></details>', 27.5],
    ['<div><p style={{ fontSize: 12 }}>line before</p><details open style={{ fontSize: 12 }}><summary style={{ padding: "9px 0", margin: "-9px 0" }}>Activity</summary><p>body text line one here</p></details></div>', 18],
    ['<div style={{ fontSize: 13 }}><button style={{ display: "block", padding: "9px 0", margin: "-9px 0", border: "none", background: "none", font: "inherit" }}>Review in full</button><div>next row text here</div></div>', 28.5],
    ['<div style={{ display: "flex", flexDirection: "column", fontSize: 13 }}><a href="/x" style={{ padding: "9px 0", margin: "-9px 0" }}>CO board</a><span>next row text here</span></div>', 28.5],
    ['<p style={{ fontSize: 13, lineHeight: 1.5 }}>When every ask is clear, one tap here sends it. <button style={{ padding: 0, border: "none", background: "none", font: "inherit", fontWeight: 700, display: "inline-flex", alignItems: "center", minHeight: 32, margin: "-8px 0" }}>Change it in Settings</button> and more words so the sentence runs on.</p>', 26],
    ['<p style={{ fontSize: 12 }}>See <a href="/x" style={{ flexShrink: 0, minHeight: 32 }}>the guides</a> now.</p>', 15.5],
    ['<p style={{ fontSize: 12 }}>See <a href="/x" style={{ alignSelf: "center", padding: "10px 0" }}>the guides</a> and more text.</p>', 27],
    ['<p style={{ fontSize: 12 }}>See <a href="/x" style={{ display: "inline", flex: 1, minHeight: 40 }}>the guides</a> now.</p>', 15.5],
  ];
  for (const [jsx, h] of hit) {
    const [box] = textBoxes(`const x = ${jsx};`);
    assert.ok(box.h <= h, `${jsx}: reads ${box.h} px, Chromium answers the tap over ${h}`);
  }
  // Positioned, the whole box answers (Chromium 36 of 36).
  const [positioned] = textBoxes('const x = <details style={{ fontSize: 12, lineHeight: 1.5 }}><summary style={{ position: "relative", padding: "9px 0", margin: "-9px 0" }}>Activity</summary><p>body</p></details>;');
  assert.ok(positioned.h <= 36.25 && positioned.h >= 34.5, `reads ${positioned.h}`);
});

test('a link in a sentence reaches the floor with inlineLinkTap from 11 px text up, and the phone floor is TAP_MIN', () => {
  assert.equal(TAP_MIN, 32);
  assert.deepEqual(inlineLinkTap, { position: 'relative', paddingTop: 10, paddingBottom: 10 });
  for (const size of [11, 12, 13, 15]) {
    const [box] = textBoxes(`import { inlineLinkTap } from "../shared/actionButton"; const x = <p style={{ fontSize: ${size} }}>See <a href="/x" style={{ ...inlineLinkTap }}>the guides</a>.</p>;`);
    assert.ok(box.h >= 32, `${size} px: ${box.h}`);
  }
});
