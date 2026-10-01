// HOME-023 / NOTIFY-004: Home's Credentials preview graded each license on a
// fixed 90 days (getStatusColor's default and a literal `d <= 90`) while the
// ring, the tiles and Action Required use the member's lead time. With lead
// 30, a license 60 days out counted Active in the tiles and read amber
// "Expiring" in the preview; with lead 180, one 150 days out was the reverse.
// The Credentials rows, the desk table, Screenings, Health Records and the
// administrator's member view drew the same fixed window. Synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getStatusColor } from '../../src/utils/helpers.js';
import { licenseDeskColumns } from '../../src/components/features/licenseDeskColumns.js';
import { recordCard } from '../../src/utils/memberViewer.js';

const inDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('the colour follows the lead time the tiles count with', () => {
  assert.equal(getStatusColor(inDays(60), 30), 'green', 'lead 30: 60 days out is Active, as the tile counts it');
  assert.equal(getStatusColor(inDays(150), 180), 'amber', 'lead 180: 150 days out is Expiring');
  assert.equal(getStatusColor(inDays(20), 14), 'green', 'lead 14: 20 days out is outside the window, not orange');
  assert.equal(getStatusColor(inDays(10), 14), 'orange');
  assert.equal(getStatusColor(inDays(20), 90), 'orange', 'the default window is unchanged');
  assert.equal(getStatusColor(inDays(60)), 'amber');
  assert.equal(getStatusColor(inDays(-1), 30), 'red');
});

test('the desk table and the member view grade on the member\'s lead time', () => {
  const T = { textDim: 'dim', danger: 'danger', warning: 'warning', success: 'success' };
  const expires = lead => licenseDeskColumns(T, lead).find(c => c.key === 'expirationDate');
  const lic = { id: 'l1', type: 'State Medical License', state: 'ZZ', expirationDate: inDays(60) };
  assert.equal(expires(30).color(lic), 'success');
  assert.equal(expires(90).color(lic), 'warning');
  const member = lead => ({ member: { name: 'Synthetic Physician', reminderLeadDays: lead }, sections: {} });
  assert.equal(recordCard('licenses', lic, member(30)).color, 'green');
  assert.equal(recordCard('licenses', { ...lic, expirationDate: inDays(150) }, member(180)).color, 'amber');
});

test('every screen that grades a member\'s record passes the lead time', () => {
  const app = read('src/App.jsx');
  assert.match(app, /const previewLead = reminderLeadDays\(data\.settings\.reminderLeadDays\);/);
  assert.match(app, /getStatusColor\(item\.expirationDate, previewLead\)/, 'the Home preview dot and badge');
  assert.match(app, /color: d <= previewLead \? sc : T\.textMuted/, 'the preview countdown');
  assert.doesNotMatch(app, /d <= 90 \?/);
  assert.match(app, /licenseDeskColumns\(T, reminderLeadDays\(data\.settings\.reminderLeadDays\)\)/);
  for (const rel of ['src/components/features/CrudSection.jsx', 'src/components/features/ScreeningsSection.jsx', 'src/components/features/HealthRecordsSection.jsx']) {
    assert.match(read(rel), /getStatusColor\(item\.expirationDate, reminderLeadDays\(data\.settings\.reminderLeadDays\)\)/, rel);
  }
});
