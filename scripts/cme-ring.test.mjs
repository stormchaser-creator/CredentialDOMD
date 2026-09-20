// Run the actual ring's effects with a deterministic animation clock. No DOM,
// provider state, medical rules, or persisted records are substituted or changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = await readFile(new URL('../src/components/shared/ComplianceRing.jsx', import.meta.url), 'utf8');
function fixture() {
  const hooks = [], effects = [], timers = new Map(), frames = new Map();
  let cursor = 0, nextId = 0, clock = 0;
  const react = {
    memo: f => f, useId: () => 'synthetic-ring',
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], value => { hooks[i] = value; }];
    },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(fn, deps) {
      const i = cursor++, old = hooks[i];
      if (!old || deps.some((d, index) => d !== old.deps[index])) {
        hooks[i] = { deps };
        effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = fn(); });
      }
    },
  };
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  const context = vm.createContext({ module, exports: module.exports,
    require: name => ({ react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../context/AppContext': { useApp: () => ({ theme: { textMuted: 'gray' } }) } })[name],
    performance: { now: () => clock },
    setTimeout: fn => { const id = ++nextId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++nextId; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, context);
  return {
    render(props) { cursor = 0; const result = module.exports.default(props); effects.splice(0).forEach(fn => fn()); return result; },
    finishAnimation() {
      for (const [id, fn] of timers) { timers.delete(id); fn(); }
      clock += 800;
      for (const [id, fn] of [...frames]) { frames.delete(id); fn(clock); }
    },
  };
}
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const text = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : '';

test('unanswered CME still displays the animated numeric score and arc with explicit meaning', () => {
  const f = fixture(), props = { percent: 50, pending: true, label: 'Tracked standing' };
  f.render(props); f.finishAnimation();
  const ring = f.render(props), arc = nodes(ring, 'circle')[1];
  assert.match(text(ring), /50%Tracked standing/);
  assert.equal(arc.props.strokeDashoffset, arc.props.strokeDasharray / 2);
  assert.equal(ring.props.role, 'progressbar');
  assert.equal(ring.props['aria-valuenow'], 50);
  assert.match(ring.props['aria-valuetext'], /CME questions still need answers.*not CME completion/);
  assert.equal(nodes(ring, 'stop')[0].props.stopColor, 'gray', 'unanswered questions are never an all-clear color');

  f.render({ ...props, percent: 100 }); f.finishAnimation();
  const full = f.render({ ...props, percent: 100 });
  assert.match(text(full), /100%/);
  assert.equal(nodes(full, 'circle')[1].props.strokeDashoffset, 0);
  assert.match(full.props['aria-valuetext'], /questions still need answers/);
});

test('resolved questions preserve numeric animation while invalid percentages remain finite', () => {
  const f = fixture();
  f.render({ percent: 75 }); f.finishAnimation();
  const ring = f.render({ percent: 75 });
  assert.match(text(ring), /75%/);
  assert.doesNotMatch(ring.props['aria-valuetext'], /questions still need answers/);
  f.render({ percent: NaN }); f.finishAnimation();
  const invalid = f.render({ percent: NaN });
  assert.equal(invalid.props['aria-valuenow'], 0);
  assert.match(text(invalid), /0%/);
  assert.ok(Number.isFinite(nodes(invalid, 'circle')[1].props.strokeDashoffset));
});
