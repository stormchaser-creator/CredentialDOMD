// The Playwright fixtures every journey uses.
//
//   * Every browser context refuses requests to hosts that are not this machine
//     (and records them), exactly as qa:smoke does. A journey fails if the app
//     tried to reach anything else, Stripe's hosted pages included: the QA
//     build itself sends the browser to the mock's stand-ins on the app's
//     origin (qa-lab/app/vite.config.mjs), as a tester's own browser would be.
//   * Console errors, page errors and failed local requests are recorded per
//     journey and attached to its report.
//   * `qa` records what the checklist needs: which feature a stretch of the
//     journey exercises (qa.feature), the checks inside it (qa.check, soft: the
//     journey goes on and fails at the end), product bugs with evidence
//     (qa.bug), features a journey could not reach (qa.blocked), screenshots
//     (qa.shot). The results reporter turns these into
//     qa-lab/.generated/results.json.
import { test as base, expect } from '@playwright/test';
import { lab, shot as takeShot } from './lab.mjs';

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function guardContext(context, report) {
  const rt = lab();
  return context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || LOCAL.has(url.hostname)) return route.continue();
    // Signed Storage URLs made by edge functions name the gateway as the functions see it
    // (http://kong:8000, the stack's internal Docker host; production's is the public project
    // URL). Serve them from the local gateway instead, as the browser would reach production's.
    if (url.hostname === 'kong') {
      return route.fetch({ url: `${rt.urls.api}${url.pathname}${url.search}` }).then((response) => route.fulfill({ response }), () => route.abort('failed'));
    }
    report.external.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
}

const watched = new WeakSet();
export function watchPage(page, report) {
  // context.on('page') and the page fixture both see the first page: watch it once.
  if (watched.has(page)) return;
  watched.add(page);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(`${m.type()}: ${m.text().slice(0, 400)}`); });
  page.on('pageerror', (e) => report.pageErrors.push(String(e.message).slice(0, 400)));
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = new URL(r.url());
    report.httpErrors.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
  });
  // Native confirm/alert: recorded, then answered by report.onDialog (default: accept, as the
  // physician who pressed the button would). A journey swaps the policy with qa.onDialog.
  page.on('dialog', async (d) => {
    report.dialogs.push(`${d.type()}: ${d.message().slice(0, 300)}`);
    const answer = report.onDialog ? await report.onDialog(d) : 'accept';
    if (answer === 'dismiss') await d.dismiss().catch(() => {}); else await d.accept().catch(() => {});
  });
}

const newReport = () => ({ external: [], console: [], pageErrors: [], httpErrors: [], dialogs: [] });

export const test = base.extend({
  report: async ({}, use) => { await use(newReport()); },

  context: async ({ context, report }, use) => {
    await guardContext(context, report);
    context.on('page', (p) => watchPage(p, report));
    await use(context);
  },

  page: async ({ page, report }, use) => {
    watchPage(page, report);
    await use(page);
  },

  /** A second, clean browser (no storage shared with `page`), guarded the same way. */
  secondBrowser: async ({ browser, report }, use) => {
    const contexts = [];
    await use(async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await guardContext(context, report);
      const page = await context.newPage();
      watchPage(page, report);
      contexts.push(context);
      return { context, page };
    });
    for (const c of contexts) await c.close().catch(() => {});
  },

  qa: async ({ page, report }, use, testInfo) => {
    const record = (type, value) => testInfo.annotations.push({ type, description: JSON.stringify(value) });
    let current = null;
    const qa = {
      /**
       * Runs one checklist feature's stretch of the journey. A throw marks it failed and stops
       * the journey; with { soft: true } the journey goes on to its next stretch (and still fails).
       */
      async feature(id, title, fn, { soft = false } = {}) {
        const prev = current;
        current = { id, checks: [], shots: [] };
        const started = Date.now();
        try {
          await base.step(`${id} ${title}`, fn);
          const failed = current.checks.filter((c) => !c.ok);
          record('qa-feature', { id, title, status: failed.length ? 'fail' : 'pass', checks: current.checks, shots: current.shots, ms: Date.now() - started });
        } catch (e) {
          const s = await takeShot(page, `${testInfo.titlePath.slice(1).join(' ')} ${id} error`.slice(0, 120), testInfo).catch(() => null);
          if (s) current.shots.push(s);
          record('qa-feature', { id, title, status: 'fail', checks: current.checks, shots: current.shots, error: String(e.message || e).split('\n').slice(0, 6).join('\n'), ms: Date.now() - started });
          if (!soft) throw e;
          expect.soft(String(e.message || e).split('\n')[0], `${id} ${title} stopped`).toBe('');
          await page.keyboard.press('Escape').catch(() => {});
        } finally { current = prev; }
      },
      /** A soft check inside the current feature: recorded, and the journey goes on. */
      check(name, ok, detail = '') {
        const entry = { name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
        (current?.checks || []).push(entry);
        expect.soft(!!ok, `${current?.id || ''} ${name}${detail ? ` (${entry.detail.slice(0, 300)})` : ''}`).toBe(true);
        return !!ok;
      },
      /** A product bug found by this journey. Pair it with a failed qa.check when the checklist's expected result is not met. */
      bug({ title, step, expected, actual, severity = 'medium', feature, screenshot }) {
        record('qa-bug', { feature: feature || current?.id || null, title, step, expected, actual, severity, screenshot: screenshot || current?.shots.at(-1) || null, journey: testInfo.titlePath.slice(1).join(' > ') });
      },
      /** A feature this journey cannot exercise in the lab, and why. */
      blocked(id, reason) { record('qa-feature', { id, title: '', status: 'blocked', reason, checks: [], shots: [] }); },
      async shot(name) {
        const s = await takeShot(page, `${testInfo.titlePath.slice(1).join(' ')} ${name}`.slice(0, 140), testInfo);
        current?.shots.push(s);
        return s;
      },
      /** How the next native dialogs are answered: fn(dialog) -> 'accept' | 'dismiss' (null restores accept). */
      onDialog(fn) { report.onDialog = fn; },
      report,
    };
    await use(qa);
    await testInfo.attach('browser-report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    // Nothing may leave this machine.
    expect.soft(report.external, 'requests to hosts other than this machine').toEqual([]);
  },
});

export { expect };
