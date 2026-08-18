/**
 * build-backup: the complete monthly archive, built on the server.
 *
 * A user with 60 MB of scans cannot be emailed an attachment, so this function
 * writes a ZIP into the private "backups" bucket and emails a signed link that
 * lives 35 days. One email per user, however many parts the archive needs.
 *
 * Auth, either one:
 *   - header x-hook-secret = WELCOME_HOOK_SECRET. Body {} runs every opted-in
 *     active profile, { profile_id } runs one. In production the cron job calls
 *     it once per profile (see migrations/20260817_backups.sql), because a
 *     single invocation cannot build every account inside the wall clock.
 *   - a Clerk JWT (clerkProfile). That caller gets their own account and
 *     nothing else; an admin may pass profile_id to build someone else's.
 *
 * Per user: every table in SECTIONS plus the profiles row (api_key and
 * anthropic_api_key stripped), plus every file in the documents bucket that
 * lives inside the user's own storage folder.
 *
 * ZIP: README.html, data/backup.json, data/<table>.csv per non-empty section,
 * documents/<record label> - <original name>, documents/index.csv. Documents go
 * in with STORE (scans are already compressed), text with DEFLATE. Parts are
 * capped at 120 MB of source bytes and each part gets its own backups row.
 *
 * Never in the archive: the on-device private vault (patient identifiers never
 * reach the server) and the AI keys. The README and the email both say so.
 *
 * Deploy with --no-verify-jwt: the gateway cannot check Clerk RS256 tokens.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import {
  BACKUP_BUCKET,
  DOCUMENTS_BUCKET,
  LINK_TTL_SECONDS,
  PART_CAP_BYTES,
  SECTIONS,
  backupStoragePath,
  backupSubject,
  countRecords,
  dataEntries,
  documentIndexCsv,
  firstName,
  formatBytes,
  monthLabel,
  periodFor,
  planDocumentParts,
  prepareDocuments,
  renderEmailText,
  renderReadme,
  buildRecordIndex,
  type DocInput,
  type EmailLink,
  type PreparedDoc,
  type Row,
  type SkippedDoc,
} from "./lib.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_API = (Deno.env.get("RESEND_API_BASE") ?? "https://api.resend.com").replace(/\/$/, "");
const HOOK = Deno.env.get("WELCOME_HOOK_SECRET") ?? "";
const FROM = "CredentialDOMD <whit@credentialdomd.com>";
const REPLY_TO = "stormchaser@elryx.com";

// Memory guard. JSZip holds the sources and the output at the same time, so the
// peak is roughly twice this. Lower it with the env var if a build ever runs the
// isolate out of memory; the only cost is more parts.
const PART_CAP = Math.max(1, Number(Deno.env.get("BACKUP_PART_MAX_BYTES")) || PART_CAP_BYTES);

// A run started by a signed-in user is capped: a rebuild is expensive and what
// people usually want is a fresh link, which backup-link hands out for free.
const ON_DEMAND_PER_DAY = 3;

// Budget for the body-{} sweep, so a manual "run everyone" returns instead of
// being killed mid-user. The cron does not use this path.
const SWEEP_BUDGET_MS = 100_000;

const PAGE = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']{2,}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface ProfileRow extends Row {
  id: string;
  auth_user_id: string | null;
  name: string | null;
  email: string | null;
}

/**
 * PostgREST caps a response at 1,000 rows; a career case log is far past that.
 *
 * A read error throws rather than returning what it got. This archive is sold
 * as complete, so an incomplete one that says "complete" on the tin is worse
 * than a build that fails loudly and leaves an error on the backups row.
 */
async function readAll(db: SupabaseClient, table: string, userId: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db.from(table).select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      // created_at ties are common (a bulk import stamps one timestamp for
      // the whole batch), and OFFSET paging over a non-unique sort can
      // repeat or drop rows across page boundaries.
      .order("id", { ascending: true })
      .range(start, start + PAGE - 1);
    if (error) throw new Error(`could not read ${table}: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * Real object sizes from storage metadata. documents.size_bytes is only as good
 * as the client that wrote it, and the part split has to be right or the isolate
 * runs out of memory.
 */
async function storageSizes(db: SupabaseClient, authUserId: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!authUserId) return sizes;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db.storage.from(DOCUMENTS_BUCKET)
      .list(authUserId, { limit: PAGE, offset });
    if (error) { console.error(`backup: storage list failed: ${error.message}`); return sizes; }
    for (const o of data ?? []) {
      const size = Number((o as { metadata?: { size?: number } }).metadata?.size ?? NaN);
      if (Number.isFinite(size)) sizes.set(`${authUserId}/${o.name}`, size);
    }
    if (!data || data.length < PAGE) return sizes;
  }
}

async function sendEmail(payload: Record<string, unknown>): Promise<string | null> {
  const r = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) { console.error("backup: resend failed", r.status, text.slice(0, 300)); return null; }
  try { return (JSON.parse(text) as { id?: string }).id ?? null; } catch { return null; }
}

interface PartResult {
  rowId: string | null;
  part: number;
  parts: number;
  bytes: number;
  documentCount: number;
  skipped: number;
  url: string | null;
  path: string;
  error?: string;
}

interface UserResult {
  profile_id: string;
  period: string;
  parts: number;
  record_count: number;
  document_count: number;
  skipped_documents: number;
  emailed: boolean;
  note?: string;
  results: PartResult[];
}

async function buildForProfile(db: SupabaseClient, profile: ProfileRow): Promise<UserResult> {
  const userId = profile.id;
  const authUserId = String(profile.auth_user_id ?? "");
  const generatedAt = new Date().toISOString();
  const period = periodFor(new Date(generatedAt));

  // 1. Every table the app syncs.
  const dataByTable: Record<string, Row[]> = {};
  for (const s of SECTIONS) dataByTable[s.table] = await readAll(db, s.table, userId);
  const recordCount = countRecords(dataByTable);
  const sectionCounts = SECTIONS.map((s) => ({ label: s.label, table: s.table, count: dataByTable[s.table].length }));
  const nonEmptySections = sectionCounts.filter((s) => s.count > 0).length;

  // 2. The files behind the documents rows.
  const sizeByPath = await storageSizes(db, authUserId);
  const recordIndex = buildRecordIndex(dataByTable);
  const prepared = prepareDocuments(
    (dataByTable["documents"] ?? []) as unknown as DocInput[],
    authUserId,
    recordIndex,
    sizeByPath,
  );
  const planned = planDocumentParts(prepared.items, PART_CAP);
  const parts = planned.length;
  const totalDocumentCount = prepared.items.length;

  const results: PartResult[] = [];
  const links: EmailLink[] = [];
  // Planning-level skips (a storage_path outside the user's own folder) are
  // reported in part 1; download failures are reported in the part they happen
  // in. Nothing is ever dropped without a name in a README and a count on a row.
  const allSkipped: SkippedDoc[] = [...prepared.skipped];
  let includedDocuments = 0;
  let includedBytes = 0;

  // One id per build run: it namespaces this run's objects and makes an
  // interrupted run visible instead of leaving nothing behind.
  const runId = crypto.randomUUID().slice(0, 8);
  for (let i = 0; i < parts; i++) {
    const partNo = i + 1;
    const path = backupStoragePath(authUserId || userId, period, partNo, parts, runId);
    const failures: SkippedDoc[] = [];
    const partSkipped = () => (i === 0 ? [...prepared.skipped, ...failures] : failures);
    // Claim the row before the memory-heavy work: if the isolate is killed
    // mid-build, the user sees "Building" rather than a silent gap.
    const { data: pendingRow } = await db.from("backups").insert({
      user_id: userId, period, storage_path: path, part: partNo, parts, status: "pending",
    }).select("id").single();
    const pendingId = (pendingRow as { id: string } | null)?.id ?? null;
    try {
      const zip = new JSZip();

      if (i === 0) {
        for (const e of dataEntries(profile, dataByTable, { period, generatedAt, part: partNo, parts })) {
          zip.file(e.path, e.text);
        }
      }

      const included: PreparedDoc[] = [];
      let sourceBytes = 0;
      for (const doc of planned[i]) {
        const dl = await db.storage.from(DOCUMENTS_BUCKET).download(doc.path);
        if (dl.error || !dl.data) {
          console.error(`backup: download failed ${doc.path}: ${dl.error?.message ?? "no data"}`);
          failures.push({ name: doc.originalName, reason: "the file could not be read from storage" });
          continue;
        }
        const bytes = new Uint8Array(await dl.data.arrayBuffer());
        if (bytes.byteLength === 0) {
          failures.push({ name: doc.originalName, reason: "the stored file is empty" });
          continue;
        }
        const stamp = doc.uploadedAt ? new Date(doc.uploadedAt) : null;
        // STORE: a PDF or a JPEG is already compressed, and DEFLATE over it
        // costs CPU we do not have for nothing.
        zip.file(`documents/${doc.fileName}`, bytes, {
          compression: "STORE",
          date: stamp && !isNaN(stamp.getTime()) ? stamp : undefined,
        });
        included.push(doc);
        sourceBytes += bytes.byteLength;
      }

      zip.file("documents/index.csv", documentIndexCsv(included));
      zip.file("README.html", renderReadme({
        period,
        generatedAt,
        part: partNo,
        parts,
        physicianName: String(profile.name || profile.email || "Your account"),
        recordCount,
        sectionCounts,
        documentCount: included.length,
        totalDocumentCount,
        documentBytes: sourceBytes,
        skipped: partSkipped(),
        hasData: i === 0,
      }));

      const zipped = (await zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      })) as Uint8Array;

      const up = await db.storage.from(BACKUP_BUCKET)
        .upload(path, zipped, { contentType: "application/zip", upsert: true });
      if (up.error) throw new Error(`upload failed: ${up.error.message}`);

      const signed = await db.storage.from(BACKUP_BUCKET).createSignedUrl(path, LINK_TTL_SECONDS);
      if (signed.error || !signed.data?.signedUrl) {
        throw new Error(`signed url failed: ${signed.error?.message ?? "no url"}`);
      }

      const expiresAt = new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString();
      const rowFields = {
        user_id: userId,
        period,
        storage_path: path,
        part: partNo,
        parts,
        bytes: zipped.byteLength,
        record_count: recordCount,
        document_count: included.length,
        skipped_documents: partSkipped().length,
        status: "ready",
        expires_at: expiresAt,
      };
      const written = pendingId
        ? await db.from("backups").update(rowFields).eq("id", pendingId).select("id").single()
        : await db.from("backups").insert(rowFields).select("id").single();
      const rowIns = written.data;
      if (written.error) throw new Error(`backups insert failed: ${written.error.message}`);

      includedDocuments += included.length;
      includedBytes += sourceBytes;
      allSkipped.push(...failures);
      results.push({
        rowId: rowIns?.id ?? null, part: partNo, parts, bytes: zipped.byteLength,
        documentCount: included.length, skipped: partSkipped().length, url: signed.data.signedUrl, path,
      });
      links.push({ part: partNo, parts, url: signed.data.signedUrl, bytes: zipped.byteLength });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`backup: part ${partNo} of ${parts} failed for ${userId}: ${message}`);
      allSkipped.push(...failures);
      const failFields = {
        user_id: userId, period, storage_path: path, part: partNo, parts,
        record_count: recordCount, document_count: 0, skipped_documents: partSkipped().length,
        status: "failed", error: message.slice(0, 500),
      };
      if (pendingId) await db.from("backups").update(failFields).eq("id", pendingId);
      else await db.from("backups").insert(failFields);
      results.push({ rowId: null, part: partNo, parts, bytes: 0, documentCount: 0, skipped: partSkipped().length, url: null, path, error: message });
    }
  }

  const skippedTotal = allSkipped.length;
  const out: UserResult = {
    profile_id: userId, period, parts, record_count: recordCount,
    document_count: includedDocuments, skipped_documents: skippedTotal,
    emailed: false, results,
  };

  const rowIds = results.map((r) => r.rowId).filter((id): id is string => !!id);
  if (!links.length) { out.note = "no part could be built"; return out; }

  const email = String(profile.email ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    // Contract: never email an empty address. The archive stays ready and the
    // reason is on the row, so the app can still hand out a link.
    out.note = "built but not emailed: no email address on the profile";
    await db.from("backups").update({ error: out.note }).in("id", rowIds);
    return out;
  }
  if (!RESEND_API_KEY) {
    out.note = "built but not emailed: RESEND_API_KEY is not set";
    await db.from("backups").update({ error: out.note }).in("id", rowIds);
    return out;
  }

  const text = renderEmailText({
    greetingName: firstName(profile.name, email),
    period,
    recordCount,
    sectionCount: nonEmptySections,
    documentCount: includedDocuments,
    documentBytes: includedBytes,
    links,
    expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString(),
    skippedCount: skippedTotal,
    missingParts: parts - links.length,
  });

  const emailId = await sendEmail({
    from: FROM,
    to: [email],
    reply_to: REPLY_TO,
    subject: backupSubject(period),
    text,
  });
  if (!emailId) {
    out.note = "built but the email failed to send";
    await db.from("backups").update({ error: out.note }).in("id", rowIds);
    return out;
  }

  await db.from("backups").update({ status: "emailed", emailed_at: new Date().toISOString() }).in("id", rowIds);
  out.emailed = true;
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* {} is a valid body */ }
  const askedFor = body?.profile_id == null || body.profile_id === "" ? null : String(body.profile_id);
  if (askedFor && !UUID_RE.test(askedFor)) return json(400, { error: "profile_id is not a valid id" });

  const hookOk = !!HOOK && req.headers.get("x-hook-secret") === HOOK;

  let db: SupabaseClient;
  let targetIds: string[] | null = null;   // null = every opted-in active profile
  let onDemand = false;

  if (hookOk) {
    db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    targetIds = askedFor ? [askedFor] : null;
  } else {
    const who = await clerkProfile(req);
    if (!who) return json(401, { error: "Not signed in" });
    db = who.db;
    onDemand = true;
    if (askedFor && askedFor !== who.profileId) {
      if (!who.isAdmin) return json(403, { error: "You can only back up your own account" });
      targetIds = [askedFor];
    } else {
      targetIds = [who.profileId];
    }
  }

  // A signed-in user asking for a rebuild is capped; a fresh link is free from
  // backup-link and is what the request almost always means.
  if (onDemand && targetIds && targetIds.length === 1) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await db.from("backups")
      .select("id", { count: "exact", head: true })
      .eq("user_id", targetIds[0]).eq("part", 1).gte("created_at", since);
    if ((count ?? 0) >= ON_DEMAND_PER_DAY) {
      return json(429, {
        error: `You have built ${ON_DEMAND_PER_DAY} backups today. Use the link on an existing backup, or try again tomorrow.`,
      });
    }
  }

  let q = db.from("profiles").select("*");
  if (targetIds) q = q.in("id", targetIds);
  else q = q.eq("backup_monthly", true).eq("access_status", "active");
  const { data: profiles, error: pErr } = await q;
  if (pErr) return json(500, { error: pErr.message });
  if (!profiles?.length) return json(404, { error: "No matching profile" });

  const started = Date.now();
  const results: UserResult[] = [];
  const deferred: string[] = [];
  for (const p of profiles as ProfileRow[]) {
    if (!targetIds && Date.now() - started > SWEEP_BUDGET_MS) { deferred.push(p.id); continue; }
    try {
      results.push(await buildForProfile(db, p));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`backup: profile ${p.id} failed: ${message}`);
      await db.from("backups").insert({
        user_id: p.id, period: periodFor(new Date()), parts: 1, part: 1,
        status: "failed", error: message.slice(0, 500),
      });
      results.push({
        profile_id: p.id, period: periodFor(new Date()), parts: 0, record_count: 0,
        document_count: 0, skipped_documents: 0, emailed: false, note: message, results: [],
      });
    }
  }

  return json(200, {
    ok: true,
    profiles: profiles.length,
    built: results.length,
    deferred: deferred.length ? deferred : undefined,
    month: monthLabel(periodFor(new Date())),
    cap: formatBytes(PART_CAP),
    results,
  });
});
