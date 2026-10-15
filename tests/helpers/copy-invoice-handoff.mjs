// Fresh-page storage fixtures need their own handoff module too: its scope
// guard must read that page's storageScope, not another page's module state.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function copyInvoiceHandoff(directory) {
  const source = readFileSync(new URL('../../src/utils/invoiceHandoff.js', import.meta.url), 'utf8')
    .replace('"../lib/errorReport.js"', JSON.stringify(new URL('../../src/lib/errorReport.js', import.meta.url).href))
    .replaceAll('"../lib/supabase.js"', JSON.stringify(new URL('../../src/lib/supabase.js', import.meta.url).href));
  const dependencies = ['serverBilling.js', 'pageDiscard.js'];
  let complete = source;
  for (const file of dependencies) complete = complete.replace(`"./${file}"`, JSON.stringify(new URL(`../../src/utils/${file}`, import.meta.url).href));
  writeFileSync(join(directory, 'invoiceHandoff.js'), complete);
  const numbers = readFileSync(new URL('../../src/utils/invoiceNumber.js', import.meta.url), 'utf8')
    .replace('"./helpers.js"', JSON.stringify(new URL('../../src/utils/helpers.js', import.meta.url).href));
  writeFileSync(join(directory, 'invoiceNumber.js'), numbers);
  writeFileSync(join(directory, 'invoiceHandoffStore.js'), readFileSync(new URL('../../src/utils/invoiceHandoffStore.js', import.meta.url), 'utf8'));
  for (const file of ['healthRecordDraft.js', 'formDrafts.js', 'syncRecovery.js']) {
    const content = readFileSync(new URL(`../../src/utils/${file}`, import.meta.url), 'utf8')
      .replace('"../utils/storageScope.js"', '"./storageScope.js"');
    writeFileSync(join(directory, file), content);
  }
}
