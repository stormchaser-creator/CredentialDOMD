// The home screen's standing ring. A member saw a full ring around "89%":
// a stylesheet animation ending at stroke-dashoffset 0 (fill-mode both)
// outranked the arc's inline offset, so every ring drew complete. The arc
// must cover only its percent, and its color must follow the percent:
// green when complete, yellow above 50, red at 50 and below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mountComponent } from '../component-harness.mjs';

const GREEN = '#10b981', YELLOW = '#f59e0b', RED = '#ef4444';

async function ring(props) {
  const r = await mountComponent('src/components/shared/ComplianceRing.jsx', {
    app: { theme: { text: 'ink', textMuted: 'gray', input: 'track' } },
    props: { size: 120, stroke: 9, label: 'Tracked standing', ...props },
    globals: { performance: { now: () => 0 }, requestAnimationFrame: fn => { fn(10_000); return 1; }, cancelAnimationFrame() {} },
  });
  r.render();
  r.timers.splice(0).forEach(fn => fn()); // the 80 ms start of the arc's transition
  const circles = r.nodes().filter(n => n.type === 'circle');
  return { tree: r.render(), text: r.pageText(), track: circles[0], arc: circles[1], color: r.nodes().find(n => n.type === 'stop').props.stopColor };
}

test('an 89% ring draws 89% of the circumference, not all of it', async () => {
  const { arc, text } = await ring({ percent: 89 });
  assert.match(text, /89%/);
  const dash = arc.props.strokeDasharray, offset = arc.props.strokeDashoffset;
  assert.ok(Math.abs((dash - offset) / dash - 0.89) < 1e-9, `drawn share ${(dash - offset) / dash}`);
});

test('the arc length follows the percent shown', async () => {
  for (const p of [0, 25, 50, 100]) {
    const { arc } = await ring({ percent: p });
    assert.ok(Math.abs((arc.props.strokeDasharray - arc.props.strokeDashoffset) / arc.props.strokeDasharray - p / 100) < 1e-9, `${p}%`);
  }
});

test('green only when complete, yellow above 50, red at 50 and below', async () => {
  const cases = [[100, GREEN], [99, YELLOW], [89, YELLOW], [51, YELLOW], [50, RED], [20, RED], [0, RED]];
  for (const [percent, color] of cases) assert.equal((await ring({ percent })).color, color, `${percent}%`);
});

test('open CME questions keep the percent color but never show a complete ring green', async () => {
  assert.equal((await ring({ percent: 89, pending: true })).color, YELLOW, 'the ticket case: 89% with CME questions open');
  assert.equal((await ring({ percent: 40, pending: true })).color, RED);
  assert.equal((await ring({ percent: 100, pending: true })).color, YELLOW, 'unanswered questions are never an all-clear');
});

// No stylesheet may animate or set the ring's dash offset: a CSS animation
// outranks the inline strokeDashoffset React writes, whatever the percent.
test('no stylesheet rule animates or sets an SVG circle\'s dash offset', () => {
  const dir = fileURLToPath(new URL('../../src/styles/', import.meta.url));
  const app = readFileSync(fileURLToPath(new URL('../../src/App.jsx', import.meta.url)), 'utf8');
  const ringClasses = [...app.matchAll(/className="([^"]+)"[^>]*>\s*<ComplianceRing/g)].map(m => m[1]);
  assert.ok(ringClasses.length >= 2, 'both hero rings are found');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.css'))) {
    const css = readFileSync(dir + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const hitsRing = /\bcircle\b/.test(selector) || ringClasses.some(c => selector.includes(`.${c}`));
      if (!hitsRing) continue;
      assert.doesNotMatch(body, /animation|stroke-dash/, `${file}: "${selector.trim()}" would override the arc`);
    }
  }
});
