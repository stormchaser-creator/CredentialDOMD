import { waitFor } from '../../lib/procs.mjs';

const jsonContent = value => JSON.stringify(value, (key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.keys(child).sort().map(name => [name, child[name]])) : child);

// Observe before sign-in: the first setup write can finish before the app's
// membership controls become visible. A later visit must not interrupt it.
export function observeInitialSetupSave(page) {
  const saved = new Map();
  let disposed = false;
  const onResponse = response => {
    void (async () => {
      const request = response.request();
      const url = new URL(request.url());
      if (url.pathname !== '/rest/v1/profiles' || request.method() !== 'PATCH' || response.status() !== 200) return;
      const filter = url.searchParams.get('id');
      if (!filter?.startsWith('eq.')) return;
      const profileId = filter.slice(3);
      const setup = request.postDataJSON()?.setup_state;
      if (!profileId || !setup?.startedAt || !setup.progress) return;
      if (await response.finished()) return;
      const row = await response.json();
      if (!disposed && row?.id === profileId && jsonContent(row.setup_state) === jsonContent(setup)) saved.set(profileId, true);
    })().catch(() => {}); // An unread or interrupted answer cannot certify a save.
  };
  page.on('response', onResponse);
  return {
    wait(profileId, timeoutMs = 20000) {
      return waitFor('this account’s initial setup-state save to finish', () => saved.get(profileId), { timeoutMs, intervalMs: 25 });
    },
    dispose() { disposed = true; page.off('response', onResponse); },
  };
}

// WebKit can attribute window.open's download to the child page. Listen
// before the click and remove every listener on success, failure or timeout.
export async function captureDownload(page, action, { timeoutMs = 60000 } = {}) {
  const context = page.context();
  const watched = new Set();
  let timer, accept;
  const downloaded = new Promise(resolve => { accept = resolve; });
  const onDownload = download => accept(download);
  const watch = target => { if (!watched.has(target)) { watched.add(target); target.on('download', onDownload); } };
  context.on('page', watch);
  watch(page);
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('No browser download began before the deadline.')), timeoutMs);
  });
  deadline.catch(() => {});
  try {
    await Promise.race([Promise.resolve().then(action), deadline]);
    return await Promise.race([downloaded, deadline]);
  } finally {
    clearTimeout(timer);
    context.off('page', watch);
    for (const target of watched) target.off('download', onDownload);
  }
}
