// Stripe sends parameters form-encoded with bracket nesting
// (metadata[app]=x&line_items[0][price]=p&expand[0]=product&expand[]=q).
// This turns them back into objects and arrays, as Stripe's API does.

export function parseStripeParams(text) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const m = /^([^[\]]+)((?:\[[^\]]*\])*)$/.exec(rawKey);
    if (!m) { out[rawKey] = value; continue; }
    const keys = [m[1], ...[...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1])];
    let node = out;
    for (let i = 0; i < keys.length; i++) {
      const last = i === keys.length - 1;
      const nextIsIndex = !last && /^\d*$/.test(keys[i + 1]);
      let key = keys[i];
      if (Array.isArray(node)) key = key === '' ? node.length : Number(key);
      if (last) {
        if (Array.isArray(node[key])) node[key].push(value);
        else node[key] = value;
      } else {
        if (node[key] === undefined || typeof node[key] !== 'object') node[key] = nextIsIndex ? [] : {};
        node = node[key];
      }
    }
  }
  return out;
}

/** '123' -> 123 for integer params; undefined stays undefined. */
export const int = (v) => (v === undefined || v === null || v === '' ? undefined : Number.parseInt(v, 10));
export const bool = (v) => (v === undefined ? undefined : v === true || v === 'true');
/** A Stripe "array" param given as an object with numeric keys or a real array, as a real array. */
export const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v.filter((x) => x !== undefined) : typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]) : [v]);
