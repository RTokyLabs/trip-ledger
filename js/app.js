// Trip Expense Ledger — user interface.
// All reads and writes go to local storage (db.js); sync.js handles the server.

import { CURRENCIES, COMMON, CUR, parseAmount, parseRate, convert, fmt, money, unitText } from "./money.js";
import * as store from "./db.js";
import * as sync from "./sync.js";

const CATEGORIES = ["Flights","Accommodation","Ground transport","Meals","Client entertainment","Communication","Visa & fees","Supplies & materials","Other"];
const PAYMENTS = ["Company card","Personal card","Cash","Bank transfer"];
const PERSONAL = new Set(["Personal card","Cash"]);

/* ---------- Helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
const nowIso = () => new Date().toISOString();
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const shortDate = iso => { const [y,m,d] = (iso||"").split("-"); return y ? `${+d} ${MONTHS[+m-1]}` : ""; };
const longDate = iso => { const [y,m,d] = (iso||"").split("-"); return y ? `${+d} ${MONTHS[+m-1]} ${y}` : ""; };
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k,v) => { try { localStorage.setItem(k, v); } catch {} };
function ago(iso){
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s/60)} min ago`;
  if (s < 86400) return `${Math.round(s/3600)} h ago`;
  return longDate(iso.slice(0,10));
}
let toastTimer;
function toast(msg){ const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }
function currencyOptions(sel){
  const opt = c => `<option value="${c}">${c} · ${esc(CUR[c].name)}</option>`;
  sel.innerHTML = `<optgroup label="Common">${COMMON.map(opt).join("")}</optgroup><optgroup label="All currencies">${CURRENCIES.map(([c]) => opt(c)).join("")}</optgroup>`;
}
function armConfirm(btn, label, action){
  if (btn.dataset.armed){ delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = btn.dataset.orig; action(); return; }
  btn.dataset.orig = btn.textContent; btn.dataset.armed = "1"; btn.classList.add("armed"); btn.textContent = label;
  setTimeout(() => { if (btn.dataset.armed){ delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = btn.dataset.orig; } }, 5000);
}

/* ---------- State ---------- */
const state = { trips: [], expenses: [], loaded: false, tripId: lsGet("tel.trip"), editingTripId: null, editingExpenseId: null };

async function load(){
  const [t, e] = await Promise.all([store.getAll("trips"), store.getAll("expenses")]);
  state.trips = t.filter(x => !x.deleted);
  state.expenses = e.filter(x => !x.deleted);
  state.loaded = true;
  render();
}
/** Save a record locally, mark it for upload, and ask for a sync. */
async function saveLocal(kind, rec){
  rec.updatedAt = nowIso(); rec.dirty = 1;
  await store.put(kind, rec);
  askPersistentStorage();
  sync.schedule();
}
const currentTrip = () => state.trips.find(t => t.id === state.tripId) || null;
const tripExpenses = id => state.expenses.filter(x => x.tripId === id)
  .sort((a,b) => (b.date||"").localeCompare(a.date||"") || (b.createdAt||"").localeCompare(a.createdAt||""));

// Ask the browser not to clear this app's storage when the phone runs low on space.
let persistAsked = false;
async function askPersistentStorage(){
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  try { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

/* ---------- Render ---------- */
function render(){
  $("loading").hidden = state.loaded;
  if (!state.loaded) return;
  const trips = [...state.trips].sort((a,b) => (b.startDate||"").localeCompare(a.startDate||""));
  if (!currentTrip() && trips.length) state.tripId = trips[0].id;
  const sel = $("tripSelect");
  sel.innerHTML = trips.length ? trips.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("") : `<option value="">No trips</option>`;
  sel.value = state.tripId || ""; sel.disabled = !trips.length;
  const trip = currentTrip();
  $("emptyState").hidden = !!trip || !$("tripFormPanel").hidden;
  $("tripView").hidden = !trip;
  if (!trip) return;
  lsSet("tel.trip", trip.id);
  const xs = tripExpenses(trip.id);
  renderTripHead(trip);
  renderTiles(trip, xs);
  renderByCurrency(trip, xs);
  renderByCategory(trip, xs);
  renderFilters(xs);
  renderList(trip, xs);
  syncFormToTrip(trip, xs);
}

function renderTripHead(t){
  $("tvName").textContent = t.name;
  const bits = [];
  if (t.destination) bits.push(esc(t.destination));
  if (t.startDate) bits.push(`${longDate(t.startDate)} – ${longDate(t.endDate)}`);
  bits.push(`Home currency <span class="tag">${esc(t.baseCurrency)}</span>`);
  if (t.purpose) bits.push(esc(t.purpose));
  $("tvMeta").innerHTML = bits.map(b => `<span>${b}</span>`).join("");
}

function renderTiles(t, xs){
  const be = t.baseExp, bc = esc(t.baseCurrency);
  let total = 0n, mine = 0n, other = 0n, noReceipt = 0, withScan = 0;
  for (const x of xs){
    const b = BigInt(x.baseMinor); total += b;
    if (x.reimbursable) mine += b; else other += b;
    if (!x.receipt) noReceipt++;
    if ((x.receipts || []).length) withScan++;
  }
  const curCount = new Set(xs.map(x => x.currency)).size;
  const tile = (k, v, s, attn) => `<div class="tile${attn ? " attn" : ""}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
  $("tiles").innerHTML =
    tile("Trip total", `<small>${bc}</small>${fmt(total, be)}`, `${xs.length} expense${xs.length===1?"":"s"} in ${curCount} currenc${curCount===1?"y":"ies"}`) +
    tile("Owed back to you", `<small>${bc}</small>${fmt(mine, be)}`, "Expenses marked reimbursable") +
    tile("Not reimbursable", `<small>${bc}</small>${fmt(other, be)}`, "Company-paid or non-claimable") +
    tile("Receipts", `${xs.length - noReceipt} / ${xs.length}`, (noReceipt ? `${noReceipt} missing a receipt` : "All receipts kept") + ` · ${withScan} with a scan`, noReceipt > 0);
}

function renderByCurrency(t, xs){
  if (!xs.length){ $("byCur").innerHTML = `<p class="muted">Totals per currency appear once you add expenses.</p>`; return; }
  const g = new Map();
  for (const x of xs){
    const r = g.get(x.currency) || { exp: x.exp, n: 0, orig: 0n, base: 0n };
    r.n++; r.orig += BigInt(x.amountMinor); r.base += BigInt(x.baseMinor); g.set(x.currency, r);
  }
  const rows = [...g.entries()].sort((a,b) => (b[1].base > a[1].base) - (b[1].base < a[1].base));
  $("byCur").innerHTML = `<table><thead><tr><th>Currency</th><th class="r">Items</th><th class="r">Amount paid</th><th class="r">In ${esc(t.baseCurrency)}</th></tr></thead><tbody>` +
    rows.map(([c,r]) => `<tr><td><span class="mono">${esc(c)}</span> <span class="muted">· smallest unit ${unitText(r.exp)}</span></td><td class="r num">${r.n}</td><td class="r num">${fmt(r.orig, r.exp)}</td><td class="r num">${fmt(r.base, t.baseExp)}</td></tr>`).join("") +
    `</tbody></table>`;
}

function renderByCategory(t, xs){
  if (!xs.length){ $("byCat").innerHTML = `<p class="muted">Category split appears once you add expenses.</p>`; return; }
  const g = new Map();
  for (const x of xs) g.set(x.category, (g.get(x.category) || 0n) + BigInt(x.baseMinor));
  const rows = [...g.entries()].sort((a,b) => (b[1] > a[1]) - (b[1] < a[1]));
  const max = rows.reduce((m,[,v]) => v > m ? v : m, 0n) || 1n;
  $("byCat").innerHTML = rows.map(([c,v]) => {
    const pct = v > 0n ? Number(v * 10000n / max) / 100 : 0;
    return `<div class="bar"><span>${esc(c)}</span><span class="num">${esc(t.baseCurrency)} ${fmt(v, t.baseExp)}</span><div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
  }).join("");
}

function renderFilters(xs){
  const fc = $("fCat"), fu = $("fCur"), vc = fc.value, vu = fu.value;
  fc.innerHTML = `<option value="">All categories</option>` + CATEGORIES.map(c => `<option>${esc(c)}</option>`).join("");
  const curs = [...new Set(xs.map(x => x.currency))].sort();
  fu.innerHTML = `<option value="">All currencies</option>` + curs.map(c => `<option>${esc(c)}</option>`).join("");
  fc.value = vc; fu.value = curs.includes(vu) ? vu : "";
}

function filtered(xs){
  const q = $("fSearch").value.trim().toLowerCase(), c = $("fCat").value, u = $("fCur").value;
  return xs.filter(x => (!c || x.category === c) && (!u || x.currency === u) &&
    (!q || [x.description, x.merchant, x.notes].some(s => (s || "").toLowerCase().includes(q))));
}

function renderList(t, xs){
  const list = $("list");
  if (!xs.length){ list.innerHTML = `<p class="muted">No expenses yet. Add the first one with the form.</p>`; return; }
  const rows = filtered(xs);
  if (!rows.length){ list.innerHTML = `<p class="muted">No expenses match these filters.</p>`; return; }
  list.innerHTML = rows.map(x => {
    const same = x.currency === t.baseCurrency;
    const chips = [esc(x.category), esc(x.payment)];
    if (x.merchant) chips.push(esc(x.merchant));
    if (x.reimbursable) chips.push("Reimbursable");
    if (!x.receipt) chips.push(`<span class="flag">No receipt</span>`);
    if (!same) chips.push(`<span class="mono">1 ${esc(x.currency)} = ${esc(x.rate)} ${esc(t.baseCurrency)}</span>`);
    if (x.dirty) chips.push(`<span title="Saved on this device, waiting to sync">Not synced yet</span>`);
    const rc = x.receipts || [];
    return `<div class="item${state.editingExpenseId === x.id ? " editing" : ""}">
      <span class="date">${shortDate(x.date)}</span>
      <div style="min-width:0"><div class="desc">${esc(x.description)}</div><div class="chips">${chips.map(c => `<span>${c}</span>`).join("")}</div>${x.notes ? `<div class="chips"><span>${esc(x.notes)}</span></div>` : ""}${rc.length ? `<div class="thumbs">${rc.map((r,i) => thumbHtml(r, i, { sm: true, owner: x.id })).join("")}</div>` : ""}</div>
      <div class="amt"><div class="orig">${money(x.amountMinor, esc(x.currency), x.exp)}</div>${same ? "" : `<div class="base">${money(x.baseMinor, esc(t.baseCurrency), t.baseExp)}</div>`}</div>
      <div class="ops"><button class="btn small" type="button" data-edit="${esc(x.id)}">Edit</button><button class="btn small danger" type="button" data-del="${esc(x.id)}">Delete</button></div>
    </div>`;
  }).join("");
  hydrateThumbs(list);
}

/* ---------- Receipt files ---------- */
// Files live in local storage as Blobs; object URLs are made on demand and reused.
const urlCache = new Map();
const isPdf = r => r.type === "application/pdf";
async function fileUrl(id, type, { fetchIfMissing = false } = {}){
  if (urlCache.has(id)) return urlCache.get(id);
  let f = await store.get("files", id);
  if (!f && fetchIfMissing) f = await sync.fetchFile(id, type);
  if (!f) return null;
  const u = URL.createObjectURL(f.blob);
  urlCache.set(id, u);
  return u;
}
function thumbHtml(r, i, opts = {}){
  const inner = isPdf(r) ? "PDF" : `<span data-file="${esc(r.id)}">…</span>`;
  return `<button type="button" class="thumb${opts.sm ? " sm" : ""}" data-view="${esc(opts.owner || "")}" data-idx="${i}" aria-label="View receipt ${i+1}">${inner}</button>`;
}
async function hydrateThumbs(root){
  for (const el of root.querySelectorAll("[data-file]")){
    const id = el.dataset.file;
    const u = await fileUrl(id);
    if (!el.isConnected) continue;
    if (u){ const img = document.createElement("img"); img.src = u; img.alt = ""; el.replaceWith(img); }
    else el.textContent = navigator.onLine ? "Not here yet" : "Offline";
  }
}
async function prepareFile(file){
  const t = (file.type || "").toLowerCase();
  if (t === "application/pdf" || /\.pdf$/i.test(file.name)){
    if (file.size > 20 * 1024 * 1024) throw new Error("That PDF is over 20 MB. Use a smaller file.");
    return { blob: file, type: "application/pdf" };
  }
  if (t.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)){
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const max = 2400, s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height); if (bmp.close) bmp.close();
      const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
      if (blob) return { blob, type: "image/jpeg" };
    } catch {}
    if (["image/jpeg","image/png","image/webp"].includes(t)) return { blob: file, type: t };
    throw new Error("This photo format can't be read here. Save it as JPG or PNG and try again.");
  }
  throw new Error("Attach a photo (JPG or PNG) or a PDF.");
}

// Receipts attached in the open form. `session` = files saved during this form session but not yet on a saved expense.
const rx = { list: [], session: new Set(), removals: [], busy: 0 };
async function addFiles(files){
  $("xFileErr").textContent = "";
  for (const file of files){
    rx.busy++; renderFormThumbs();
    try {
      const p = await prepareFile(file);
      const id = uuid();
      await store.put("files", { id, blob: p.blob, type: p.type, uploaded: 0 });
      rx.list.push({ id, type: p.type, name: (file.name || "receipt").slice(0, 120) });
      rx.session.add(id);
      $("xReceipt").checked = true;
    } catch (e) {
      $("xFileErr").textContent = e?.name === "QuotaExceededError" ? "This device is out of storage space. Free up space and try again." : (e?.message || "Couldn't attach that file.");
    } finally { rx.busy--; renderFormThumbs(); }
  }
}
function renderFormThumbs(){
  $("xThumbs").innerHTML = rx.list.map((r,i) => `<span class="thumb-wrap">${thumbHtml(r, i, { owner: "__form" })}<button type="button" class="x" data-rm="${i}" aria-label="Remove receipt ${i+1}">×</button></span>`).join("")
    + Array.from({ length: rx.busy }, () => `<span class="thumb busy">Saving…</span>`).join("");
  $("xSave").disabled = rx.busy > 0;
  hydrateThumbs($("xThumbs"));
}
async function discardUnsaved(){
  const ids = [...rx.session]; rx.session.clear();
  rx.list = []; rx.removals = []; $("xFileErr").textContent = "";
  for (const id of ids) await store.del("files", id);
  renderFormThumbs();
}

/* ---------- Receipt viewer ---------- */
const lb = { items: [], i: 0, last: null };
function openViewer(items, i){ if (!items.length) return; lb.items = items; lb.i = i; lb.last = document.activeElement; showViewer(); }
async function showViewer(){
  const r = lb.items[lb.i];
  $("lightbox").hidden = false;
  $("lbCount").textContent = `${lb.i + 1} of ${lb.items.length}${isPdf(r) ? " · PDF" : ""}`;
  $("lbPrev").hidden = $("lbNext").hidden = lb.items.length < 2;
  $("lbImg").hidden = true; $("lbOpen").hidden = true;
  $("lbMsg").hidden = false; $("lbMsg").textContent = "Loading…";
  $("lbClose").focus();
  const u = await fileUrl(r.id, r.type, { fetchIfMissing: true });
  if (lb.items[lb.i] !== r) return;
  if (!u){ $("lbMsg").textContent = navigator.onLine ? "This receipt hasn't reached this device yet. Sync, then try again." : "This receipt is on another device. Connect to the internet to download it."; return; }
  $("lbOpen").href = u; $("lbOpen").hidden = false;
  $("lbOpen").textContent = isPdf(r) ? "Open PDF" : "Open full size";
  if (isPdf(r)){ $("lbOpen").download = r.name || "receipt.pdf"; $("lbMsg").textContent = r.name || "PDF receipt"; }
  else { $("lbOpen").removeAttribute("download"); $("lbImg").src = u; $("lbImg").hidden = false; $("lbMsg").hidden = true; }
}
function closeViewer(){ $("lightbox").hidden = true; $("lbImg").removeAttribute("src"); if (lb.last) lb.last.focus(); }

/* ---------- Expense form ---------- */
let formTripId = null;
function lastRate(tripId, cur){ const x = tripExpenses(tripId).find(e => e.currency === cur); return x ? x.rate : ""; }
function syncFormToTrip(t, xs){
  if (formTripId === t.id){ updateFormHints(); return; }
  formTripId = t.id;
  resetExpenseForm(t, xs);
}
function resetExpenseForm(t, xs = tripExpenses(t.id)){
  state.editingExpenseId = null;
  discardUnsaved();
  $("xForm").reset();
  const today = todayISO();
  $("xDate").value = (t.startDate && t.endDate && (today < t.startDate || today > t.endDate)) ? t.startDate : today;
  const lastCur = xs[0]?.currency || t.baseCurrency;
  $("xCur").value = lastCur;
  $("xRate").value = lastCur === t.baseCurrency ? "1" : lastRate(t.id, lastCur);
  $("xPay").value = "Company card";
  $("xFormTitle").textContent = "Add expense"; $("xSave").textContent = "Add expense"; $("xCancel").hidden = true;
  clearErrs(); updateFormHints();
}
function clearErrs(){ ["xDateErr","xDescErr","xAmtErr","xRateErr"].forEach(id => $(id).textContent = ""); }
function updateFormHints(){
  const t = currentTrip(); if (!t) return;
  const c = CUR[$("xCur").value] || CUR[t.baseCurrency];
  const same = c.code === t.baseCurrency;
  $("xAmtHint").textContent = `${c.name}: smallest unit is ${unitText(c.exp)} ${c.code}` + (c.exp === 0 ? " (whole numbers only)" : ` (${c.exp} decimal place${c.exp > 1 ? "s" : ""})`);
  $("xAmount").placeholder = c.exp ? "0." + "0".repeat(c.exp) : "0";
  $("rateField").hidden = same;
  $("xRateLbl").textContent = `Exchange rate: 1 ${c.code} = how many ${t.baseCurrency}?`;
  const pv = $("xPreview");
  const a = parseAmount($("xAmount").value, c.exp);
  if (!$("xAmount").value.trim() || a.error){ pv.textContent = "Converted amount appears here."; return; }
  if (same){ pv.innerHTML = `Stored as <strong>${a.value.toString()}</strong> × ${unitText(c.exp)} ${c.code}`; return; }
  const r = parseRate($("xRate").value);
  if (!r){ pv.textContent = `Enter the exchange rate to see the ${t.baseCurrency} amount.`; return; }
  const b = convert(a.value, c.exp, r, t.baseExp);
  pv.innerHTML = `${money(a.value, c.code, c.exp)} → <strong>${money(b, esc(t.baseCurrency), t.baseExp)}</strong><br>Rounded to the nearest ${unitText(t.baseExp)} ${esc(t.baseCurrency)}`;
}
async function fillExpenseForm(x){
  const t = currentTrip();
  await discardUnsaved();
  state.editingExpenseId = x.id;
  rx.list = (x.receipts || []).map(r => ({ ...r })); renderFormThumbs();
  $("xDate").value = x.date; $("xCat").value = x.category; $("xDesc").value = x.description; $("xMerchant").value = x.merchant || "";
  $("xCur").value = x.currency; $("xAmount").value = fmt(x.amountMinor, x.exp, false); $("xRate").value = x.rate;
  $("xPay").value = x.payment; $("xReimb").checked = !!x.reimbursable; $("xReceipt").checked = !!x.receipt; $("xNotes").value = x.notes || "";
  $("xFormTitle").textContent = "Edit expense"; $("xSave").textContent = "Save changes"; $("xCancel").hidden = false;
  clearErrs(); updateFormHints(); renderList(t, tripExpenses(t.id));
  $("xFormTitle").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function submitExpense(ev){
  ev.preventDefault();
  const t = currentTrip(); if (!t) return;
  clearErrs();
  const c = CUR[$("xCur").value];
  let ok = true;
  const date = $("xDate").value;
  if (!date){ $("xDateErr").textContent = "Pick the date of the expense."; ok = false; }
  const desc = $("xDesc").value.trim();
  if (!desc){ $("xDescErr").textContent = "Describe what this was for."; ok = false; }
  const a = parseAmount($("xAmount").value, c.exp);
  if (a.error){ $("xAmtErr").textContent = a.error; ok = false; }
  const same = c.code === t.baseCurrency;
  const r = same ? parseRate("1") : parseRate($("xRate").value);
  if (!r){ $("xRateErr").textContent = `Enter how many ${t.baseCurrency} one ${c.code} is worth, e.g. 12650.75`; ok = false; }
  if (rx.busy > 0){ $("xFileErr").textContent = "Wait for the receipt to finish saving."; ok = false; }
  if (!ok) return;
  const existing = state.expenses.find(x => x.id === state.editingExpenseId);
  const rec = {
    ...(existing || {}),
    id: existing ? existing.id : uuid(), tripId: t.id, date, category: $("xCat").value, description: desc,
    merchant: $("xMerchant").value.trim(), payment: $("xPay").value, reimbursable: $("xReimb").checked,
    receipt: $("xReceipt").checked, notes: $("xNotes").value.trim(),
    currency: c.code, exp: c.exp, amountMinor: a.value.toString(),
    rate: r.text, baseCurrency: t.baseCurrency, baseExp: t.baseExp, baseMinor: convert(a.value, c.exp, r, t.baseExp).toString(),
    receipts: rx.list.map(x => ({ id: x.id, type: x.type, name: x.name })),
    createdAt: existing ? existing.createdAt : nowIso(), deleted: false
  };
  const btn = $("xSave"); btn.disabled = true;
  try {
    await saveLocal("expenses", rec);
    const removed = rx.removals.slice();
    rx.session.clear(); rx.removals = [];
    await sync.deleteFiles(removed);
    toast(existing ? "Expense updated" : "Expense added");
    await load();
    const keep = { cur: c.code, rate: r.text, date, pay: rec.payment };
    resetExpenseForm(t);
    if (!existing){ $("xCur").value = keep.cur; $("xRate").value = same ? "1" : keep.rate; $("xDate").value = keep.date; $("xPay").value = keep.pay; $("xReimb").checked = PERSONAL.has(keep.pay); updateFormHints(); }
  } catch (e) {
    $("xAmtErr").textContent = e?.name === "QuotaExceededError" ? "This device is out of storage space." : "Couldn't save on this device. Try again.";
  } finally { btn.disabled = false; }
}
async function deleteExpense(id){
  const x = state.expenses.find(x => x.id === id); if (!x) return;
  if (state.editingExpenseId === id) resetExpenseForm(currentTrip());
  await saveLocal("expenses", { ...x, deleted: true, receipts: [] });
  await sync.deleteFiles((x.receipts || []).map(r => r.id));
  toast("Expense deleted");
  await load();
}

/* ---------- Trip form ---------- */
function openTripForm(trip){
  state.editingTripId = trip ? trip.id : null;
  $("tripFormTitle").textContent = trip ? "Edit trip" : "New trip";
  $("tSave").textContent = trip ? "Save trip" : "Create trip";
  $("tName").value = trip?.name || ""; $("tDest").value = trip?.destination || ""; $("tPurpose").value = trip?.purpose || "";
  $("tStart").value = trip?.startDate || todayISO(); $("tEnd").value = trip?.endDate || todayISO();
  $("tBase").value = trip?.baseCurrency || "IDR";
  const locked = trip && tripExpenses(trip.id).length > 0;
  $("tBase").disabled = !!locked;
  $("tBaseHint").textContent = locked ? "Home currency is fixed once a trip has expenses, so saved conversions stay valid." : "Every expense is converted into this currency for the trip total.";
  $("tNameErr").textContent = ""; $("tDateErr").textContent = "";
  $("tripFormPanel").hidden = false; $("emptyState").hidden = true;
  $("tripFormPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  $("tName").focus();
}
function closeTripForm(){ $("tripFormPanel").hidden = true; state.editingTripId = null; render(); }
async function submitTrip(ev){
  ev.preventDefault();
  const name = $("tName").value.trim(), s = $("tStart").value, e = $("tEnd").value;
  $("tNameErr").textContent = name ? "" : "Give the trip a name.";
  $("tDateErr").textContent = (!s || !e) ? "Enter both dates." : (e < s ? "End date is before the start date." : "");
  if (!name || !s || !e || e < s) return;
  const existing = state.trips.find(t => t.id === state.editingTripId);
  const base = existing && $("tBase").disabled ? existing.baseCurrency : $("tBase").value;
  const rec = { ...(existing || {}), id: existing ? existing.id : uuid(), name, destination: $("tDest").value.trim(),
    purpose: $("tPurpose").value.trim(), startDate: s, endDate: e, baseCurrency: base, baseExp: CUR[base].exp,
    createdAt: existing?.createdAt || nowIso(), deleted: false };
  const btn = $("tSave"); btn.disabled = true;
  try {
    await saveLocal("trips", rec);
    state.tripId = rec.id; formTripId = null;
    toast(existing ? "Trip saved" : "Trip created");
    $("tripFormPanel").hidden = true; state.editingTripId = null;
    await load();
  } catch { $("tNameErr").textContent = "Couldn't save on this device. Try again."; }
  finally { btn.disabled = false; }
}
async function deleteTrip(){
  const t = currentTrip(); if (!t) return;
  await discardUnsaved();
  const fileIds = [];
  for (const x of tripExpenses(t.id)){
    fileIds.push(...(x.receipts || []).map(r => r.id));
    await saveLocal("expenses", { ...x, deleted: true, receipts: [] });
  }
  await saveLocal("trips", { ...t, deleted: true });
  await sync.deleteFiles(fileIds);
  state.tripId = null; formTripId = null; toast("Trip deleted");
  await load();
}

/* ---------- CSV export ---------- */
function exportCsv(){
  const t = currentTrip(); if (!t) return;
  const xs = tripExpenses(t.id).slice().reverse();
  const q = v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["Date","Category","Description","Merchant","Paid with","Currency","Amount",`Rate to ${t.baseCurrency}`,`Amount ${t.baseCurrency}`,"Reimbursable","Receipt kept","Receipt scans","Notes"];
  const lines = [head.map(q).join(",")].concat(xs.map(x => [x.date, x.category, x.description, x.merchant, x.payment, x.currency,
    fmt(x.amountMinor, x.exp, false), x.rate, fmt(x.baseMinor, t.baseExp, false), x.reimbursable ? "Yes" : "No", x.receipt ? "Yes" : "No", (x.receipts || []).length, x.notes].map(q).join(",")));
  const total = xs.reduce((s, x) => s + BigInt(x.baseMinor), 0n);
  lines.push(["","","TOTAL","","","","","",fmt(total, t.baseExp, false),"","","",""].map(q).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" });
  const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "trip";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${slug}-expenses-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast("CSV downloaded");
}

/* ---------- Sync status & account sheet ---------- */
let lastStatus = null;
function renderStatus(s){
  lastStatus = s;
  const chip = $("syncChip"); chip.dataset.state = s.state;
  const p = s.pending ? ` · ${s.pending} waiting` : "";
  const text = {
    notConfigured: "Not syncing · set up",
    signedOut: "Not signed in" + p,
    offline: "Offline" + (s.pending ? ` · ${s.pending} change${s.pending === 1 ? "" : "s"} waiting` : " · saved on this device"),
    syncing: "Syncing…",
    error: "Sync problem" + p,
    idle: s.pending ? `${s.pending} change${s.pending === 1 ? "" : "s"} to sync` : `Synced ${ago(s.lastSyncAt)}`
  }[s.state] || "";
  $("syncText").textContent = text;
  if (!$("sheet").hidden) renderSheet();
}
async function renderSheet(){
  const s = lastStatus || {};
  const acct = await sync.account();
  const cfg = sync.getConfig();
  const stateText = { notConfigured: "Not set up", signedOut: "Signed out", offline: "Offline", syncing: "Syncing", error: "Problem", idle: "Up to date" }[s.state] || "";
  $("syncInfo").innerHTML = `<dt>Status</dt><dd>${esc(stateText)}</dd><dt>Waiting to upload</dt><dd>${s.pending || 0}</dd><dt>Last synced</dt><dd>${esc(ago(s.lastSyncAt))}</dd>`;
  $("syncErr").textContent = s.state === "error" ? s.message : (s.message || "");
  $("syncActions").hidden = !acct || !sync.isConfigured();
  $("syncNowBtn").disabled = s.state === "syncing" || !navigator.onLine;
  $("signInSec").hidden = !!acct || !sync.isConfigured();
  $("signedInSec").hidden = !acct;
  $("whoami").textContent = acct?.email || "";
  $("configSec").hidden = cfg.fromFile;
  if (document.activeElement !== $("cfUrl")) $("cfUrl").value = cfg.supabaseUrl;
  if (document.activeElement !== $("cfKey")) $("cfKey").value = cfg.supabaseKey;
  $("configHint").textContent = sync.isConfigured() ? "Connected to this Supabase project. Change it only if you move to a new project." : "Paste the Project URL and publishable key from Supabase (README, step 2).";
  let persisted = "Unknown", usage = "";
  try { if (navigator.storage?.persisted) persisted = (await navigator.storage.persisted()) ? "Protected from automatic clean-up" : "May be cleared if the device runs low on space"; } catch {}
  try { const e = await navigator.storage.estimate(); usage = `${(e.usage / 1048576).toFixed(1)} MB used`; } catch {}
  $("deviceInfo").innerHTML = `<dt>Storage</dt><dd>${esc(persisted)}</dd>${usage ? `<dt>Space</dt><dd>${esc(usage)}</dd>` : ""}<dt>Connection</dt><dd>${navigator.onLine ? "Online" : "Offline"}</dd>`;
}
function openSheet(){ $("sheet").hidden = false; renderSheet(); $("sheetClose").focus(); }
function closeSheet(){ $("sheet").hidden = true; $("syncChip").focus(); }

/* ---------- Service worker (offline support) ---------- */
function registerServiceWorker(){
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").then(reg => {
    const offer = w => { $("updateBanner").hidden = false; $("updateBtn").onclick = () => w.postMessage("skipWaiting"); };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60_000);
  }).catch(() => {});
  // Reload only when an update replaces a running version (after "Update now"),
  // never on the very first install, which would throw away what you're typing.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded){ reloaded = true; location.reload(); } });
}

/* ---------- Wiring ---------- */
async function init(){
  currencyOptions($("tBase")); currencyOptions($("xCur"));
  $("xCat").innerHTML = CATEGORIES.map(c => `<option>${esc(c)}</option>`).join("");
  $("xPay").innerHTML = PAYMENTS.map(p => `<option>${esc(p)}</option>`).join("");
  $("tripSelect").addEventListener("change", e => { state.tripId = e.target.value; render(); });
  $("newTripBtn").addEventListener("click", () => openTripForm(null));
  $("emptyNewTrip").addEventListener("click", () => openTripForm(null));
  $("editTripBtn").addEventListener("click", () => openTripForm(currentTrip()));
  $("delTripBtn").addEventListener("click", e => { const n = tripExpenses(state.tripId).length; armConfirm(e.currentTarget, n ? `Delete trip and ${n} expense${n === 1 ? "" : "s"}?` : "Confirm delete", deleteTrip); });
  $("tCancel").addEventListener("click", closeTripForm);
  $("tripForm").addEventListener("submit", submitTrip);
  $("xForm").addEventListener("submit", submitExpense);
  $("xCancel").addEventListener("click", () => { const t = currentTrip(); resetExpenseForm(t); renderList(t, tripExpenses(t.id)); });
  $("xCur").addEventListener("change", () => { const t = currentTrip(), c = $("xCur").value; $("xRate").value = c === t.baseCurrency ? "1" : lastRate(t.id, c); updateFormHints(); });
  ["xAmount","xRate"].forEach(id => $(id).addEventListener("input", updateFormHints));
  $("xPay").addEventListener("change", () => { $("xReimb").checked = PERSONAL.has($("xPay").value); });
  ["fSearch","fCat","fCur"].forEach(id => $(id).addEventListener("input", () => { const t = currentTrip(); if (t) renderList(t, tripExpenses(t.id)); }));
  $("exportBtn").addEventListener("click", exportCsv);
  $("list").addEventListener("click", e => {
    const ed = e.target.closest("[data-edit]"), dl = e.target.closest("[data-del]"), v = e.target.closest("[data-view]");
    if (ed){ const x = state.expenses.find(x => x.id === ed.dataset.edit); if (x) fillExpenseForm(x); }
    if (dl) armConfirm(dl, "Confirm delete", () => deleteExpense(dl.dataset.del));
    if (v){ const x = state.expenses.find(x => x.id === v.dataset.view); if (x) openViewer(x.receipts || [], +v.dataset.idx); }
  });
  ["xFiles","xCamera"].forEach(id => $(id).addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) addFiles(f); }));
  $("xThumbs").addEventListener("click", async e => {
    const rm = e.target.closest("[data-rm]");
    if (rm){
      const [r] = rx.list.splice(+rm.dataset.rm, 1);
      if (r){ if (rx.session.has(r.id)){ rx.session.delete(r.id); await store.del("files", r.id); } else rx.removals.push(r.id); }
      renderFormThumbs(); return;
    }
    const v = e.target.closest("[data-view]");
    if (v) openViewer(rx.list, +v.dataset.idx);
  });
  // Viewer
  $("lbClose").addEventListener("click", closeViewer);
  $("lbPrev").addEventListener("click", () => { lb.i = (lb.i - 1 + lb.items.length) % lb.items.length; showViewer(); });
  $("lbNext").addEventListener("click", () => { lb.i = (lb.i + 1) % lb.items.length; showViewer(); });
  $("lightbox").addEventListener("click", e => { if (e.target.id === "lightbox") closeViewer(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape"){ if (!$("lightbox").hidden) closeViewer(); else if (!$("sheet").hidden) closeSheet(); }
    if ($("lightbox").hidden || lb.items.length < 2) return;
    if (e.key === "ArrowLeft") $("lbPrev").click();
    if (e.key === "ArrowRight") $("lbNext").click();
  });
  // Account sheet
  $("syncChip").addEventListener("click", openSheet);
  $("sheetClose").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
  $("syncNowBtn").addEventListener("click", () => sync.syncNow());
  $("signInForm").addEventListener("submit", async e => {
    e.preventDefault(); $("siErr").textContent = "";
    if (!navigator.onLine){ $("siErr").textContent = "You're offline. Connect to the internet to sign in."; return; }
    const btn = $("siBtn"); btn.disabled = true;
    try { await sync.signIn($("siEmail").value, $("siPass").value); $("siPass").value = ""; toast("Signed in. Syncing…"); await sync.refreshStatus(); }
    catch (err) { $("siErr").textContent = err.message || "Couldn't sign in."; }
    finally { btn.disabled = false; renderSheet(); }
  });
  $("signOutBtn").addEventListener("click", async () => { await sync.signOut(); toast("Signed out on this device"); renderSheet(); });
  $("configForm").addEventListener("submit", e => {
    e.preventDefault();
    const url = $("cfUrl").value.trim(), key = $("cfKey").value.trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url) && !/^https:\/\//.test(url)){ $("cfErr").textContent = "The Project URL starts with https:// and ends in .supabase.co"; return; }
    if (key.length < 20){ $("cfErr").textContent = "Paste the whole publishable key."; return; }
    $("cfErr").textContent = "";
    sync.saveConfig(url, key); toast("Connection saved"); sync.refreshStatus(); renderSheet();
  });

  window.addEventListener("ledger:remote-change", () => { load(); });
  window.addEventListener("online", () => { if (!$("sheet").hidden) renderSheet(); });
  window.addEventListener("offline", () => { if (!$("sheet").hidden) renderSheet(); });

  try { await store.openDb(); await load(); }
  catch (e) {
    $("loading").hidden = true;
    $("banner").textContent = "This browser won't let the app store data (private browsing can cause this). Open it in a normal Chrome window.";
    $("banner").hidden = false;
    return;
  }
  sync.onStatus(renderStatus);
  sync.start();
  registerServiceWorker();
  setInterval(() => { if (lastStatus) renderStatus(lastStatus); }, 30_000);
}

init();
