// Setup's packet rows, used the way a member assembling a credentialing packet
// does: the CME drawer (import a transcript, add one by hand), the headshot
// (upload, crop, use it; a second try cancelled keeps the first; keep several
// under Professional Photo), the capture run that attaches a copy to each
// license (choose a file, skip one, stop the run), and the public-record fill
// (the browser's call to the public-record function is answered by a
// synthetic envelope inside the journey, so no register is ever asked).
import { test } from './support/fixtures.mjs';
import {
  base64Marker, chooseFiles, field, newMember, profileOf, row, rows, scriptAi, sleep, syntheticPdf, waitFor,
} from './support/lab.mjs';
import {
  openSettings, openSetupPage, reloadApp, servePublicRecord, serveSyntheticRegistry, solidPng, syntheticEnvelope,
} from './support/settings-auth-helpers.mjs';

const openRow = (page, label) => page.locator('button').filter({ hasText: label }).first().click();
const onSetup = (page) => page.getByRole('heading', { name: /^Setup$/ }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);

test('setup packet: CME drawer, headshot, capture run, public-record fill; each trip out comes back', {
  tag: ['@SETTINGS-012', '@SETTINGS-017', '@SETTINGS-011', '@SETTINGS-018'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Pia', lastName: 'Packet' });

  await qa.feature('SETTINGS-012', 'CME drawer: "Import my transcript" opens the importer; "Add one by hand" opens the CME add form and comes back', async () => {
    await openSetupPage(page);
    await openRow(page, 'CME for the current cycle');
    await page.getByRole('button', { name: 'Import my transcript' }).click();
    const importer = page.getByRole('dialog', { name: 'Import CME transcript' });
    const opened = await importer.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('cme importer');
    qa.check('"Import my transcript" opens the CME import', opened);
    if (opened) {
      await importer.getByRole('button', { name: 'Close dialog' }).click();
      await importer.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
      qa.check('closing the importer leaves the member on Setup', await onSetup(page));
    }
    await page.getByRole('button', { name: 'Add one by hand' }).click();
    const form = page.getByRole('dialog', { name: 'Add CME' });
    const formOpened = await form.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await sleep(500);
    await qa.shot('after add one by hand');
    const where = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('"Add one by hand" opens the CME add form', formOpened, formOpened ? '' : `no form; the page shows: ${where.slice(0, 160)}`);
    if (formOpened) {
      await field(form, /Title|Activity/).fill('QA synthetic CME activity');
      await form.getByRole('button', { name: 'Close dialog' }).click();
      qa.check('closing the form returns to More > Setup', await onSetup(page));
    } else {
      qa.bug({
        title: 'Setup > CME for the current cycle > "Add one by hand" lands on the CME list with no form open and no way back to Setup',
        step: 'More > Setup > CME for the current cycle > "Add one by hand"',
        expected: 'The CME add form opens, and closing it returns to More > Setup on the CME drawer',
        actual: 'Credentials > CME opens with no form; nothing returns to Setup. The drawer calls openAddIn("cme", "cme") (src/components/features/SetupPage.jsx:536), which sets autoAdd for "cme" (src/App.jsx:407-410), but App renders <CMESection onShare={openShare} /> without crudTarget("cme") (src/App.jsx:2297) and CMESection takes only onShare (src/components/features/CMESection.jsx:51), so autoOpen and the return trip are never wired',
        severity: 'medium',
      });
    }
  }, { soft: true });

  await qa.feature('SETTINGS-017', 'Headshot: upload, crop, use it; it becomes the avatar', async () => {
    await openSetupPage(page);
    await openRow(page, 'Headshot');
    await chooseFiles(page, page.getByRole('button', { name: 'Upload a photo' }), [{ name: 'qa-headshot.png', mimeType: 'image/png', buffer: solidPng(360, 480, [40, 120, 200]) }]);
    const crop = page.getByRole('dialog', { name: 'Position your headshot' });
    const shown = await crop.waitFor({ timeout: 15000 }).then(() => true, () => false);
    await qa.shot('crop');
    qa.check('the crop step opens', shown);
    if (!shown) return;
    await crop.getByRole('button', { name: 'Use this photo' }).click();
    const saved = await waitFor('profile_photo', async () => { const p = profileOf(user.id); return p?.profile_photo ? p : null; }, { timeoutMs: 20000 }).catch(() => null);
    qa.check('profiles.profile_photo holds the cropped photo', /^data:image\//.test(saved?.profile_photo || ''), (saved?.profile_photo || '').slice(0, 40));
    qa.check('the drawer shows it on file', await page.getByRole('img', { name: 'Your headshot' }).isVisible().catch(() => false));
    const avatarSrc = await page.locator('nav img, aside img').first().getAttribute('src').catch(() => null);
    qa.check('the side bar avatar shows the photo', !!avatarSrc && avatarSrc === saved?.profile_photo, (avatarSrc || 'no avatar image').slice(0, 40));
    await reloadApp(page);
    const again = await page.locator('nav img, aside img').first().getAttribute('src').catch(() => null);
    qa.check('after a reload the avatar is still the photo', again === saved?.profile_photo);
  }, { soft: true });

  await qa.feature('SETTINGS-017', 'A second try, cancelled at the crop, keeps the first photo', async () => {
    const before = profileOf(user.id).profile_photo;
    await openSetupPage(page);
    await openRow(page, 'Headshot');
    await chooseFiles(page, page.getByRole('button', { name: 'Upload a photo' }), [{ name: 'qa-headshot-2.png', mimeType: 'image/png', buffer: solidPng(300, 300, [200, 60, 60]) }]);
    const crop = page.getByRole('dialog', { name: 'Position your headshot' });
    await crop.waitFor({ timeout: 15000 });
    await crop.getByRole('button', { name: 'Cancel' }).click();
    await crop.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    await sleep(2000);
    qa.check('Cancel keeps the photo that was on file', profileOf(user.id).profile_photo === before);
  }, { soft: true });

  await qa.feature('SETTINGS-018', 'Headshot: "Keep several under Professional Photo" opens that add form and comes back', async () => {
    await page.getByRole('button', { name: 'Keep several under Professional Photo' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    const opened = await dlg.waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('the Professional Photo add form opens', opened);
    if (!opened) return;
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    const back = await onSetup(page);
    await qa.shot('back from professional photo');
    qa.check('closing it returns to More > Setup', back);
    qa.check('the Headshot drawer is the one open', back && await page.getByRole('button', { name: 'Keep several under Professional Photo' }).isVisible().catch(() => false));
  }, { soft: true });

  // Two licenses to carry proof: added by hand through Setup, as a member would.
  const addLicense = async (number, state) => {
    await openSetupPage(page);
    await openRow(page, 'Your licenses');
    await page.getByRole('button', { name: 'Add a license by hand' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await dlg.waitFor({ timeout: 15000 });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'License #').fill(number);
    await field(dlg, 'State').selectOption(state);
    await field(dlg, /^Expires/).fill('2028-08-31');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    await onSetup(page);
  };

  await qa.feature('SETTINGS-011', 'Capture run: a copy for the first license, skip the second, stop the run', async () => {
    await addLicense('QA-RUN-OR1', 'OR');
    await addLicense('QA-RUN-ID1', 'ID');
    const lics = rows(`select id, license_number from public.licenses where user_id = '${profile.id}' order by license_number`);
    qa.check('two licenses on file for the run', lics.length === 2, JSON.stringify(lics));
    await openRow(page, 'Copies of your license and DEA');
    await page.getByRole('button', { name: 'Start the run' }).click();
    await page.getByRole('button', { name: /^Start with / }).click();
    const first = (await page.locator('div').filter({ hasText: /^(OR|ID) / }).first().innerText().catch(() => '')).trim();
    const pdf = syntheticPdf(`QA synthetic license copy ${Date.now()}`);
    await scriptAi('gemini', { json: { documentType: 'license', confidence: 'high', extracted: { type: 'State Medical License', expirationDate: '2028-08-31' } } }, base64Marker(pdf));
    await chooseFiles(page, page.getByRole('button', { name: 'Choose a file instead' }), [{ name: 'qa-run-copy-1.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    const save = page.getByRole('button', { name: /^Save( and next)?$/ });
    const confirm = await save.waitFor({ timeout: 45000 }).then(() => true, () => false);
    await qa.shot('run confirm');
    qa.check('the run reads the file and asks to confirm', confirm);
    if (!confirm) return;
    await save.click();
    await sleep(1500);
    const linked = await waitFor('the linked copy', async () => rows(`select linked_to, storage_path from public.documents where user_id = '${profile.id}' and name = 'qa-run-copy-1.pdf'`)[0] || null, { timeoutMs: 20000 }).catch(() => null);
    qa.check('the copy is stored and linked to one of the licenses', !!linked?.storage_path && lics.some((l) => linked.linked_to === `licenses:${l.id}`), JSON.stringify(linked));
    await page.getByRole('button', { name: 'Skip this one' }).click();
    const done = await page.getByText('The run is finished. Anything you skipped is still on the list.').waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('skipping the last one finishes the run', done);
    if (done) await page.getByRole('button', { name: 'Back to the list' }).click();
    const other = rows(`select id from public.documents where user_id = '${profile.id}'`).length;
    qa.check('the skipped license got nothing attached', other === 1, `${other} documents`);
    // Start again: only the skipped one is left; stop the run.
    await page.getByRole('button', { name: 'Start the run' }).click();
    await page.getByRole('button', { name: /^Start with / }).click();
    await page.getByRole('button', { name: 'Stop the run' }).click();
    qa.check('"Stop the run" goes back to the drawer', await page.getByRole('button', { name: 'Start the run' }).isVisible().catch(() => false), `first record was ${first}`);
  }, { soft: true });

  await qa.feature('SETTINGS-011', 'Fill from public records: only ticked items are saved; Try again on a failed register; Search again', async () => {
    const npi = `19991${String(Date.now()).slice(-5)}`;
    await serveSyntheticRegistry(page, { npi, first: 'PIA', last: 'PACKET', credential: 'MD', state: 'OR', licenses: [] });
    const bodies = await servePublicRecord(page, (body, n) => (body?.sources?.length ? { ...syntheticEnvelope({ npi }), findings: syntheticEnvelope({ npi }).findings.filter((f) => f.id.startsWith('pubmed:')), sources: syntheticEnvelope({ npi }).sources.filter((s) => s.id === 'pubmed'), errors: [] } : syntheticEnvelope({ npi, failPubmed: n === 1 })));
    await openSetupPage(page);
    await openRow(page, 'Medical school and postgraduate training');
    await page.getByRole('button', { name: 'Fill this from public records' }).click();
    // No NPI on file yet: the screen asks for it first (the lab registry stand-in answers).
    const npiBox = page.getByPlaceholder('Blank searches by name');
    if (await npiBox.isVisible().catch(() => false)) {
      await npiBox.fill(npi);
      await page.getByRole('button', { name: 'Look up' }).click();
    }
    const search = page.getByRole('button', { name: 'Search the public registers' });
    const ready = await search.waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('with the NPI on file the search is offered', ready);
    if (!ready) return;
    await search.click();
    const failedBanner = page.getByText(/PubMed did not answer, so nothing from it is below\./);
    const reviewShown = await failedBanner.waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('public record review');
    qa.check('a register that failed is named, the rest come back', reviewShown);
    qa.check('the function was asked for this NPI', bodies[0]?.npi === npi, JSON.stringify(bodies[0]));
    const edu = page.getByRole('checkbox', { name: /Qa State University School of Medicine/ });
    const work = page.getByRole('checkbox', { name: /Qa Neurosurgery Group/ });
    // Opened on Education, the other groups sit behind their own fold; a lead is never pre-ticked.
    const workShown = await work.count();
    qa.check('the lead (work history) is not ticked by default', !workShown || !(await work.isChecked()), workShown ? 'shown' : 'folded under the other findings');
    await edu.check();
    await page.getByRole('button', { name: 'Try it again' }).click();
    const retried = await failedBanner.waitFor({ state: 'detached', timeout: 20000 }).then(() => true, () => false);
    qa.check('"Try it again" asks only the failed register, and PubMed is no longer reported down', retried && JSON.stringify(bodies[1]?.sources) === '["pubmed"]', JSON.stringify(bodies[1]));
    const saveBtn = page.getByRole('button', { name: /^Save \d+$/ });
    const count = Number((/Save (\d+)/.exec(await saveBtn.innerText().catch(() => '')) || [])[1]);
    await saveBtn.click();
    const savedMsg = await page.getByText(/^Saved \d+ items?\.$/).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('saving says how many were saved', savedMsg, `${count} ticked`);
    const eduRow = await waitFor('the education row', async () => row(`select institution, type from public.education where user_id = '${profile.id}' and institution = 'Qa State University School of Medicine'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('the ticked finding is an education row', eduRow?.type === 'Doctor of Medicine (MD)', JSON.stringify(eduRow));
    qa.check('the unticked lead was not saved', rows(`select id from public.work_history where user_id = '${profile.id}'`).length === 0);
    qa.check('the unticked paper was not saved', rows(`select id from public.publications where user_id = '${profile.id}'`).length === 0);
    await page.getByRole('button', { name: /^Back to the findings/ }).click();
    await page.getByRole('button', { name: 'Search again' }).click();
    await sleep(2500);
    qa.check('"Search again" asks the registers again', bodies.length >= 3, `${bodies.length} calls`);
    await page.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  }, { soft: true });

  await qa.feature('SETTINGS-011', 'Settings > NPI: "Pull from public records", tick one paper, save; Find My NPI results can be dismissed', async () => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Pull from public records' }).click();
    const modal = page.getByRole('dialog', { name: 'Public records' });
    await modal.waitFor({ timeout: 10000 });
    await modal.getByRole('button', { name: 'Search the public registers' }).click();
    const paper = modal.getByRole('checkbox', { name: /A synthetic QA paper on test fixtures/ });
    const shown = await paper.waitFor({ timeout: 20000 }).then(() => true, () => false);
    qa.check('the review opens from Settings', shown);
    if (!shown) return;
    // Clear everything pre-ticked, then tick only the paper.
    await modal.getByRole('button', { name: 'Clear' }).click().catch(() => {});
    await paper.check();
    await modal.getByRole('button', { name: /^Save 1$/ }).click();
    await modal.getByRole('button', { name: 'Done' }).click().catch(() => {});
    const msg = await page.getByText('1 item added from the public registers').waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Settings says one item was added', msg);
    const pub = await waitFor('the publication', async () => row(`select pmid from public.publications where user_id = '${profile.id}'`), { timeoutMs: 15000 }).catch(() => null);
    qa.check('only the ticked paper is saved (publications.pmid 99000001)', pub?.pmid === '99000001' && rows(`select id from public.work_history where user_id = '${profile.id}'`).length === 0, JSON.stringify(pub));
    await page.getByRole('button', { name: 'Re-search' }).click();
    const dismiss = page.getByRole('button', { name: 'Dismiss' });
    const results = await dismiss.waitFor({ timeout: 20000 }).then(() => true, () => false);
    qa.check('Find My NPI lists the registry match', results);
    if (results) {
      await dismiss.click();
      qa.check('"Dismiss" clears the match list', !(await page.getByText(/result(s)? found\. Select yours/).count()));
    }
  }, { soft: true });
});
