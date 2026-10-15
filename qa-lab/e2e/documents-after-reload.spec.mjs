// A stored file after a reload (DOCS-008, release/goal2 2026-10-02): every
// stored file read "Fetching the file from your account." for good after a
// reload, though Storage answered each download 200. The mechanism: the
// download Documents asked for was tied to the load current when it asked; the
// membership answer starts a second load a moment after the first, and bytes
// that landed after it began were thrown away, with nothing asking again.
//
// Each stretch reloads with Documents on screen and checks the card offers
// View PDF. The second one holds Storage's answer until the second load has
// read the documents table, which reproduced the stuck card every time on
// the build before the fix (utils/documentBytes.js). Synthetic files only.
//
// Since release/goal4 (e1f4b4c9, one account load per launch) the membership
// answer reads the account again only when the load owes it (utils/loadOwes.js).
// The first stretch checks a plain reload reads the documents table once; the
// second makes the answer owe a load the way a weak network does (its read of
// the deletion stamp fails, AppContext deletionSinceLoad "unread"), so the
// second load still happens and the download is held past it, as before.
import { test } from './support/fixtures.mjs';
import { base64Marker, chooseFiles, newMember, row, scriptAi, sleep, syntheticPdf, waitFor, waitForMemberApp } from './support/lab.mjs';
import { phoneTab } from './support/phone-helpers.mjs';

const upload = (page) => page.getByRole('button', { name: 'Upload' }).first();
// Documents: the desk's side navigation, or the phone's "+" tab (the installed iPhone app).
const openDocuments = async (page) => {
  const desk = page.getByRole('navigation').first().getByRole('button', { name: /^(\S+ )?Documents$/ }).first();
  if (await desk.isVisible().catch(() => false)) return desk.click();
  return phoneTab(page, '+');
};
const card = (page) => page.locator('div').filter({ hasText: 'qa-reload-letter.pdf' }).last();
const viewPdf = (page) => page.locator('div').filter({ hasText: 'qa-reload-letter.pdf' }).getByRole('button', { name: /View PDF/ }).first();

test('documents: a stored file opens after a reload, even when its download lands after the second load began', {
  tag: ['@DOCS-008'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Rhea', lastName: 'Reload' });
  const pdf = syntheticPdf(`QA synthetic reload letter ${Date.now()}`);
  await scriptAi('gemini', { json: { documentType: 'unknown' } }, base64Marker(pdf));
  await openDocuments(page);
  await chooseFiles(page, upload(page), [{ name: 'qa-reload-letter.pdf', mimeType: 'application/pdf', buffer: pdf }]);
  const doc = await waitFor('the stored document', async () => row(`select storage_path from public.documents where user_id = '${profile.id}' and name = 'qa-reload-letter.pdf' and storage_path is not null`), { timeoutMs: 45000 }).catch(() => null);
  qa.check('the document is stored with its file', !!doc?.storage_path, JSON.stringify(doc));
  // A load reads the documents table (both the first load and the membership answer's second one).
  let tableReads = 0;
  page.on('request', (r) => { if (r.method() === 'GET' && /\/rest\/v1\/documents$/.test(new URL(r.url()).pathname)) tableReads += 1; });

  await qa.feature('DOCS-008', 'Reload with Documents open: the stored file opens', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await openDocuments(page);
    await card(page).waitFor({ timeout: 30000 });
    const opened = await viewPdf(page).waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('after reload');
    qa.check('View PDF, not "Fetching the file from your account." for good', opened, (await card(page).innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200));
    await sleep(5000);
    qa.check('one account load per launch: the reload read the documents table once (release/goal4)', tableReads === 1, `${tableReads} documents read(s)`);
  });

  await qa.feature('DOCS-008', 'Reload with the file\'s download landing after the second load began: the stored file still opens', async () => {
    tableReads = 0;
    let held = 0;
    // The answer's read of the deletion stamp fails as on a weak network: it owes a load (the second).
    let stampFailed = 0;
    await page.route(/\/rest\/v1\/profiles\?select=deleted_at(%2C|,)data_deleted_at/, (route) => {
      if (route.request().method() !== 'GET' || stampFailed) return route.fallback();
      stampFailed += 1;
      return route.abort('failed');
    });
    await page.route('**/storage/v1/object/**', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      held += 1;
      const until = Date.now() + 40000;
      while (tableReads < 2 && Date.now() < until) await sleep(200);
      return route.fallback();
    });
    try {
      await page.reload();
      await waitForMemberApp(page);
      await openDocuments(page);
      await card(page).waitFor({ timeout: 30000 });
      const opened = await viewPdf(page).waitFor({ timeout: 45000 }).then(() => true, () => false);
      await qa.shot('after reload, download held past the second load');
      qa.check('the answer\'s deletion-stamp read failed, so it read the account again (the owed second load)', stampFailed === 1 && tableReads >= 2, `${stampFailed} stamp read(s) failed, ${tableReads} documents read(s)`);
      qa.check('the download was held until the second load had read the documents', held >= 1 && tableReads >= 2, `${held} download(s) held, ${tableReads} documents read(s)`);
      qa.check('View PDF once the held download lands', opened, (await card(page).innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200));
      if (!opened) {
        qa.bug({
          title: 'Documents: a stored file reads "Fetching the file from your account." for good after a reload',
          step: 'Documents > upload a PDF; reload with Documents open (the membership answer starts a second load while the file downloads)',
          expected: 'The card offers View PDF once the download lands',
          actual: 'The card still says it is fetching; the download landed after the second load began',
          severity: 'high',
        });
      }
    } finally {
      await page.unroute('**/storage/v1/object/**');
      await page.unroute(/\/rest\/v1\/profiles\?select=deleted_at(%2C|,)data_deleted_at/);
    }
  });
});
