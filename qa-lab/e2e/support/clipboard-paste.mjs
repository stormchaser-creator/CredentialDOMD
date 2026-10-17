// Verify the actual browser clipboard by pasting, including WebKit where
// readText() is denied. Never replace the product's clipboard methods.
import { mkdir, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const lock = '/private/tmp/credentialdomd-qa-clipboard.lock';

export async function copyAndReadSynthetic(page, copy, markers) {
  if (!markers?.length || markers.some(x => typeof x !== 'string' || !x)) throw new Error('Synthetic clipboard markers are required');
  const deadline = Date.now() + 60000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST' || Date.now() > deadline) throw error; await delay(100); }
  }
  if (page.context().browser()?.browserType().name() === 'chromium') {
    const url = new URL(page.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
      await rmdir(lock);
      throw new Error('Synthetic Chromium clipboard grants require a loopback QA origin');
    }
    // Explicitly approved for isolated QA contexts on loopback origins.
    // Never grant this permission to the user's normal browser session.
    try { await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url.origin }); }
    catch (error) { await rmdir(lock); throw error; }
  }
  const id = `qa-clipboard-${randomUUID()}`;
  const sentinel = `QA synthetic clipboard sentinel ${randomUUID()}`;
  const panel = async (prime) => page.evaluate(({ id, sentinel, prime, markers }) => {
    const box = document.createElement('div'); box.id = id;
    box.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:white;padding:8px';
    const input = document.createElement('textarea'); input.setAttribute('aria-label', 'QA synthetic paste target');
    input.addEventListener('paste', event => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') || '';
      // Never insert unrelated clipboard text into a traceable DOM node.
      if (text === sentinel || markers.every(marker => text.includes(marker))) input.value = text;
      else input.dataset.rejected = 'yes';
    });
    box.append(input);
    if (prime) {
      const button = document.createElement('button'); button.textContent = 'Prime synthetic clipboard';
      button.onclick = async () => {
        try { await navigator.clipboard.writeText(sentinel); box.dataset.primed = 'yes'; }
        catch { box.dataset.primed = 'failed'; }
      }; box.append(button);
    }
    document.body.append(box);
  }, { id, sentinel, prime, markers });
  const remove = () => page.evaluate(id => document.getElementById(id)?.remove(), id);
  const paste = async () => {
    await page.locator(`#${id} textarea`).focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    // Chromium dispatches the native paste asynchronously after keyup. Wait
    // for the input event without returning any clipboard contents.
    await page.waitForFunction(id => { const input = document.querySelector(`#${id} textarea`); return Boolean(input?.value) || input?.dataset.rejected === 'yes'; }, id, { timeout: 5000 });
  };
  try {
    await panel(true);
    await page.locator(`#${id} button`).click();
    await page.waitForFunction(id => document.getElementById(id)?.dataset.primed, id);
    if (await page.locator(`#${id}`).getAttribute('data-primed') !== 'yes') throw new Error('Could not prime synthetic clipboard; no clipboard read attempted');
    const primedBy = Date.now() + 5000;
    for (;;) {
      await page.locator(`#${id} textarea`).fill('');
      await paste();
      const control = await page.evaluate(({ id, sentinel }) => {
        const input = document.querySelector(`#${id} textarea`);
        return { matches: input.value === sentinel, rejected: input.dataset.rejected === 'yes' };
      }, { id, sentinel });
      if (control.matches) break;
      if (control.rejected || Date.now() >= primedBy) throw new Error('Synthetic clipboard paste control failed');
      await delay(100);
    }
    await remove();
    await copy();
    await panel(false);
    const copiedBy = Date.now() + 5000;
    for (;;) {
      await page.locator(`#${id} textarea`).fill('');
      await paste();
      const state = await page.evaluate(({ id, markers, sentinel }) => {
        const input = document.querySelector(`#${id} textarea`);
        if (input.dataset.rejected === 'yes') return 'unexpected';
        return input.value === sentinel ? 'sentinel' : markers.every(marker => input.value.includes(marker)) ? 'matched' : 'unexpected';
      }, { id, markers, sentinel });
      if (state !== 'sentinel' || Date.now() >= copiedBy) break;
      // The click can finish before the operating system publishes its async
      // clipboard write. Re-paste until the real write settles; no-copy keeps
      // the sentinel and is rejected when this bounded wait ends.
      await delay(100);
    }
    // Do not put unrelated clipboard contents into traces or assertion logs.
    return await page.evaluate(({ id, markers, sentinel }) => {
      const text = document.querySelector(`#${id} textarea`).value;
      return text !== sentinel && markers.every(marker => text.includes(marker)) ? text : '';
    }, { id, markers, sentinel });
  } finally { await remove().catch(() => {}); await rmdir(lock); }
}
