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
  const id = `qa-clipboard-${randomUUID()}`;
  const sentinel = `QA synthetic clipboard sentinel ${randomUUID()}`;
  const panel = async (prime) => page.evaluate(({ id, sentinel, prime }) => {
    const box = document.createElement('div'); box.id = id;
    box.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:white;padding:8px';
    const input = document.createElement('textarea'); input.setAttribute('aria-label', 'QA synthetic paste target');
    box.append(input);
    if (prime) {
      const button = document.createElement('button'); button.textContent = 'Prime synthetic clipboard';
      button.onclick = async () => {
        try { await navigator.clipboard.writeText(sentinel); box.dataset.primed = 'yes'; }
        catch { box.dataset.primed = 'failed'; }
      }; box.append(button);
    }
    document.body.append(box);
  }, { id, sentinel, prime });
  const remove = () => page.evaluate(id => document.getElementById(id)?.remove(), id);
  const paste = async () => {
    await page.locator(`#${id} textarea`).focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  };
  try {
    await panel(true);
    await page.locator(`#${id} button`).click();
    await page.waitForFunction(id => document.getElementById(id)?.dataset.primed, id);
    if (await page.locator(`#${id}`).getAttribute('data-primed') !== 'yes') throw new Error('Could not prime synthetic clipboard; no clipboard read attempted');
    await paste();
    if (!await page.evaluate(({ id, sentinel }) => document.querySelector(`#${id} textarea`).value === sentinel, { id, sentinel })) throw new Error('Synthetic clipboard paste control failed');
    await remove();
    await copy();
    await panel(false);
    await paste();
    // Do not put unrelated clipboard contents into traces or assertion logs.
    return await page.evaluate(({ id, markers, sentinel }) => {
      const text = document.querySelector(`#${id} textarea`).value;
      return text !== sentinel && markers.every(marker => text.includes(marker)) ? text : '';
    }, { id, markers, sentinel });
  } finally { await remove().catch(() => {}); await rmdir(lock); }
}
