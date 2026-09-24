import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import vm from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../../src/components/pages/AdminErrorReports.jsx", import.meta.url), "utf8");
const code = transformSync(source, {
  loader: "jsx", format: "cjs", jsx: "automatic", define: { "import.meta.env.BASE_URL": '"/"' },
}).code;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const report = (id, build, message = "Synthetic error") => ({
  id, build, message, kind: "react", created_at: "2026-09-24T12:00:00Z", auth_user_id: "user_synthetic",
  url: "https://example.invalid/app", stack: "Synthetic stack", user_agent: "Synthetic browser",
});

function fixture() {
  const hooks = [], effects = [], cleanups = [], requests = [], receipts = [], confirmations = [];
  let cursor = 0;
  const f = {
    confirmed: true,
    deleteResponse: async ids => ({ data: ids.map(id => ({ id })), error: null }),
    buildResponse: async () => ({ ok: true, json: async () => ({ build: "current" }) }),
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!(index in hooks)) { hooks[index] = true; effects.push(effect); }
    },
  };
  const db = {
    from(table) {
      let requested;
      const query = {
        delete() { return query; },
        in(column, ids) { requested = { table, column, ids: Array.from(ids) }; return query; },
        select(columns) { requests.push({ ...requested, columns }); return f.deleteResponse(requested.ids); },
      };
      return query;
    },
  };
  const props = {
    rows: [report("current-1", "current"), report("other-1", "other"), report("other-2", "other"), report("unknown-1", null)],
    users: [{ id: "profile-synthetic", auth_user_id: "user_synthetic", name: "Synthetic physician" }],
    T: { border: "#ccc", text: "#111", textMuted: "#555", card: "#fff" },
    onCleared(ids) {
      const confirmed = Array.from(ids);
      receipts.push(confirmed);
      props.rows = props.rows.filter(row => !confirmed.includes(row.id));
    },
  };
  const imports = { react, "react/jsx-runtime": require("react/jsx-runtime"), "../../lib/supabase": { supabase: db } };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: name => imports[name], Date,
    fetch: () => f.buildResponse(),
    window: { confirm(message) { confirmations.push(message); return f.confirmed; } },
  });
  f.render = () => { cursor = 0; return module.exports.default(props); };
  f.html = () => renderToStaticMarkup(f.render());
  f.mount = () => { f.render(); for (const effect of effects.splice(0)) cleanups.push(effect()); };
  f.unmount = () => { for (const cleanup of cleanups.splice(0)) cleanup?.(); };
  Object.assign(f, { props, requests, receipts, confirmations });
  return f;
}
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : [];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" ? text(node.props?.children) : node == null ? "" : String(node);
}
const button = (f, pattern) => nodes(f.render()).find(node => node.type === "button" && pattern.test(text(node)));
const ids = f => f.props.rows.map(row => row.id);

test("groups only supplied reports and honestly distinguishes current, other, and unknown builds", async () => {
  const f = fixture(); f.mount(); await tick();
  const html = f.html();
  assert.match(html, /3 error groups from 4 reports in this list/);
  assert.match(html, /Current build/); assert.match(html, /Other build/); assert.match(html, /Build not recorded/);
  assert.match(html, /does not establish whether an error is fixed/);
  assert.doesNotMatch(html, /fixed in a later build|already fixed|Clear fixed/);
  assert.equal(f.requests.length, 0);
  assert.equal(nodes(f.render()).filter(node => node.type === "article").length, 3);
});

test("error details use a native button and an explicitly related expanded region", async () => {
  const f = fixture(); f.mount(); await tick();
  const toggle = nodes(f.render()).find(node => node.type === "button" && node.props["aria-expanded"] === false);
  assert.ok(toggle.props["aria-controls"]);
  assert.equal(nodes(f.render()).find(node => node.props?.id === toggle.props["aria-controls"]).props.hidden, true);
  toggle.props.onClick();
  assert.equal(nodes(f.render()).find(node => node.props?.["aria-controls"] === toggle.props["aria-controls"]).props["aria-expanded"], true);
  assert.match(f.html(), /Synthetic stack/); assert.match(f.html(), /Synthetic physician/);
});

test("canceling a deletion performs no mutation", async () => {
  const f = fixture(); f.confirmed = false; f.mount(); await tick();
  await button(f, /Delete other-build/).props.onClick();
  assert.equal(f.requests.length, 0); assert.equal(f.receipts.length, 0);
  assert.match(f.confirmations[0], /Permanently delete 2 error reports from other builds in this list/);
  assert.match(f.confirmations[0], /does not confirm that the cause is fixed/);
});

test("deferred deletion prevents duplicate clicks and removes only confirmed other-build reports", async () => {
  const f = fixture(), held = deferred(); f.deleteResponse = () => held.promise;
  f.mount(); await tick();
  const click = button(f, /Delete other-build/).props.onClick;
  const operation = click(); await click();
  assert.equal(f.requests.length, 1); assert.equal(f.confirmations.length, 1);
  assert.equal(f.receipts.length, 0); assert.equal(ids(f).length, 4);
  assert.equal(button(f, /Deleting/).props.disabled, true);
  assert.equal(button(f, /Delete other-build/).props.disabled, true);
  assert.deepEqual(f.requests[0], { table: "client_errors", column: "id", ids: ["other-1", "other-2"], columns: "id" });
  held.resolve({ data: [{ id: "other-1" }, { id: "other-2" }], error: null }); await operation;
  assert.deepEqual(f.receipts, [["other-1", "other-2"]]);
  assert.deepEqual(ids(f), ["current-1", "unknown-1"]);
  assert.match(f.html(), /Deleted 2 error reports/);
  assert.match(f.html(), /2 error groups from 2 reports/);
  assert.equal(button(f, /Delete listed/).props.disabled, false);
});

for (const failure of ["database", "rejection"]) test(`${failure} failure preserves reports, shows an alert, and releases busy state`, async () => {
  const f = fixture(), held = deferred(); f.deleteResponse = () => held.promise;
  f.mount(); await tick();
  const operation = button(f, /Delete listed/).props.onClick();
  if (failure === "database") held.resolve({ data: null, error: { message: "Synthetic denial" } });
  else held.reject(new Error("Synthetic network failure"));
  await operation;
  assert.equal(f.receipts.length, 0); assert.equal(ids(f).length, 4);
  assert.match(f.html(), /role="alert"/); assert.match(f.html(), /Could not confirm deletion/);
  assert.equal(button(f, /Delete listed/).props.disabled, false);
});

for (const data of [[], null]) test(`successful response with ${data === null ? "no receipt" : "zero affected rows"} cannot claim deletion`, async () => {
  const f = fixture(); f.deleteResponse = async () => ({ data, error: null });
  f.mount(); await tick(); await button(f, /Delete listed/).props.onClick();
  assert.equal(f.receipts.length, 0); assert.equal(ids(f).length, 4);
  assert.match(f.html(), /No deletions were confirmed/);
  assert.equal(button(f, /Delete listed/).props.disabled, false);
});

test("partial receipts preserve unconfirmed reports and ignore unrelated or duplicated returned IDs", async () => {
  const f = fixture();
  f.deleteResponse = async () => ({ data: [{ id: "other-1" }, { id: "other-1" }, { id: "current-1" }], error: null });
  f.mount(); await tick(); await button(f, /Delete other-build/).props.onClick();
  assert.deepEqual(f.receipts, [["other-1"]]);
  assert.deepEqual(ids(f), ["current-1", "other-2", "unknown-1"]);
  assert.match(f.html(), /Deleted 1 of 2 selected reports/); assert.match(f.html(), /role="alert"/);
});

test("a group deletion targets only that group's reports and retains its siblings", async () => {
  const f = fixture(); f.mount(); await tick();
  const groups = nodes(f.render()).filter(node => node.type === "button" && node.props["aria-expanded"] === false);
  groups[1].props.onClick();
  await button(f, /Delete group reports/).props.onClick();
  assert.deepEqual(f.requests[0].ids, ["other-1", "other-2"]);
  assert.deepEqual(ids(f), ["current-1", "unknown-1"]);
  assert.match(f.confirmations[0], /in this group/);
});

test("late deletion results after unmount do not clear another account's reports", async () => {
  const f = fixture(), held = deferred(); f.deleteResponse = () => held.promise;
  f.mount(); await tick(); const operation = button(f, /Delete listed/).props.onClick();
  f.unmount(); held.resolve({ data: f.props.rows.map(row => ({ id: row.id })), error: null }); await operation;
  assert.equal(f.receipts.length, 0); assert.equal(ids(f).length, 4);
});

test("unavailable build information does not guess which reports came from other builds", async () => {
  const f = fixture(); f.buildResponse = async () => ({ ok: false });
  f.mount(); await tick();
  assert.match(f.html(), /Current build unavailable/);
  assert.equal(button(f, /Delete other-build/), undefined);
  assert.ok(button(f, /Delete listed/));
});
