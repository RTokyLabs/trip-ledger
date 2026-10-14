// Sync between this device's local storage and Supabase.
//
// Rules:
// - The app always works from local storage; sync never blocks using the app.
// - Each record carries `updatedAt` (set when edited). When the same record was changed
//   on two devices, the most recent edit wins (last-writer-wins), on the server too
//   (see the trigger in supabase/setup.sql).
// - Deletions are tombstones (`deleted: true`) so they reach the other devices.
// - Receipt files go to the private "receipts" storage bucket at <user id>/<file id>.

import * as store from "./db.js";
import { CONFIG } from "./config.js";

const PAGE = 1000;
const OVERLAP_MS = 60_000; // re-read the last minute on each pull; merging is idempotent
let client = null;
let running = null;
let timer = null;
let listeners = [];
let status = { state: "idle", pending: 0, lastSyncAt: null, message: "" };

/* ---------- Configuration & auth ---------- */
export function getConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("trip-ledger-config") || "{}"); } catch {}
  return {
    supabaseUrl: (CONFIG.supabaseUrl || saved.supabaseUrl || "").trim().replace(/\/+$/, ""),
    supabaseKey: (CONFIG.supabaseKey || saved.supabaseKey || "").trim(),
    fromFile: !!(CONFIG.supabaseUrl && CONFIG.supabaseKey)
  };
}
export function saveConfig(url, key) {
  try { localStorage.setItem("trip-ledger-config", JSON.stringify({ supabaseUrl: url.trim(), supabaseKey: key.trim() })); } catch {}
  client = null;
}
export function isConfigured() {
  const c = getConfig();
  return !!(c.supabaseUrl && c.supabaseKey && window.supabase);
}
function getClient() {
  if (!client && isConfigured()) {
    const c = getConfig();
    client = window.supabase.createClient(c.supabaseUrl, c.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "trip-ledger-auth" }
    });
  }
  return client;
}
/** Signed-in account as remembered on this device (works offline). */
export async function account() {
  return store.getMeta("account", null);
}
export async function signIn(email, password) {
  const c = getClient();
  if (!c) throw new Error("Add your Supabase details first.");
  const { data, error } = await c.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(error.message === "Invalid login credentials" ? "Email or password is wrong." : error.message);
  const prev = await account();
  if (prev && prev.id !== data.user.id) await store.setMeta("pullCursor", null);
  await store.setMeta("account", { id: data.user.id, email: data.user.email });
  schedule(0);
  return data.user;
}
export async function signOut() {
  const c = getClient();
  if (c) { try { await c.auth.signOut({ scope: "local" }); } catch {} }
  await store.setMeta("account", null);
  await refreshStatus({ state: "signedOut" });
}

/* ---------- Status ---------- */
export function onStatus(fn) { listeners.push(fn); fn(status); }
function emit(patch) { status = { ...status, ...patch }; listeners.forEach(f => f(status)); }
export async function pendingCount() {
  const [t, e] = await Promise.all([store.getByIndex("trips", "dirty", 1), store.getByIndex("expenses", "dirty", 1)]);
  const files = await unuploadedReferencedFiles();
  return t.length + e.length + files.length;
}
export async function refreshStatus(patch = {}) {
  const acct = await account();
  const lastSyncAt = await store.getMeta("lastSyncAt", null);
  let state = patch.state || status.state;
  if (!isConfigured()) state = "notConfigured";
  else if (!acct) state = "signedOut";
  else if (!navigator.onLine) state = "offline";
  else if (state === "notConfigured" || state === "signedOut" || state === "offline") state = "idle";
  emit({ ...patch, state, pending: await pendingCount(), lastSyncAt });
}

/** Ask for a sync soon (debounced). Called after every local change. */
export function schedule(delay = 2500) {
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
  refreshStatus().catch(() => {});
}

/* ---------- Row mapping (local camelCase <-> database snake_case) ---------- */
export function tripToRow(t, uid) {
  return { id: t.id, user_id: uid, name: t.name, destination: t.destination || "", purpose: t.purpose || "",
    start_date: t.startDate, end_date: t.endDate, base_currency: t.baseCurrency, base_exp: t.baseExp,
    created_at: t.createdAt, updated_at: t.updatedAt, deleted: !!t.deleted };
}
export function rowToTrip(r) {
  return { id: r.id, name: r.name, destination: r.destination, purpose: r.purpose, startDate: r.start_date,
    endDate: r.end_date, baseCurrency: r.base_currency, baseExp: r.base_exp, createdAt: r.created_at,
    updatedAt: r.updated_at, deleted: r.deleted, dirty: 0 };
}
export function expenseToRow(x, uid) {
  return { id: x.id, user_id: uid, trip_id: x.tripId, date: x.date, category: x.category, description: x.description,
    merchant: x.merchant || "", payment: x.payment, reimbursable: !!x.reimbursable, receipt: !!x.receipt,
    notes: x.notes || "", currency: x.currency, exp: x.exp, amount_minor: String(x.amountMinor), rate: x.rate,
    base_currency: x.baseCurrency, base_exp: x.baseExp, base_minor: String(x.baseMinor),
    receipts: x.receipts || [], created_at: x.createdAt, updated_at: x.updatedAt, deleted: !!x.deleted };
}
export function rowToExpense(r) {
  return { id: r.id, tripId: r.trip_id, date: r.date, category: r.category, description: r.description,
    merchant: r.merchant, payment: r.payment, reimbursable: r.reimbursable, receipt: r.receipt, notes: r.notes,
    currency: r.currency.trim(), exp: r.exp, amountMinor: String(r.amount_minor), rate: String(r.rate),
    baseCurrency: r.base_currency.trim(), baseExp: r.base_exp, baseMinor: String(r.base_minor),
    receipts: r.receipts || [], createdAt: r.created_at, updatedAt: r.updated_at, deleted: r.deleted, dirty: 0 };
}

/** Merge rule for one incoming server record. Returns the record to keep, or null to keep local as is. */
export function mergeRecord(local, remote) {
  if (!local) return remote;
  const lt = Date.parse(local.updatedAt), rt = Date.parse(remote.updatedAt);
  if (!local.dirty) return rt >= lt || isNaN(lt) ? remote : null;
  if (rt > lt) return remote;            // edited more recently elsewhere: that edit wins
  if (rt === lt) return remote;          // same version as ours: our upload landed, mark clean
  return null;                           // our unsent edit is newer: keep it, it will be pushed
}

/* ---------- Files ---------- */
async function referencedFileIds() {
  const xs = await store.getAll("expenses");
  const ids = new Set();
  for (const x of xs) if (!x.deleted) for (const r of x.receipts || []) ids.add(r.id);
  return ids;
}
async function unuploadedReferencedFiles() {
  const [files, refs] = await Promise.all([store.getByIndex("files", "uploaded", 0), referencedFileIds()]);
  return files.filter(f => refs.has(f.id));
}
/** Queue receipt files for deletion everywhere and remove them from this device now. */
export async function deleteFiles(ids) {
  if (!ids.length) return;
  const q = await store.getMeta("fileDeletes", []);
  await store.setMeta("fileDeletes", [...new Set([...q, ...ids])]);
  for (const id of ids) await store.del("files", id);
}
/** Download one receipt file to this device (used when viewing one not yet here). */
export async function fetchFile(id, type) {
  const c = getClient(); const acct = await account();
  if (!c || !acct || !navigator.onLine) return null;
  const { data, error } = await c.storage.from("receipts").download(`${acct.id}/${id}`);
  if (error || !data) return null;
  const rec = { id, blob: data, type: type || data.type, uploaded: 1 };
  await store.put("files", rec);
  return rec;
}

/* ---------- The sync run ---------- */
export function syncNow() {
  if (running) return running;
  running = run().finally(() => { running = null; });
  return running;
}

async function run() {
  if (!isConfigured()) return refreshStatus({ state: "notConfigured" });
  const acct = await account();
  if (!acct) return refreshStatus({ state: "signedOut" });
  if (!navigator.onLine) return refreshStatus({ state: "offline" });
  const c = getClient();
  const { data: sess } = await c.auth.getSession();
  if (!sess?.session) { await store.setMeta("account", null); return refreshStatus({ state: "signedOut", message: "Your sign-in expired. Sign in again to sync." }); }
  const uid = sess.session.user.id;
  emit({ state: "syncing", message: "" });
  let changed = false;
  try {
    // 1. Upload receipt files (before the expenses that point at them).
    for (const f of await unuploadedReferencedFiles()) {
      const { error } = await c.storage.from("receipts").upload(`${uid}/${f.id}`, f.blob, { contentType: f.type, upsert: true });
      if (error) throw new Error("Receipt upload failed: " + error.message);
      const cur = await store.get("files", f.id);
      if (cur) await store.put("files", { ...cur, uploaded: 1 });
    }
    // 2. Push changed records: trips first, because expenses reference them.
    await pushStore(c, uid, "trips", tripToRow);
    await pushStore(c, uid, "expenses", expenseToRow);
    // 3. Remove deleted receipt files from the server.
    const q = await store.getMeta("fileDeletes", []);
    if (q.length) {
      const { error } = await c.storage.from("receipts").remove(q.map(id => `${uid}/${id}`));
      if (!error) {
        const now = await store.getMeta("fileDeletes", []);
        await store.setMeta("fileDeletes", now.filter(id => !q.includes(id)));
      }
    }
    // 4. Pull changes made on other devices.
    const cursor = await store.getMeta("pullCursor", null);
    const since = cursor ? new Date(Date.parse(cursor) - OVERLAP_MS).toISOString() : null;
    let maxSeen = cursor;
    for (const [table, mapper] of [["trips", rowToTrip], ["expenses", rowToExpense]]) {
      for (let from = 0; ; from += PAGE) {
        let qb = c.from(table).select("*").order("synced_at", { ascending: true }).range(from, from + PAGE - 1);
        if (since) qb = qb.gt("synced_at", since);
        const { data, error } = await qb;
        if (error) throw new Error("Download failed: " + error.message);
        for (const row of data) {
          const remote = mapper(row);
          const local = await store.get(table, remote.id);
          const keep = mergeRecord(local, remote);
          if (keep && (!local || JSON.stringify(local) !== JSON.stringify(keep))) { await store.put(table, keep); changed = true; }
          if (!maxSeen || Date.parse(row.synced_at) > Date.parse(maxSeen)) maxSeen = row.synced_at;
        }
        if (data.length < PAGE) break;
      }
    }
    if (maxSeen) await store.setMeta("pullCursor", maxSeen);
    // 5. Bring receipt files from other devices onto this one, so they open offline.
    const refs = await referencedFileIds();
    const xs = await store.getAll("expenses");
    const types = new Map(xs.flatMap(x => (x.receipts || []).map(r => [r.id, r.type])));
    for (const id of refs) {
      if (!(await store.get("files", id))) { if (await fetchFile(id, types.get(id))) changed = true; }
    }
    await store.setMeta("lastSyncAt", new Date().toISOString());
    await refreshStatus({ state: "idle", message: "" });
  } catch (e) {
    const offline = !navigator.onLine || /fetch|network/i.test(String(e?.message));
    await refreshStatus({ state: offline ? "offline" : "error", message: offline ? "" : String(e?.message || e) });
  }
  if (changed) window.dispatchEvent(new CustomEvent("ledger:remote-change"));
}

async function pushStore(c, uid, table, toRow) {
  const dirty = await store.getByIndex(table, "dirty", 1);
  for (let i = 0; i < dirty.length; i += 200) {
    const batch = dirty.slice(i, i + 200);
    const { error } = await c.from(table).upsert(batch.map(r => toRow(r, uid)), { onConflict: "id", ignoreDuplicates: false, defaultToNull: false });
    if (error) throw new Error(`Upload of ${table} failed: ${error.message}`);
    for (const r of batch) {
      const cur = await store.get(table, r.id);
      if (cur && cur.updatedAt === r.updatedAt) await store.put(table, { ...cur, dirty: 0 });
    }
  }
}

/* ---------- Background triggers ---------- */
export function start() {
  window.addEventListener("online", () => schedule(500));
  window.addEventListener("offline", () => refreshStatus());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(500); });
  setInterval(() => { if (document.visibilityState === "visible") schedule(0); }, 5 * 60_000);
  schedule(300);
}
