// Every button, link and form field in the app's source, including the ones
// that only appear after a tap, held to the rules the rendered screens are
// held to (source-audit.mjs). A new icon-only button without an aria-label,
// or a field whose visible label is not tied to it, fails here by file:line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSource } from './source-audit.mjs';
import { auditHtml } from './html-audit.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? sources(join(dir, d.name)) : /\.jsx$/.test(d.name) ? [join(dir, d.name)] : []));

test('no button, link or form field in src is unusable by name', () => {
  const problems = sources(join(root, 'src')).flatMap(file => auditSource(readFileSync(file, 'utf8'), relative(root, file)));
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

// The two readers, on markup and source they must refuse and must accept.
test('the source reader refuses what a screen reader cannot use', () => {
  const bad = [
    '<button onClick={f}><CloseIcon /></button>',
    '<button onClick={f}>&times;</button>',
    '<button title="Attach" onClick={f}>📎</button>',
    '<a href="/x"><svg /></a>',
    '<div><label>Name</label><input value={v} onChange={f} /></div>',
    '<select value={v} onChange={f}><option>A</option></select>',
    '<Field label="Dates"><div><input type="date" /><input type="date" /></div></Field>',
    // Field ties nothing when the row maps out a list or can show two fields.
    '<Field label="Rates"><input />{rows.map(r => <input key={r} aria-label={r} />)}</Field>',
    '<Field label="On call"><div>{rows.map(r => <div key={r}><input /></div>)}</div></Field>',
    '<Field label="Password"><input type="password" />{locked && <input aria-label="Lock code" />}</Field>',
    '<button onClick={() => setTab(t.id)} style={{ color: tab === t.id ? a : b }}>{t.label}</button>',
    '<div role="dialog">x</div>',
    '<button role="switch" aria-label="On" onClick={f} />',
  ];
  for (const jsx of bad) assert.notDeepEqual(auditSource(`const x = ${jsx};`, 'x.jsx'), [], jsx);
});

test('the source reader accepts named buttons and labelled fields', () => {
  const good = [
    '<button aria-label="Close" onClick={f}><CloseIcon /></button>',
    '<button onClick={f}><CloseIcon /> Close</button>',
    '<button onClick={f}>{label}</button>',
    '<label>Name <input value={v} onChange={f} /></label>',
    '<><label htmlFor="n">Name</label><input id="n" /></>',
    '<><span id={`${id}-n`}>Name</span><input aria-labelledby={`${id}-n`} /></>',
    '<Field label="Name"><input /></Field>',
    '<Field label="When"><div style={{ display: "flex" }}><input type="date" /><button>Today</button></div></Field>',
    '<Field label="Kind">{choice ? <select /> : <input />}</Field>',
    '<Field label="Issuer"><><input list="d" /><datalist id="d" /></></Field>',
    '<Field label="Rates">{rows.map(r => <input key={r} aria-label={r} />)}<button>Add</button></Field>',
    '<Field label="Password"><input type="password" aria-label="Password" />{locked && <input aria-label="Lock code" />}</Field>',
    '<Field label="NPI"><input />{a && <p>x</p>}{b ? <p>y</p> : <p>z</p>}{list.map(r => <button key={r}>{r}</button>)}</Field>',
    '<input type="file" style={{ display: "none" }} />',
    '<input type="hidden" value="x" />',
    '<button aria-pressed={tab === t.id} onClick={() => setTab(t.id)} style={{ color: tab === t.id ? a : b }}>{t.label}</button>',
    '<div role="dialog" aria-modal="true" aria-label="Receipt">x</div>',
    '<button role="switch" aria-checked={on} aria-label="On" onClick={f} />',
  ];
  for (const jsx of good) assert.deepEqual(auditSource(`const x = ${jsx};`, 'x.jsx'), [], jsx);
});

test('the markup reader refuses what a screen reader cannot use, and accepts the rest', () => {
  const bad = [
    '<button><svg></svg></button>',
    '<button>×</button>',
    '<a href="/x"><img src="a.png" alt=""/></a>',
    '<label>Name</label><input value=""/>',
    '<label for="a">Name</label><input id="b"/>',
    '<select><option>A</option></select>',
    '<textarea placeholder="Say something"></textarea>',
    '<div role="dialog" aria-label="X">x</div>',
    '<div role="dialog" aria-modal="true">x</div>',
    '<button role="switch" aria-label="On"></button>',
    '<label for="a">A</label><input id="a"/><label for="a">B</label><input id="a"/>',
    '<button aria-labelledby="missing"></button>',
  ];
  for (const html of bad) assert.notDeepEqual(auditHtml(html), [], html);
  const good = [
    '<button aria-label="Close"><svg></svg></button>',
    '<button><svg></svg> Close</button>',
    '<a href="/x"><img src="a.png" alt="Home"/></a>',
    '<label for="a">Name</label><input id="a" value=""/>',
    '<label>Name <input value=""/></label>',
    '<span id="n">Name</span><select aria-labelledby="n"></select>',
    '<input aria-label="Search"/>',
    '<input type="file" style="display:none"/>',
    '<div role="dialog" aria-modal="true" aria-label="Receipt">x</div>',
    '<button role="switch" aria-checked="false" aria-label="Email reminders"></button>',
  ];
  for (const html of good) assert.deepEqual(auditHtml(html), [], html);
});
