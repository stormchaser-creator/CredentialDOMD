// A compressed image is not bounded by the bytes it arrived in.
//
// The reviewer's measurement against this handler, 2026-09-18: a VALID
// 1000x1000 one-bit PNG deflates to 202 bytes, making a 432-byte request. The
// handler reserved $0.001375 from those bytes and the call metered $0.006505
// for its documented 1,296 image tokens, so a month standing at $14.998 ended
// at $15.004505, past a cap described as hard. Refusing url and file sources
// (the previous repair) does nothing here: the compressible bytes are the
// base64 the app itself sends.
//
// The bound was the wrong KIND of bound. Bytes bound text, because a token of
// text is at least two of them. An image costs by pixel dimensions, and the
// map from pixels to bytes is a compressor the CALLER picks. A bound the
// caller can widen for free is not a bound. So a request carrying media is
// measured by the provider's own count_tokens before it is admitted, and that
// is a number the caller cannot move without moving the content it describes.
//
// The harness is the reviewer's: the real index.ts is bundled with esbuild and
// driven through a synthetic Deno, auth, database and provider. No real key,
// no network, no customer data. The fixture PNG is built here and checked by
// inflating it, so it is a real image rather than a blob that happens to be
// small. Token counts are controlled fixtures.
//
// Run: node scripts/ai-spend-media.test.mjs
import fs from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const file = path.join(root, "supabase/functions/ai-proxy/index.ts");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} ${extra}`); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);

let state;
const reset = (usage = { input_tokens: 1, output_tokens: 1 }) => {
  state = { providerCalls: [], countCalls: [], rpcs: [], holds: new Map(), logs: [], usage, spent: 0, countAnswer: null, countStatus: 200 };
};
reset();

const db = {
  from() {
    return {
      select() { return this; }, eq() { return this; },
      gte: async () => ({ data: [...state.holds.values()].map((amount_usd) => ({ amount_usd })) }),
      in: async () => ({ data: [{ name: "gemini_shared_key", value: "SYNTHETIC" }, { name: "anthropic_shared_key", value: "SYNTHETIC" }] }),
      maybeSingle: async () => ({ data: { access_status: "active" } }),
      insert: async (row) => { state.logs.push(row); return { data: row, error: null }; },
    };
  },
  async rpc(name, args) {
    state.rpcs.push({ name, args });
    if (name === "credentialdo_service_write_snapshot") return { data: { enforcementEnabled: false, credential: true, practice: true } };
    if (name === "reserve_ai_call") return { data: "10000000-0000-4000-8000-000000000001" };
    if (name === "reserve_ai_spend") {
      const spent = state.spent + [...state.holds.values()].reduce((a, b) => a + b, 0);
      if (spent + args.p_worst_case_usd > args.p_cap_usd) return { data: { outcome: "over", spent_usd: spent } };
      const hold = "10000000-0000-4000-8000-" + String(state.holds.size + 1).padStart(12, "0");
      state.holds.set(hold, args.p_worst_case_usd);
      return { data: { outcome: "held", hold } };
    }
    if (name === "settle_ai_spend") {
      if (args.p_actual_usd != null) state.holds.set(args.p_hold, args.p_actual_usd);
      return { data: { outcome: "settled" } };
    }
    throw new Error("unexpected RPC " + name);
  },
};
globalThis.__identity = { profileId: "10000000-0000-4000-8000-000000000001", clerkSubject: "user_synthetic", isAdmin: false, db };
globalThis.Deno = { env: { get: () => undefined } };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/count_tokens")) {
    state.countCalls.push(JSON.parse(init.body));
    if (state.countStatus !== 200) return new Response("{}", { status: state.countStatus, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(state.countAnswer), { headers: { "content-type": "application/json" } });
  }
  state.providerCalls.push({ body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ model: "claude-opus-5", usage: state.usage, content: [{ type: "text", text: "synthetic" }] }),
    { headers: { "content-type": "application/json" } });
};

const built = await build({
  stdin: { contents: fs.readFileSync(file, "utf8"), resolveDir: path.dirname(file), sourcefile: "index.ts", loader: "ts" },
  bundle: true, write: false, format: "cjs", platform: "node", target: "node22", logLevel: "silent",
  plugins: [{
    name: "synthetic-io",
    setup(b) {
      b.onResolve({ filter: /^https:.*\/server\.ts$/ }, () => ({ path: "serve", namespace: "review" }));
      b.onResolve({ filter: /clerkAuth\.ts$/ }, () => ({ path: "auth", namespace: "review" }));
      b.onLoad({ filter: /.*/, namespace: "review" }, (a) => ({
        loader: "js",
        contents: a.path === "serve" ? "export const serve=fn=>{globalThis.__handler=fn;};"
                                     : "export const clerkProfile=async()=>globalThis.__identity;",
      }));
    },
  }],
});
new Function("module", "exports", built.outputFiles[0].text)({ exports: {} }, {});
const handler = globalThis.__handler;

// The reviewer's fixture, rebuilt here: a real 1000x1000 one-bit PNG.
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
const chunk = (name, data) => {
  const type = Buffer.from(name), size = Buffer.alloc(4), sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); sum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, sum]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1000, 0); ihdr.writeUInt32BE(1000, 4); ihdr[8] = 1; ihdr[9] = 0;
const rawPixels = Buffer.alloc((Math.ceil(1000 / 8) + 1) * 1000);
const deflated = deflateSync(rawPixels, { level: 9 });
if (inflateSync(deflated).length !== rawPixels.length) throw new Error("the fixture is not a valid PNG");
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflated), chunk("IEND", Buffer.alloc(0))]);

const base = { model: "claude-opus-5", max_tokens: 1 };
const imageBody = { ...base, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] }] };
const textBody = { ...base, messages: [{ role: "user", content: "synthetic" }] };

const run = async (body, opts = {}) => {
  reset(opts.usage || { input_tokens: 1296, output_tokens: 1 });
  Object.assign(state, opts.state || {});
  const res = await handler(new Request("https://synthetic.invalid/ai-proxy/v1/messages", { method: "POST", body: JSON.stringify(body) }));
  const held = state.rpcs.find((r) => r.name === "reserve_ai_spend")?.args.p_worst_case_usd;
  return { status: res.status, json: await res.clone().json().catch(() => null), held,
           providerCalls: state.providerCalls.length, countCalls: state.countCalls.length,
           retained: [...state.holds.values()].reduce((a, b) => a + b, 0) };
};

console.log("== The reviewer's fixture ==");
console.log(`   PNG ${png.length} bytes, request ${Buffer.byteLength(JSON.stringify(imageBody))} bytes, 1000x1000 at 1 bit`);
ok("the fixture reproduces the reviewer's size", png.length < 300 && Buffer.byteLength(JSON.stringify(imageBody)) < 600);

console.log("\n== A media request is measured before it is admitted ==");
{
  const r = await run(imageBody, { state: { countAnswer: { input_tokens: 1296 }, spent: 0 } });
  eq("the provider is asked to count it", r.countCalls, 1);
  // 1296 * 1.1 = 1426 tokens; at Opus cache-write 6.25/M that is 0.0089125,
  // plus one output token at 25/M. The point is not the exact cent: it is that
  // the reservation now exceeds what the call actually meters ($0.006505)
  // instead of sitting at a seventh of it.
  ok("and reserves MORE than the call goes on to meter", r.held > 0.006505, `held ${r.held}`);
  ok("which is the opposite of the measured defect", r.held > 0.001375 * 5, `held ${r.held}`);
  eq("the call still goes through when there is room", r.status, 200);
}
{
  // The measured scenario, end to end: the month at $14.998.
  const r = await run(imageBody, { state: { countAnswer: { input_tokens: 1296 }, spent: 14.998 } });
  eq("at $14.998 the same request is REFUSED", r.status, 429);
  eq("on the budget, not on an accounting failure", r.json?.error, "budget");
  eq("and never reaches the provider", r.providerCalls, 0);
  eq("so the month cannot pass $15", 14.998 + r.retained <= 15, true);
}
{
  // Before the repair this was the whole bug: admitted, and settled past $15.
  const r = await run(imageBody, { state: { countAnswer: { input_tokens: 1296 }, spent: 14.9 } });
  ok("a request that does fit is still admitted", r.status === 200, `status ${r.status}`);
  ok("and the month lands under the cap", 14.9 + r.retained <= 15, `retained ${r.retained}`);
}

console.log("\n== A count that does not answer sends nothing ==");
for (const [why, st] of [["a 500 from the counter", { countStatus: 500 }], ["an answer with no count in it", { countAnswer: { } }], ["a nonsense count", { countAnswer: { input_tokens: "lots" } }]]) {
  const r = await run(imageBody, { state: { ...st, spent: 0 } });
  eq(`${why}: refused`, r.status, 429);
  eq(`${why}: with the retryable code`, r.json?.error, "ai_token_count_unavailable");
  eq(`${why}: nothing sent to the provider`, r.providerCalls, 0);
  eq(`${why}: nothing held`, r.retained, 0);
}

console.log("\n== Text is counted on the same path ==");
{
  const r = await run(textBody, { state: { countAnswer: { input_tokens: 1 }, spent: 0 }, usage: { input_tokens: 1, output_tokens: 1 } });
  // Text is counted too now. The byte bound it used to take assumed a token is
  // at least two bytes of JSON, which nothing establishes; the reviewer
  // declined to accept it as the basis for a cap and was right to.
  eq("a text-only request is counted as well", r.countCalls, 1);
  eq("it is forwarded", r.status, 200);
  ok("and reserved from that count", r.held > 0, `held ${r.held}`);
}
{
  const r = await run({ ...base, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.invalid/a.png" } }] }] });
  eq("a URL source is still refused outright", r.status, 400);
  eq("with no count call and no provider call", [r.countCalls, r.providerCalls], [0, 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
