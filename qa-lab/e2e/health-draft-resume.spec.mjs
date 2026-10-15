// Starts a cold page without the old tab’s sessionStorage, with the ledger that
// the live form writes. No manual navigation may hide a failed startup resume.
import { test, expect, watchPage } from './support/fixtures.mjs';
import { field, row, lit, stamp } from './support/lab.mjs';
import { phoneCredentials, newPhoneMember, phoneUse } from './support/phone-helpers.mjs';
test.use(phoneUse(390));

test('unfinished vaccination automatically reopens after a cold page restart, retains its dose, and Cancel saves nothing', { tag: ['@SYNC-005'] }, async ({page,qa}) => {
  const member=await newPhoneMember(page,{firstName:'Draft',lastName:'Resume'}), name=stamp('QA vaccine draft');
  await phoneCredentials(page,'Health Records');
  await page.getByRole('button',{name:/^(\+ )?Add$/}).first().click();
  let dialog=page.getByRole('dialog').last();
  await field(dialog,'Category').selectOption('Vaccination');
  await field(dialog,'Type').selectOption('Other');
  await field(dialog,'Display Name').fill(name);
  await field(dialog,'Lot / Batch #').fill('QA-LOT-RESUME');
  await dialog.getByRole('button',{name:'Add a dose',exact:true}).click();
  await dialog.getByLabel('Dose 1 manufacturer',{exact:true}).fill('QA-MFG');
  await dialog.getByLabel('Dose 1 lot',{exact:true}).fill('QA-DOSE');
  await qa.feature('SYNC-005','A fresh document finds the live shared health draft without section navigation',async()=>{
    // A new page in the same guarded context keeps this account's origin
    // storage and cookie but starts without the old tab's sessionStorage.
    // Close the old page first so its draft lock no longer says it is live.
    const url=page.url(), context=page.context();
    await page.close();
    const fresh=await context.newPage(); watchPage(fresh,qa.report);
    await fresh.goto(url,{waitUntil:'domcontentloaded'});
    dialog=fresh.getByRole('dialog').filter({hasText:'Add Health Record'}).last();
    await expect(dialog).toBeVisible({timeout:20000});
    await expect(dialog.getByText('Restored what you were typing before the app closed. Save it, or Cancel to discard it.',{exact:true})).toBeVisible();
    await expect(field(dialog,'Display Name')).toHaveValue(name);
    await expect(field(dialog,'Lot / Batch #')).toHaveValue('QA-LOT-RESUME');
    await expect(dialog.getByLabel('Dose 1 manufacturer',{exact:true})).toHaveValue('QA-MFG');
    await expect(dialog.getByLabel('Dose 1 lot',{exact:true})).toHaveValue('QA-DOSE');
    await qa.shot('health draft reopened automatically',fresh);
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await fresh.reload();
    await expect(fresh.getByRole('button',{name:'Credentials',exact:true}).first()).toBeVisible();
    await expect(fresh.getByRole('dialog').filter({hasText:'Add Health Record'})).toHaveCount(0);
    qa.check('cancel creates no persisted health record',row(`select count(*)::int as n from public.health_records where user_id=${lit(member.profile.id)}`).n===0);
  });
});
