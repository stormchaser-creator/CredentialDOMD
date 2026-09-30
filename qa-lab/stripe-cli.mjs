#!/usr/bin/env node
// npm run qa:stripe -- <command>: the lab's Stripe helper, against the running
// lab's mock Stripe (nothing here can reach Stripe itself).
//
//   sessions [--email a@qa.credentialdomd.test | --subject user_qa... | --status open]
//       lists checkout sessions, newest first
//   complete [cs_live_... | --latest | --email a@qa.credentialdomd.test] [--no-events] [--endpoint name]
//            [--concurrent] [--order shuffled|checklist|invoice-first] [--delay MS] [--drop TYPE]
//       completes the checkout as if the buyer paid (a subscription and its paid
//       first invoice), then posts correctly signed checkout.session.completed,
//       customer.subscription.created and invoice.paid events to the local
//       limited-stripe-webhook (or --endpoint), retries any answer that is not
//       2xx the way Stripe does (lab backoff), and prints every attempt. By
//       default one after another in the checklist's order; --concurrent sends
//       them at once, as Stripe does after a real Checkout
//   plan [cs_live_... | --default] [--delay MS] [--order ...] [--sequential] [--drop TYPE] [--clear]
//       how the hosted Pay button delivers the events for one session, or by
//       default (default: 1500 ms after the browser is sent back, all at once, shuffled)
//   expire cs_live_...                       expires an open session (+ checkout.session.expired)
//   cancel sub_... [--now]                   cancel at period end (customer.subscription.updated),
//                                            or at once (customer.subscription.deleted)
//   resend evt_... [--endpoint name]         posts a stored event again
//   deliveries                               the latest webhook deliveries and their answers
//
// Exit code 0 only when every webhook the command posted was answered 2xx.
import { parseArgs } from 'node:util';
import { isMain } from './lib/paths.mjs';
import { readRuntime } from './lab.mjs';

const USAGE = `usage: npm run qa:stripe -- sessions [--email E | --subject S | --status open]
       npm run qa:stripe -- complete [cs_... | --latest | --email E] [--no-events] [--endpoint NAME] [--concurrent] [--order O] [--delay MS] [--drop TYPE]
       npm run qa:stripe -- plan [cs_... | --default] [--delay MS] [--order O] [--sequential] [--drop TYPE] [--clear]
       npm run qa:stripe -- expire cs_...
       npm run qa:stripe -- cancel sub_... [--now]
       npm run qa:stripe -- resend evt_... [--endpoint NAME]
       npm run qa:stripe -- deliveries`;

export function mockClient(runtime = readRuntime()) {
  if (!runtime?.urls?.mock) throw new Error('no QA lab is running: start it with npm run qa:lab');
  return async function call(pathname, { method = 'GET', body } = {}) {
    const r = await fetch(`${runtime.urls.mock}${pathname}`, {
      method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${pathname}: ${r.status} ${data?.error?.message || data?.error || data?.message || ''}`.trim());
    return data;
  };
}

/** The test physician (live instance) with this address, or an error. */
async function subjectForEmail(call, email) {
  const { users } = await call('/qa/users');
  const found = users.find((u) => u.email === String(email).trim().toLowerCase());
  if (!found) throw new Error(`no test physician has the address ${email}`);
  return found.id;
}

const money = (cents) => `${((cents || 0) / 100).toFixed(2)} USD`;
const when = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19);
const sessionLine = (s) => `${s.id}  ${s.status.padEnd(8)} ${money(s.amount_total).padStart(10)}  ${when(s.created)}  ${s.metadata?.offer_id || '?'}  ${s.metadata?.clerk_user_id || s.customer}`;
const deliveryLine = (d) => `${d.dropped ? 'drop' : d.status >= 200 && d.status < 300 ? 'ok  ' : d.willRetry ? 'retry' : 'FAIL'} ${String(d.status || 'none').padEnd(4)} ${d.type.padEnd(32)} -> ${d.endpoint}${d.attempt > 1 ? ` (attempt ${d.attempt})` : ''}  ${String(d.response).replace(/\s+/g, ' ').slice(0, 160)}`;

async function listSessions(call, { email, subject, status }) {
  const q = new URLSearchParams();
  if (email) q.set('subject', await subjectForEmail(call, email));
  if (subject) q.set('subject', subject);
  if (status) q.set('status', status);
  return (await call(`/qa/stripe/sessions?${q}`)).sessions;
}

export async function runStripeCli(argv = process.argv.slice(2), { call = mockClient(), out = console.log } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    email: { type: 'string' }, subject: { type: 'string' }, status: { type: 'string' }, latest: { type: 'boolean', default: false },
    'no-events': { type: 'boolean', default: false }, endpoint: { type: 'string' }, now: { type: 'boolean', default: false },
    concurrent: { type: 'boolean', default: false }, sequential: { type: 'boolean', default: false }, order: { type: 'string' }, delay: { type: 'string' },
    drop: { type: 'string', multiple: true }, default: { type: 'boolean', default: false }, clear: { type: 'boolean', default: false },
  } });
  const planFields = (base) => ({
    ...base,
    ...(values.concurrent ? { mode: 'concurrent' } : values.sequential ? { mode: 'sequential' } : {}),
    ...(values.order ? { order: values.order } : {}), ...(values.delay !== undefined ? { delayMs: Number(values.delay) } : {}),
    ...(values.drop ? { drop: values.drop } : {}),
  });
  const [command, target] = positionals;
  const deliveredOk = (list) => list.every((d) => d.dropped || (d.status >= 200 && d.status < 300));

  switch (command) {
    case 'sessions': {
      const sessions = await listSessions(call, values);
      out(sessions.length ? sessions.map(sessionLine).join('\n') : 'no checkout sessions');
      return { ok: true, sessions };
    }
    case 'complete': {
      let id = target;
      if (!id) {
        if (!values.latest && !values.email && !values.subject) throw new Error('complete needs a session id, --latest or --email');
        const open = await listSessions(call, { ...values, status: 'open' });
        if (!open.length) throw new Error('no open checkout session matches');
        id = open[0].id;
      }
      if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) throw new Error(`not a checkout session id: ${id}`);
      const done = await call(`/qa/stripe/checkout/${encodeURIComponent(id)}/complete`, { method: 'POST', body: { send: !values['no-events'], plan: planFields({ delayMs: 0, order: 'checklist', mode: 'sequential' }), ...(values.endpoint ? { endpoint: values.endpoint } : {}) } });
      out(`completed ${done.session.id}\n  subscription ${done.subscription.id} (${done.subscription.status}), invoice ${done.invoice.id} paid ${money(done.invoice.amount_paid)}`);
      // Every attempt, oldest first (a 503 billing_reconciliation_pending followed by its retry is normal under --concurrent).
      const events = new Set(done.deliveries.map((d) => d.event));
      const attempts = (await call('/qa/stripe/deliveries')).deliveries.filter((d) => events.has(d.event)).reverse();
      for (const d of attempts) out(`  ${deliveryLine(d)}`);
      return { ok: deliveredOk(done.deliveries), ...done };
    }
    case 'plan': {
      if (values.clear) {
        const q = values.default ? 'default=1' : `session=${encodeURIComponent(target || '')}`;
        const r = await call(`/qa/stripe/delivery-plan?${q}`, { method: 'DELETE' });
        out(`cleared the delivery plan for ${r.cleared}`);
        return { ok: true, ...r };
      }
      if (!values.default && !target) {
        const r = await call('/qa/stripe/delivery-plan');
        out(JSON.stringify(r, null, 2));
        return { ok: true, ...r };
      }
      const r = await call('/qa/stripe/delivery-plan', { method: 'POST', body: planFields(values.default ? { default: true } : { session: target }) });
      out(JSON.stringify(r, null, 2));
      return { ok: true, ...r };
    }
    case 'expire': {
      if (!target) throw new Error('expire needs a session id');
      const r = await call(`/qa/stripe/checkout/${encodeURIComponent(target)}/expire`, { method: 'POST', body: values.endpoint ? { endpoint: values.endpoint } : {} });
      out(`expired ${r.session.id}`);
      if (r.delivery) out(`  ${deliveryLine(r.delivery)}`);
      return { ok: !r.delivery || deliveredOk([r.delivery]), ...r };
    }
    case 'cancel': {
      if (!target) throw new Error('cancel needs a subscription id');
      const r = await call(`/qa/stripe/subscriptions/${encodeURIComponent(target)}/cancel`, { method: 'POST', body: { atPeriodEnd: !values.now, ...(values.endpoint ? { endpoint: values.endpoint } : {}) } });
      out(`${values.now ? 'canceled' : 'set to cancel at period end:'} ${r.subscription.id} (${r.subscription.status})`);
      out(`  ${deliveryLine(r.delivery)}`);
      return { ok: deliveredOk([r.delivery]), ...r };
    }
    case 'resend': {
      if (!target) throw new Error('resend needs an event id');
      const d = await call(`/qa/stripe/events/${encodeURIComponent(target)}/resend`, { method: 'POST', body: values.endpoint ? { endpoint: values.endpoint } : {} });
      out(deliveryLine(d));
      return { ok: deliveredOk([d]), delivery: d };
    }
    case 'deliveries': {
      const { deliveries } = await call('/qa/stripe/deliveries');
      out(deliveries.length ? deliveries.slice(0, 30).map(deliveryLine).join('\n') : 'no webhook deliveries yet');
      return { ok: true, deliveries };
    }
    default:
      throw new Error(USAGE);
  }
}

if (isMain(import.meta.url)) {
  runStripeCli().then((r) => process.exit(r.ok ? 0 : 1), (e) => { console.error(`qa-stripe: ${e.message}`); process.exit(1); });
}
