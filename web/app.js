import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG } from "./config.js";

const CATS = ["ID cards","Wallets and cash","Phones and earbuds","Chargers and gadgets","Books and notebooks","Bottles and bags","Keys","Other"];
const $ = (id) => document.getElementById(id);
const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let session = null, me = null, isAdmin = false, items = [], matches = [];
let view = "feed", filter = "all", openPanel = null, signUp = false;

function h(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "text") e.textContent = attrs[k];
    else if (k === "class") e.className = attrs[k];
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  kids.forEach((c) => c && e.appendChild(c));
  return e;
}
const abbr = (c) => ({ "ID cards":"ID","Wallets and cash":"WL","Phones and earbuds":"PH","Chargers and gadgets":"CH","Books and notebooks":"BK","Bottles and bags":"BT","Keys":"KY" }[c] || "IT");
const ago = (iso) => { const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000)); if (m < 60) return m + " min ago"; const hr = Math.round(m / 60); return hr < 24 ? hr + " h ago" : Math.round(hr / 24) + " d ago"; };
const stLabel = (i) => ({ open:"Open", claimed:"Claimed", matched:"Finder responded", returned:"Returned" }[i.status] || "Open");
const photoUrl = (p) => p ? sb.storage.from("item-photos").getPublicUrl(p).data.publicUrl : null;
const msgOf = (e) => (e && e.message) ? e.message : "Something went wrong. Try again.";

CATS.forEach((c) => { $("cat").appendChild(h("option", { text: c })); $("fcat").appendChild(h("option", { text: c, value: c })); });

/* ---------- auth ---------- */
function showAuth() {
  ["feed","report","mine","admin"].forEach((n) => $("v-" + n).hidden = true);
  $("v-auth").hidden = false; $("tabs").hidden = true; $("signout").hidden = true;
}
$("authSwitch").addEventListener("click", () => {
  signUp = !signUp;
  $("authTitle").textContent = signUp ? "Create an account" : "Sign in";
  $("authBtn").textContent = signUp ? "Sign up" : "Sign in";
  $("authSwitch").textContent = signUp ? "I already have an account" : "Create an account";
  $("nameRow").hidden = !signUp; $("authNote").textContent = "";
});
$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = $("authNote"), email = $("aemail").value.trim().toLowerCase(), pass = $("apass").value;
  note.className = "note";
  if (CONFIG.ALLOWED_DOMAIN && !email.endsWith("@" + CONFIG.ALLOWED_DOMAIN)) { note.className = "note err"; note.textContent = "Use your @" + CONFIG.ALLOWED_DOMAIN + " email."; return; }
  $("authBtn").disabled = true;
  try {
    if (signUp) {
      const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { name: $("aname").value.trim() } } });
      if (error) throw error;
      note.textContent = data.session ? "" : "Check your email to confirm your account, then sign in.";
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
    }
  } catch (x) { note.className = "note err"; note.textContent = msgOf(x); }
  $("authBtn").disabled = false;
});
$("signout").addEventListener("click", () => sb.auth.signOut());

/* ---------- views ---------- */
function setView(v) {
  if (!["feed","report","mine","admin"].includes(v)) v = "feed";
  if (v === "admin" && !isAdmin) v = "feed";
  view = v;
  ["feed","report","mine","admin"].forEach((n) => $("v-" + n).hidden = n !== v);
  [...$("tabs").children].forEach((t) => t.setAttribute("aria-selected", t.dataset.v === v));
  if (location.hash !== "#" + v) location.hash = v;
  render();
}
$("tabs").addEventListener("click", (e) => { if (e.target.dataset.v) setView(e.target.dataset.v); });
window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (session && v && v !== view) setView(v); });

/* ---------- data ---------- */
async function loadItems() {
  const { data, error } = await sb.from("items").select("*, owner:profiles!items_owner_id_fkey(name)").order("created_at", { ascending: false }).limit(300);
  if (error) { $("banner").hidden = false; $("banner").textContent = msgOf(error); return; }
  items = data || []; render();
}
async function loadMatches() {
  const { data } = await sb.from("matches").select("score, lost:items!matches_lost_item_id_fkey(id,name,place,owner_id), found:items!matches_found_item_id_fkey(id,name,place,owner_id)").order("score", { ascending: false }).limit(50);
  matches = data || []; if (view === "mine") render();
}
let timer = null;
function subscribe() {
  sb.channel("items-live").on("postgres_changes", { event: "*", schema: "public", table: "items" }, () => { clearTimeout(timer); timer = setTimeout(() => { loadItems(); loadMatches(); }, 300); }).subscribe();
}
async function call(name, args) { const { data, error } = await sb.rpc(name, args); if (error) throw error; return data; }
function note(id, t, err) { const n = $("n-" + id); if (n) { n.textContent = t; n.className = "note" + (err ? " err" : ""); } }

/* ---------- filters ---------- */
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
function visible(i) {
  const t = norm($("q").value);
  if ((filter === "lost" || filter === "found") && i.kind !== filter) return false;
  if (filter === "open" && i.status === "returned") return false;
  if (filter === "returned" && i.status !== "returned") return false;
  if ($("fcat").value && i.category !== $("fcat").value) return false;
  return !t || norm([i.name, i.category, i.place, i.description].join(" ")).includes(t);
}
["q","fcat","fsort"].forEach((id) => $(id).addEventListener("input", render));
$("chips").addEventListener("click", (e) => { const f = e.target.dataset.f; if (!f) return; filter = f; [...$("chips").children].forEach((b) => b.setAttribute("aria-pressed", b.dataset.f === f)); render(); });

/* ---------- cards ---------- */
function card(i) {
  const mineOwn = i.owner_id === me;
  const canManage = mineOwn || isAdmin;
  const ph = h("div", { class: "ph" });
  const url = photoUrl(i.photo_path);
  if (url) { const im = h("img", { src: url, alt: i.name + " photo", loading: "lazy" }); im.addEventListener("error", () => { im.remove(); ph.textContent = abbr(i.category); }); ph.appendChild(im); } else ph.textContent = abbr(i.category);
  const body = h("div", { class: "cb" }, [
    h("div", { class: "tags" }, [h("span", { class: "tag " + i.kind, text: i.kind.toUpperCase() }), h("span", { class: "tag st", text: stLabel(i) })]),
    h("h3", { text: i.name }),
    h("p", { class: "meta", text: i.place + " · " + i.category }),
    h("p", { class: "meta", text: "Posted " + ago(i.created_at) + (i.owner && i.owner.name ? " by " + i.owner.name : "") }),
  ]);
  if (i.description) body.appendChild(h("p", { class: "meta", text: i.description }));
  if (i.happened_on || i.happened_time) body.appendChild(h("p", { class: "meta", text: (i.kind === "found" ? "Found on " : "Lost on ") + (i.happened_on || "") + (i.happened_time ? " at " + i.happened_time.slice(0, 5) : "") }));
  if (i.kind === "found" && i.held_at) body.appendChild(h("p", { class: "meta", text: "Kept: " + i.held_at }));
  body.appendChild(h("p", { class: "meta", text: "Handover: " + i.handover }));
  const acts = h("div", { class: "acts" });
  if (i.status === "open" && !mineOwn) acts.appendChild(h("button", { class: "btn", text: i.kind === "found" ? "This is mine" : "I found this", onclick: () => { openPanel = openPanel === i.id ? null : i.id; render(); } }));
  if (canManage && i.status !== "returned") acts.appendChild(h("button", { class: "mini", text: "Mark returned", onclick: () => act(i, () => call("set_status", { p_item: i.id, p_status: "returned" })) }));
  if (canManage && (i.status === "claimed" || i.status === "matched")) acts.appendChild(h("button", { class: "mini", text: "Reopen", onclick: () => act(i, () => call("set_status", { p_item: i.id, p_status: "open" })) }));
  if (mineOwn || isAdmin || i.claimer_id === me) if (i.status === "claimed" || i.status === "matched" || i.status === "returned") acts.appendChild(h("button", { class: "mini", text: "Show contacts", onclick: () => showContacts(i) }));
  if (canManage) acts.appendChild(h("button", { class: "mini", text: "Delete", onclick: function () { if (this.dataset.c !== "1") { this.dataset.c = "1"; this.textContent = "Tap again to delete"; return; } act(i, () => call("delete_item", { p_item: i.id })); } }));
  if (!mineOwn) acts.appendChild(h("button", { class: "mini", text: "Report", onclick: () => reportItem(i) }));
  body.appendChild(acts);
  if (openPanel === i.id && i.status === "open") {
    const inp = h("input", { id: "cin-" + i.id, placeholder: i.kind === "found" ? "Hidden detail only the owner knows" : "Where you found it / a note", maxlength: "60", "aria-label": "Verification" });
    const con = h("input", { id: "cct-" + i.id, placeholder: "Your phone or email (shown to the poster only)", maxlength: "60", "aria-label": "Your contact", style: "margin-top:8px" });
    body.appendChild(h("div", { class: "claim" }, [inp, con, h("div", { class: "acts" }, [h("button", { class: "btn", text: "Submit", onclick: () => submitClaim(i, inp.value, con.value) })])]));
  }
  body.appendChild(h("p", { class: "note", id: "n-" + i.id, role: "status" }));
  return h("article", { class: "card" }, [ph, body]);
}
async function act(i, fn) { try { await fn(); await loadItems(); } catch (x) { note(i.id, msgOf(x), true); } }
async function showContacts(i) {
  try {
    const c = await call("item_contacts", { p_item: i.id });
    const parts = [];
    if (c.finder_contact) parts.push("Finder: " + c.finder_contact);
    if (c.claimer_contact) parts.push((i.kind === "found" ? "Claimed by: " : "Finder: ") + c.claimer_contact + (c.claimer_note ? " (" + c.claimer_note + ")" : ""));
    note(i.id, parts.join(" | ") || "No contact details to show.", false);
  } catch (x) { note(i.id, msgOf(x), true); }
}
async function reportItem(i) {
  const reason = prompt("Why are you reporting this post?");
  if (!reason || !reason.trim()) return;
  try { await call("report_item", { p_item: i.id, p_reason: reason }); note(i.id, "Thanks. An admin will review it.", false); } catch (x) { note(i.id, msgOf(x), true); }
}
async function submitClaim(i, detail, contact) {
  if (!contact.trim()) return note(i.id, "Add a contact so the poster can reach you.", true);
  if (!detail.trim()) return note(i.id, i.kind === "found" ? "Enter the hidden detail." : "Add a short note.", true);
  try {
    if (i.kind === "found") {
      const r = await call("claim_item", { p_item: i.id, p_detail: detail, p_contact: contact });
      if (!r.ok) return note(i.id, r.locked ? "Too many wrong tries. Ask the security desk to verify you." : "That detail does not match. " + r.tries_left + " tries left.", true);
      openPanel = null; await loadItems();
      note(i.id, "Verified. Finder: " + (r.finder_contact || "not given") + ". Handover: " + r.handover + (r.held_at ? " (item kept: " + r.held_at + ")" : "") + ".", false);
    } else {
      await call("respond_lost", { p_item: i.id, p_note: detail, p_contact: contact });
      openPanel = null; await loadItems();
    }
  } catch (x) { note(i.id, msgOf(x), true); }
}

/* ---------- render ---------- */
function render() {
  if (!session) return;
  const open = items.filter((i) => i.status !== "returned").length;
  $("stats").replaceChildren(...[["Total posts", items.length], ["Still open", open], ["Returned", items.length - open]].map((s) => h("div", { class: "stat" }, [h("b", { text: String(s[1]) }), h("span", { text: s[0] })])));
  if (view === "feed") {
    const f = items.filter(visible);
    f.sort((a, b) => $("fsort").value === "old" ? new Date(a.created_at) - new Date(b.created_at) : new Date(b.created_at) - new Date(a.created_at));
    const g = $("feed"); g.replaceChildren();
    if (!items.length) g.appendChild(h("div", { class: "panel", style: "grid-column:1/-1;text-align:center" }, [h("h3", { text: "No items posted yet" }), h("p", { class: "meta", text: "Be the first to report a lost or found item." })]));
    else if (!f.length) g.appendChild(h("p", { class: "meta", text: "No items match these filters." }));
    else f.forEach((i) => g.appendChild(card(i)));
  }
  if (view === "mine") {
    const mine = items.filter((i) => i.owner_id === me || i.claimer_id === me);
    const m = $("mine"); m.replaceChildren();
    if (!mine.length) m.appendChild(h("p", { class: "meta", text: "Nothing here yet. Items you post or claim will appear here." }));
    mine.forEach((i) => m.appendChild(card(i)));
    const box = $("matches"); box.replaceChildren();
    const mm = matches.filter((x) => (x.lost && x.lost.owner_id === me) || (x.found && x.found.owner_id === me));
    box.hidden = !mm.length;
    if (mm.length) {
      box.appendChild(h("h3", { text: "Possible matches", style: "margin-bottom:8px" }));
      mm.forEach((x) => box.appendChild(h("p", { class: "meta", text: "Lost: " + x.lost.name + " (" + x.lost.place + ")  and  Found: " + x.found.name + " (" + x.found.place + ")  similarity " + x.score.toFixed(2) + ". Always confirm with the hidden detail." })));
    }
  }
  if (view === "admin") {
    const r = $("adminRows"); r.replaceChildren();
    items.forEach((i) => r.appendChild(h("tr", {}, [
      h("td", { text: i.name + " (" + i.place + ")" }), h("td", { text: i.kind }), h("td", { text: stLabel(i) }),
      h("td", { text: ((i.owner && i.owner.name) || "-") + " · " + ago(i.created_at) }),
      h("td", {}, [h("div", { class: "acts", style: "margin:0;padding:0" }, [
        h("button", { class: "mini", text: i.status === "returned" ? "Reopen" : "Mark returned", onclick: () => act(i, () => call("set_status", { p_item: i.id, p_status: i.status === "returned" ? "open" : "returned" })) }),
        h("button", { class: "mini", text: "Delete", onclick: function () { if (this.dataset.c !== "1") { this.dataset.c = "1"; this.textContent = "Confirm"; return; } act(i, () => call("delete_item", { p_item: i.id })); } })])]),
    ])));
  }
}

/* ---------- report form ---------- */
function syncKind() { const f = $("kind").value === "found"; $("foundExtra").hidden = !f; $("whenLbl").textContent = f ? "Date found" : "Date lost"; $("place").placeholder = f ? "Where you found it" : "Where you last saw it"; }
$("kind").addEventListener("change", syncKind); syncKind();
function shrink(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { const s = Math.min(1, 900 / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); c.toBlob((b) => b ? res(b) : rej(new Error("Could not read the photo")), "image/jpeg", 0.8); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Could not read the photo")); };
    img.src = url;
  });
}
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = $("reportNote"), btn = $("submit"); btn.disabled = true; n.className = "note"; n.textContent = "Posting…";
  try {
    let path = null; const f = $("photo").files[0];
    if (f) { path = me + "/" + crypto.randomUUID() + ".jpg"; const { error } = await sb.storage.from("item-photos").upload(path, await shrink(f), { contentType: "image/jpeg" }); if (error) { path = null; n.textContent = "Photo failed, posting without it…"; } }
    const found = $("kind").value === "found";
    const id = await call("create_item", { p_kind: $("kind").value, p_name: $("name").value, p_category: $("cat").value, p_place: $("place").value, p_description: $("desc").value, p_happened_on: $("when").value || null, p_happened_time: found ? ($("ftime").value || null) : null, p_held_at: found ? $("held").value : null, p_handover: $("handover").value, p_photo_path: path, p_detail: $("hidden").value, p_finder_contact: found ? $("fcontact").value : null });
    if (CONFIG.AI_URL) fetch(CONFIG.AI_URL + "/index/" + id, { method: "POST", headers: { Authorization: "Bearer " + session.access_token } }).catch(() => {});
    $("form").reset(); syncKind(); n.textContent = "Posted. It is now in the shared feed.";
    await loadItems(); setTimeout(() => { n.textContent = ""; setView("feed"); }, 800);
  } catch (x) { n.className = "note err"; n.textContent = msgOf(x); }
  btn.disabled = false;
});

/* ---------- theme ---------- */
$("theme").addEventListener("click", () => { const r = document.documentElement, a = r.getAttribute("data-theme"), dark = a ? a === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; r.setAttribute("data-theme", dark ? "light" : "dark"); });

/* ---------- boot ---------- */
let subscribed = false;
async function onSession(s) {
  session = s;
  if (!s) { me = null; isAdmin = false; showAuth(); return; }
  me = s.user.id; $("v-auth").hidden = true; $("tabs").hidden = false; $("signout").hidden = false;
  const { data } = await sb.from("profiles").select("role").eq("id", me).single();
  isAdmin = !!data && data.role === "admin"; $("adminTab").hidden = !isAdmin;
  await Promise.all([loadItems(), loadMatches()]);
  if (!subscribed) { subscribe(); subscribed = true; }
  setView(location.hash.slice(1) || "feed");
}
sb.auth.onAuthStateChange((_e, s) => { onSession(s); });
sb.auth.getSession().then(({ data }) => onSession(data.session));
