// Observations only: never retry a click, answer a dialog or alter storage.
export async function observeSignOut(page) {
  const observations = [];
  await page.exposeBinding('__qaObserveSignOut', (_source, event) => {
    if (observations.length < 4000) observations.push(event);
  });
  await page.addInitScript(() => {
    const events = [];
    window.__qaSignOutObservations = events;
    const record = (kind, details = {}) => {
      if (events.length >= 2000) return;
      const event = { document: performance.timeOrigin, at: performance.now(), kind, ...details };
      events.push(event);
      window.__qaObserveSignOut(event).catch(() => {});
    };
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      document.addEventListener(type, event => {
        const button = event.target?.closest?.('button');
        if (!button || !/Sign Out/.test(button.textContent || '')) return;
        const rect = button.getBoundingClientRect();
        record(type, { x: event.clientX, y: event.clientY, top: rect.top,
          height: rect.height, scrollY, trusted: event.isTrusted });
        if (type === 'click') queueMicrotask(() => record('click-dispatch-finished', { prevented: event.defaultPrevented }));
      }, true);
    }
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      const request = Reflect.apply(open, this, args);
      record('idb-open');
      for (const type of ['success', 'error', 'blocked']) request.addEventListener(type, () => record(`idb-open-${type}`));
      return request;
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = Reflect.apply(transaction, this, args);
      record('idb-transaction', { mode: tx.mode });
      for (const type of ['complete', 'abort', 'error']) tx.addEventListener(type, () => record(`idb-transaction-${type}`));
      return tx;
    };
  });
  return observations;
}
