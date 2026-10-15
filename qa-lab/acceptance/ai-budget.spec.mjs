// Exclusive local acceptance of the normally disabled shared-Opus branch.
import { test, expect } from '../e2e/support/fixtures.mjs';
import { lab, mockApi, newMember, openMore, field, row, rows, lit, labExec, scriptAi, tokenFor, stamp } from '../e2e/support/lab.mjs';
import { callFunction } from '../e2e/support/ops-helpers.mjs';
import { verifiedMembershipSubject } from '../e2e/support/membership-responses.mjs';
import { FUNCTIONS_ENV, LAB_SECRETS_JSON } from '../lib/paths.mjs';
import { readFileSync } from 'node:fs';
import { withTemporarySharedAiKey, callsSince } from './shared-ai-key.mjs';
import { assertAiAcceptanceRuntime } from './runtime-guard.mjs';

const KEY = 'anthropic_shared_key';
const store = {
  read: () => row(`select value, updated_at::text as "updatedAt" from public.app_secrets where name=${lit(KEY)}`),
  install(before, value) {
    const statement = before
      ? `update public.app_secrets set value=${lit(value)},updated_at=clock_timestamp() where name=${lit(KEY)} and value=${lit(before.value)} and updated_at=${lit(before.updatedAt)}::timestamptz`
      : `insert into public.app_secrets(name,value,updated_at) values (${lit(KEY)},${lit(value)},clock_timestamp())`;
    labExec(`do $qa$ begin ${statement}; if not found then raise exception 'AI key baseline changed'; end if; end $qa$`);
  },
  restore(before, value) {
    const statement = before
      ? `update public.app_secrets set value=${lit(before.value)},updated_at=${lit(before.updatedAt)}::timestamptz where name=${lit(KEY)} and value=${lit(value)}`
      : `delete from public.app_secrets where name=${lit(KEY)} and value=${lit(value)}`;
    labExec(`do $qa$ begin ${statement}; if not found then raise exception 'AI key changed during restore'; end if; end $qa$`);
  },
};

test('shared Opus monthly budget refuses the real request and Vera visibly answers on Gemini', { tag: ['@OPS-005'] }, async ({ page, qa }) => {
  test.setTimeout(5 * 60 * 1000);
  const rt = lab();
  assertAiAcceptanceRuntime(rt, readFileSync(FUNCTIONS_ENV, 'utf8'));
  expect((await mockApi('/qa/ai')).mode).toBe('mock');
  const signingKey = JSON.parse(readFileSync(LAB_SECRETS_JSON,'utf8')).signingKey;
  const publicJwk = { kty: signingKey.kty, n: signingKey.n, e: signingKey.e, kid: signingKey.kid };
  await qa.feature('OPS-005', 'enabled synthetic shared key: real budget refusal, visible fallback, no generation spend and exact configuration restoration', async () => {
    const priorKey = store.read();
    await withTemporarySharedAiKey(store, async () => {
      const { user, profile } = await newMember(page, { firstName: 'Avery', lastName: 'Budget', profession: 'MD' });
      const initial = await callFunction('ai-proxy', { method: 'GET', headers: { Authorization: `Bearer ${await tokenFor(user)}` } });
      expect(initial.status).toBe(200); expect(initial.data.anthropic_shared).toBe(true); expect(initial.data.over_hard).toBe(false);
      expect(initial.data.unlimited).toBe(false);
      const cap = Number(initial.data.budget_hard_usd); expect(cap).toBeGreaterThan(0);
      await openMore(page, 'Profile & settings');
      await page.getByText(/^Shared Opus: on,/).first().waitFor();
      await field(page, 'Vera answers with').selectOption('opus');
      qa.check('Vera is explicitly set to Claude Opus while this member is under budget', await field(page, 'Vera answers with').inputValue() === 'opus');
      await openMore(page, 'Vera');
      await expect(page.getByRole('heading', { name: /^Vera/ })).toContainText('Opus');
      const pid = profile.id;
      expect(row(`select count(*)::int as n from public.ai_spend_holds where user_id=${lit(pid)}`).n).toBe(0);
      const tag = stamp('budget'); const question = `QA ${tag} which records need attention?`; const answer = `QA ${tag} fallback answer on Gemini.`;
      await scriptAi('gemini', { json: { reply: answer, actions: [] } }, question);
      const beforeCalls = (await mockApi('/qa/ai')).calls;
      // Prime browser status before changing only this synthetic account's spend.
      labExec(`insert into public.ai_spend_holds(user_id,month_start,worst_case_usd,amount_usd,settled_at) values (${lit(pid)},date_trunc('month',now() at time zone 'utc') at time zone 'utc',${cap},${cap},now())`);
      const responsePromise = page.waitForResponse(response => response.request().method()==='POST' && new URL(response.url()).pathname.endsWith('/functions/v1/ai-proxy/v1/messages') && (response.request().postData() || '').includes(question), { timeout: 60000 }).catch(() => null);
      await page.getByRole('textbox', { name: /Ask Vera anything/ }).fill(question);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const response = await responsePromise; expect(response, 'actual account-owned Opus request was observed').not.toBeNull(); const refusal = await response.json();
      const subject = verifiedMembershipSubject(await response.request().headerValue('authorization'), { jwk: publicJwk, issuer: rt.issuer });
      qa.check('the actual browser request belongs to this synthetic account and gets 429 budget', subject === user.id && response.status()===429 && refusal.error==='budget' && refusal.provider==='anthropic');
      await page.getByText(answer, { exact: false }).first().waitFor({timeout:60000});
      qa.check('the reply visibly explains the monthly budget and Gemini fallback', await page.getByText('The monthly AI budget is used up, so Gemini answered.', {exact:false}).first().isVisible());
      qa.check('the scripted Gemini answer is visible after the same single user action', await page.getByText(answer, {exact:false}).first().isVisible());
      const calls = callsSince(beforeCalls, (await mockApi('/qa/ai')).calls);
      qa.check('all observed provider calls remain mocked', calls.length>0 && calls.every(x=>x.mode==='mock'));
      qa.check('the server counted the Opus request but sent no Anthropic generation', calls.some(x=>x.provider==='anthropic' && x.count===true) && !calls.some(x=>x.provider==='anthropic' && x.count!==true));
      qa.check('the fallback dispatched exactly one Gemini generation', calls.filter(x=>x.provider==='gemini' && x.method==='generateContent').length===1);
      const holds=rows(`select amount_usd,worst_case_usd,settled_at from public.ai_spend_holds where user_id=${lit(pid)}`);
      qa.check('the refusal created no new spend hold for this account', holds.length===1 && Number(holds[0].amount_usd)===cap && Number(holds[0].worst_case_usd)===cap && !!holds[0].settled_at);
      await qa.shot('shared budget refusal and Gemini reply');
    });
    qa.check('the original shared-key row or its absence was restored exactly', JSON.stringify(store.read()) === JSON.stringify(priorKey));
  });
});
