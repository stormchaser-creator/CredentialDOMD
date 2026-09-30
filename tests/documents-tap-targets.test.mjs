// Phone tap targets on Documents (DOCS-002, DOCS-009). The QA lab measured,
// on a phone, the Smart Scan review card's "Not right?" type chips at 22 px
// tall and 4 px apart, a stored document's delete button at 30 x 26, and
// "File with AI" and "Select to send" at 30 px: all under the lab's 32 px
// floor. The app sets box-sizing: border-box on every element
// (src/styles/base.css), so a min-height or min-width here is the size the
// physician taps. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as inboxDocs from '../src/utils/inboxDocs.js';
import * as docLabel from '../src/utils/docLabel.js';
import * as paused from '../src/utils/pausedApplicationRecords.js';
import * as credentialTypes from '../src/constants/credentialTypes.js';
import * as helpers from '../src/utils/helpers.js';
import * as guard from '../src/utils/spreadsheetGuard.js';
import * as phiGuard from '../src/utils/phiGuard.js';
import * as customCategories from '../src/utils/customCategories.js';
import * as officeText from '../src/utils/officeText.js';
import * as actionButton from '../src/components/shared/actionButton.js';
import { mountComponent, settle } from './component-harness.mjs';
import { loadScreens, renderScreen, THEME } from './harness/component-harness.mjs';

const MIN_TAP = 32;
const px = (v) => (typeof v === 'number' ? v : Number.parseFloat(v) || 0);

test('DOCS-002: every "Not right?" type chip on the review card is at least 32 x 32, and the chips are spaced', async () => {
  const { ScanReviewCard } = await loadScreens('export { default as ScanReviewCard } from "./src/components/features/ScanReviewCard.jsx";');
  const html = renderScreen(ScanReviewCard, {
    app: { theme: THEME, data: { settings: { degreeType: 'MD', name: 'Dana Synthetic' }, locumContracts: [], customCategories: [], customRecords: [] }, allTrackedStates: [] },
    props: { result: { documentType: 'license', confidence: 'high', extracted: { type: 'State Medical License', state: 'CO', licenseNumber: 'QA-0001', expirationDate: '2028-05-31' } }, fileName: 'scan.jpg', onSave() {}, onDiscard() {} },
  });
  const row = html.match(/<div style="([^"]*)"><span[^>]*>Not right\?<\/span>([\s\S]*?)<\/div>/);
  assert.ok(row, 'the "Not right?" row is on the card');
  const chips = [...row[2].matchAll(/<button aria-pressed="(?:true|false)" style="([^"]*)">([^<]*)<\/button>/g)];
  assert.ok(chips.length >= 8, `the type chips are there (${chips.length})`);
  const css = (style, prop) => style.match(new RegExp(`(?:^|;)${prop}:([^;]*)`))?.[1];
  for (const [, style, label] of chips) {
    assert.ok(px(css(style, 'min-height')) >= MIN_TAP, `${label}: min-height ${css(style, 'min-height')}`);
    assert.ok(px(css(style, 'min-width')) >= MIN_TAP, `${label}: min-width ${css(style, 'min-width')}`);
  }
  assert.ok(px(css(row[1], 'gap')) >= 6, `chips at least 6 px apart (gap ${css(row[1], 'gap')})`);
});

test('DOCS-009: a stored document\'s delete, File with AI, View PDF and Select to send are at least 32 px', async () => {
  const doc = { id: 'doc-1', name: 'license.pdf', type: 'application/pdf', size: 2048, uploadedAt: '2026-09-01T10:00:00Z', data: 'data:application/pdf;base64,JVBERi0=' };
  const ui = await mountComponent('src/components/features/DocumentsSection.jsx', {
    app: {
      data: { settings: { degreeType: 'MD' }, documents: [doc], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [], locumContracts: [], travelExpenses: [], deductibles: [], customCategories: [], customRecords: [], screenings: [] },
      theme: {}, userIdRef: { current: 'user_synthetic' }, addItem() {}, editItem() {}, deleteItem() {}, setData() {}, updateSettings() {}, navigate() {},
    },
    modules: {
      inboxDocs, docLabel, pausedApplicationRecords: paused, credentialTypes, helpers, spreadsheetGuard: guard, phiGuard, customCategories,
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: f => /\.(docx?|xlsx?|csv|txt|rtf)$/i.test(f?.name || ''), UPLOAD_ACCEPT: '*', extractOfficeText: async () => '', mimeFromName: officeText.mimeFromName },
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.' },
      docPrefill: { isReadableDoc: () => true, contractFromScan: e => ({ entry: e }) },
      useInputStyle: { useInputStyle: () => ({ width: '100%', fontSize: 16 }) },
    },
  });
  const buttons = ui.nodes().filter(n => n.type === 'button');
  const byLabel = (label) => {
    const hit = buttons.find(b => b.props['aria-label'] === label || ui.text(b).trim() === label);
    assert.ok(hit, `${label} is on screen`);
    return hit.props.style || {};
  };
  const trash = byLabel('Delete license.pdf');
  assert.ok(px(trash.minHeight) >= MIN_TAP && px(trash.minWidth) >= MIN_TAP, `delete is ${trash.minWidth} x ${trash.minHeight}`);
  for (const label of ['File with AI', '📕 View PDF', 'Select to send']) {
    assert.ok(px(byLabel(label).minHeight) >= MIN_TAP, `${label}: min-height ${byLabel(label).minHeight}`);
  }
});

// -- DOCS-002 (final lab run): the × that closes a notice --
// After Save to License on a phone, the "Saved ... Open" notice's dismiss
// was a bare × with no padding and no minimum: 11 x 20 at 375 and 390 wide.
// The CV offer, a camera error and a scan error closed with the same ×. Each
// notice is brought up the way the physician brings it up.
async function documentsScreen({ aiOn = true, scanner } = {}) {
  const ids = ['doc-new', 'lic-new'];
  let n = 0;
  return mountComponent('src/components/features/DocumentsSection.jsx', {
    app: {
      data: { settings: { degreeType: 'MD' }, documents: [], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [], locumContracts: [], travelExpenses: [], deductibles: [], customCategories: [], customRecords: [], screenings: [] },
      theme: {}, userIdRef: { current: 'user_synthetic' }, addItem() {}, editItem() {}, deleteItem() {}, setData() {}, updateSettings() {}, navigate() {},
    },
    modules: {
      inboxDocs, docLabel, pausedApplicationRecords: paused, credentialTypes, spreadsheetGuard: guard, phiGuard, customCategories, actionButton,
      helpers: { ...helpers, generateId: () => ids[n++] || `id-${n}` },
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: f => /\.(docx?|xlsx?|csv|txt|rtf)$/i.test(f?.name || ''), UPLOAD_ACCEPT: '*', extractOfficeText: async () => '', mimeFromName: officeText.mimeFromName },
      aiClient: { useAiAvailable: () => aiOn, describeAiStatus: () => 'AI is off.' },
      docPrefill: { isReadableDoc: () => true, contractFromScan: e => ({ entry: e }) },
      useInputStyle: { useInputStyle: () => ({ width: '100%', fontSize: 16 }) },
      HomeSearch: { SECTIONS: [{ key: 'licenses', label: 'Licenses & certs', tab: 'credentials', sub: 'licenses' }] },
      ...(scanner ? { documentScanner: { analyzeDocument: async () => ({}), analyzeDocText: async () => ({}), CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other', ...scanner } } : {}),
    },
  });
}
const pdf = name => new File(['%PDF-1.4 synthetic'], name, { type: 'application/pdf' });

function assertDismissTappable(ui, notice) {
  const page = ui.pageText();
  assert.match(page, notice, 'the notice is on screen');
  const dismiss = ui.nodes().filter(n => n.type === 'button' && n.props['aria-label'] === 'Dismiss notice');
  assert.equal(dismiss.length, 1, 'one notice, one ×');
  const s = dismiss[0].props.style || {};
  assert.ok(px(s.minWidth) >= MIN_TAP && px(s.minHeight) >= MIN_TAP, `the × is ${s.minWidth ?? 'no min'} x ${s.minHeight ?? 'no min'} (at least 32 x 32)`);
  assert.equal(px(s.padding), 0, 'the × is centred in its own box, not padded out of line');
  dismiss[0].props.onClick();
  assert.doesNotMatch(ui.pageText(), notice, 'the × still closes the notice');
}

test('DOCS-002: the Saved ... Open notice after Save to License closes with a 32 x 32 ×', async () => {
  const ui = await documentsScreen({ scanner: { analyzePDF: async () => ({ documentType: 'license', extracted: { type: 'State Medical License', state: 'CO' } }) } });
  await ui.pick(ui.fileInputs().find(x => x.props.multiple), [pdf('license-scan.pdf')]);
  const card = ui.nodes().find(x => typeof x.type === 'function' && x.type.name === 'ScanReviewCard');
  assert.ok(card, 'the review card is shown');
  card.props.onSave('license', { type: 'State Medical License', state: 'CO' }, null, 'license-scan.pdf');
  ui.render();
  assertDismissTappable(ui, /Saved to /);
});

test('DOCS-002: the "looks like your CV" offer closes with a 32 x 32 ×', async () => {
  const ui = await documentsScreen({ scanner: { analyzePDF: async () => ({ documentType: 'cv', extracted: {} }) } });
  await ui.pick(ui.fileInputs().find(x => x.props.multiple), [pdf('synthetic-cv.pdf')]);
  assertDismissTappable(ui, /looks like your CV/);
});

test('DOCS-002: a scan error closes with a 32 x 32 ×', async () => {
  const ui = await documentsScreen({ aiOn: false });
  const upload = ui.nodes().find(n => n.type === 'button' && ui.text(n).trim() === 'Upload');
  assert.ok(upload, 'the Upload button');
  upload.props.onClick();
  ui.render();
  assertDismissTappable(ui, /needs AI/);
});

test('DOCS-002: a camera error closes with a 32 x 32 ×', async () => {
  // A desk browser with no camera permission: getUserMedia is not there.
  const ui = await documentsScreen();
  const camera = ui.nodes().find(n => n.type === 'button' && ui.text(n).trim() === 'Camera');
  assert.ok(camera, 'the Camera button');
  camera.props.onClick();
  await settle();
  ui.render();
  assertDismissTappable(ui, /Could not access camera/);
});
