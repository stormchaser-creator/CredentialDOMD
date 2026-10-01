// QA SUPPORT-004: the Help & FAQ screen (FAQSection.jsx), run for real.
//   * The open answer was tracked by its index in the filtered list, so
//     searching expanded whichever question slid into that slot, and clearing
//     the search re-expanded the first one.
//   * The search field was 14px, so iOS Safari zoomed the page on focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import * as membershipCopy from '../src/content/membershipCopy.js';

async function faq() {
  const m = await mountComponent('src/components/pages/FAQSection.jsx', {
    modules: { membershipCopy, Icons: { AsclepiusIcon: 'AsclepiusIcon' }, ShareFormatProbe: { default: 'ShareFormatProbe' } },
    app: { theme: {} },
  });
  const questions = () => m.nodes().filter(n => n.type === 'button' && n.props.onClick).map(b => ({ q: m.text(b.props.children[0]), button: b }));
  const openQuestions = () => {
    const out = [];
    const visit = n => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (!n || typeof n !== 'object' || !n.props) return;
      const kids = [].concat(n.props.children).flat(Infinity);
      const button = kids.find(k => k?.type === 'button' && k.props.onClick);
      // A question card whose answer is showing has a second child after the button.
      if (button && kids.filter(k => k && typeof k === 'object').length > 1) out.push(m.text(button.props.children[0]));
      kids.forEach(visit);
    };
    visit(m.render());
    return out;
  };
  const search = value => { m.nodes().find(n => n.type === 'input').props.onChange({ target: { value } }); m.render(); };
  return { m, questions, openQuestions, search };
}

test('an open answer stays with its own question while searching, and nothing else opens', async () => {
  const f = await faq();
  const all = f.questions();
  const first = all[0], later = all.find(x => x.q.includes('ticket submitted'));
  assert.ok(later, 'a question from a later category');
  first.button.props.onClick(); f.m.render();
  assert.deepEqual(f.openQuestions(), [first.q]);

  // Search for the later question only: it now sits where the first one was.
  f.search(later.q);
  assert.deepEqual(f.questions().map(x => x.q), [later.q]);
  assert.deepEqual(f.openQuestions(), [], 'the question that took the first slot is not expanded');

  // Clear: the question the reader opened is still the open one.
  f.search('');
  assert.deepEqual(f.openQuestions(), [first.q]);

  // Opening one in a filtered list and clearing keeps that one open.
  f.search(later.q);
  f.questions()[0].button.props.onClick(); f.m.render();
  f.search('');
  assert.deepEqual(f.openQuestions(), [later.q]);
});

test('the search field is 16px, so iOS Safari does not zoom on focus', async () => {
  const f = await faq();
  const input = f.m.nodes().find(n => n.type === 'input');
  assert.ok(input.props.style.fontSize >= 16, `fontSize ${input.props.style.fontSize}`);
});

// Today's release added Cancel and get a refund and states the money-back
// guarantee; Help & FAQ found neither ("No matching questions found"), and
// its only cancel answer sent members to turn off renewal, which keeps the
// payment. The answer quotes the guarantee exactly as the offer does.
test('searching refund or money back finds the refund answer, which quotes the guarantee verbatim', async () => {
  const f = await faq();
  for (const term of ['refund', 'money back', 'money-back', 'guarantee']) {
    f.search(term);
    assert.ok(f.questions().some(x => x.q === 'Can I get my money back?'), term);
  }
  f.search('money back');
  const item = f.questions().find(x => x.q === 'Can I get my money back?');
  item.button.props.onClick(); f.m.render();
  const page = f.m.text(f.m.render());
  assert.ok(page.includes(membershipCopy.MEMBERSHIP_COPY.refundTerms), 'the guarantee text, unchanged');
  assert.match(page, /More > Profile & settings and use Cancel and get a refund under Your membership/);
});

test('the cancel answer points at the refund path', async () => {
  const f = await faq();
  f.search('Can I cancel anytime');
  const cancel = f.questions().find(x => x.q === 'Can I cancel anytime?');
  cancel.button.props.onClick(); f.m.render();
  assert.match(f.m.text(f.m.render()), /Cancel and get a refund/);
});
