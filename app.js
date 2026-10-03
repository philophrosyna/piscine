import { API_URL, APP_VERSION } from './config.js';
import {
  DEFAULT_SETTINGS, EMPTY_DB, mergeDb, normalizeDb, liveSessions, prevSession, evaluate, streak, records,
  estSeconds, fmtDuration, ymd, pad, parse,
} from './shared.js';

const DB_KEY = 'piscine.db';
const CODE_KEY = 'piscine.code';
const LASTOK_KEY = 'piscine.lastok';
const DOW = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const DOW_LONG = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']; // index = jour JS - 1 (dimanche à la fin)

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => ymd(new Date());
const fmtDate = d => parse(d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShort = d => `${d.slice(8)}/${d.slice(5, 7)}`;
const num = v => String(v).replace('.', ',');

/* ---------- Données locales ---------- */
let dirty = true; // modifications locales pas encore envoyées au serveur

function loadDb() {
  try {
    const d = JSON.parse(localStorage.getItem(DB_KEY));
    if (d) return normalizeDb({ sessions: d.sessions || [], settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } });
  } catch (e) { /* données illisibles : on repart de zéro */ }
  return EMPTY_DB();
}
let db = loadDb();

function persist() { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* stockage indisponible */ } }
function save() { persist(); dirty = true; scheduleSync(); }

function saveSession(s) {
  const rec = { ...s, updatedAt: Date.now() };
  const i = db.sessions.findIndex(x => x.id === rec.id);
  if (i >= 0) db.sessions[i] = rec; else db.sessions.push(rec);
  save();
}
function deleteSession(id) {
  const i = db.sessions.findIndex(x => x.id === id);
  if (i >= 0) { db.sessions[i] = { id, date: db.sessions[i].date, deleted: true, updatedAt: Date.now() }; save(); }
}
function setSettings(patch) {
  db.settings = { ...db.settings, ...patch, updatedAt: Date.now() };
  save();
}
const sessionOn = date => liveSessions(db).find(s => s.date === date);

/* ---------- Interface ---------- */
let tab = 'cal';
let lastTab = 'cal'; // onglet où revenir depuis les paramètres
let month = today().slice(0, 7); // AAAA-MM

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}

function render() {
  const titles = { cal: 'Piscine', stats: 'Statistiques', settings: 'Paramètres' };
  $('#title').textContent = titles[tab];
  $('#view').innerHTML = tab === 'cal' ? viewCal() : tab === 'stats' ? viewStats() : viewSettings();
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const inSettings = tab === 'settings';
  $('#fab').hidden = inSettings;
  $('#gear').hidden = inSettings;
  $('#back').hidden = !inSettings;
}

/* ----- Calendrier ----- */
function nextGoal() {
  const list = liveSessions(db);
  const last = list[list.length - 1];
  if (!last) return `<div class="card goal"><div class="emoji">🏊</div><div><b>Bienvenue !</b><div class="note">Note ta première séance avec le bouton +.</div></div></div>`;
  return `<div class="card goal"><div class="big">${last.distance}<small> m</small></div>
    <div><b>Objectif de la prochaine séance</b><div class="note">Au moins autant que le ${esc(fmtDate(last.date))}</div></div></div>`;
}

function viewCal() {
  const [y, m] = month.split('-').map(Number);
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const dim = new Date(y, m, 0).getDate();
  const t = today();
  const pool = db.settings.poolDays || [];
  let cells = DOW.map(d => `<div class="dow">${d}</div>`).join('') + '<div class="day blank"></div>'.repeat(offset);
  for (let d = 1; d <= dim; d++) {
    const date = `${month}-${pad(d)}`;
    const s = sessionOn(date);
    const isPool = pool.includes(new Date(y, m - 1, d).getDay());
    const cls = ['day', date === t ? 'today' : '', isPool ? 'pool' : '', s ? evaluate(db, s) : ''].join(' ');
    cells += `<button class="${cls}" data-act="day" data-date="${date}"><span class="n">${d}</span>${s ? `<span class="dist">${s.distance}</span><span class="m">m</span>` : '<span></span><span></span>'}</button>`;
  }
  const inMonth = liveSessions(db).filter(s => s.date.startsWith(month));
  const total = inMonth.reduce((n, s) => n + s.distance, 0);
  const best = inMonth.reduce((n, s) => Math.max(n, s.distance), 0);
  const label = new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return `${nextGoal()}
    <div class="monthbar"><button data-act="month" data-d="-1" aria-label="Mois précédent">‹</button><b>${esc(label)}</b><button data-act="month" data-d="1" aria-label="Mois suivant">›</button></div>
    <div class="grid">${cells}</div>
    <div class="legend"><span><i style="background:var(--ok-bg)"></i>objectif atteint</span><span><i style="background:var(--down-bg)"></i>en recul</span><span><i style="background:var(--first-bg)"></i>1re séance</span><span><i style="border-style:dashed;border-color:var(--accent)"></i>jour habituel</span></div>
    <div class="card stats3"><div><b>${inMonth.length}</b><span>séance${inMonth.length > 1 ? 's' : ''}</span></div><div><b>${total} m</b><span>au total</span></div><div><b>${best} m</b><span>meilleure</span></div></div>`;
}

/* ----- Statistiques ----- */
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function chart(points, unit) {
  if (!points.length) return '<div class="empty">Pas encore de données.</div>';
  const W = 320, H = 160, pl = 36, pr = 10, pt = 12, pb = 24;
  const top = niceMax(Math.max(...points.map(p => p.v), 1));
  const x = i => points.length === 1 ? (pl + W - pr) / 2 : pl + i * (W - pl - pr) / (points.length - 1);
  const y = v => pt + (H - pt - pb) * (1 - v / top);
  let max = -1;
  const dots = points.map((p, i) => {
    const rec = p.v > max; max = Math.max(max, p.v);
    return `<circle class="dot ${rec ? 'rec' : ''}" cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.2"><title>${esc(p.label)} : ${p.v} ${unit}</title></circle>`;
  }).join('');
  const grid = [0, top / 2, top].map(v => `<line class="axis" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 4}" y="${y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`).join('');
  const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const line = points.length > 1
    ? `<polygon class="area" points="${x(0).toFixed(1)},${y(0)} ${pts} ${x(points.length - 1).toFixed(1)},${y(0)}"/><polyline class="line" points="${pts}"/>` : '';
  const first = points[0].label, last = points[points.length - 1].label;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution (${unit})">${grid}${line}${dots}
    <text x="${pl}" y="${H - 6}">${esc(first)}</text>${points.length > 1 ? `<text x="${W - pr}" y="${H - 6}" text-anchor="end">${esc(last)}</text>` : ''}</svg>
    <div class="note">Points verts = nouveau record.</div>`;
}

function viewStats() {
  const list = liveSessions(db);
  if (!list.length) return '<div class="card empty">Les statistiques apparaîtront dès ta première séance.</div>';
  const recent = list.slice(-30);
  const rec = records(db);
  const totalDist = list.reduce((n, s) => n + s.distance, 0);
  const withSec = recent.filter(s => s.seconds != null);

  const byMonth = {};
  for (const s of list) {
    const k = s.date.slice(0, 7);
    (byMonth[k] ||= { n: 0, d: 0 }).n++;
    byMonth[k].d += s.distance;
  }
  const rows = Object.keys(byMonth).sort().reverse().map(k => {
    const label = new Date(Number(k.slice(0, 4)), Number(k.slice(5)) - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    return `<tr><td>${esc(label)}</td><td>${byMonth[k].n}</td><td>${byMonth[k].d} m</td><td>${Math.round(byMonth[k].d / byMonth[k].n)} m</td></tr>`;
  }).join('');

  return `<div class="card stats3">
      <div><b>${list.length}</b><span>séances</span></div><div><b>${totalDist} m</b><span>au total</span></div><div><b>${streak(db)}</b><span>d'affilée sans recul</span></div></div>
    <div class="card"><h2>Records</h2>
      <div class="rec-row"><span class="ico">🏆</span><div>Distance : <b>${rec.dist.distance} m</b><div class="note">${esc(fmtDate(rec.dist.date))}</div></div></div>
      <div class="rec-row"><span class="ico">🫧</span><div>Tête sous l'eau : ${rec.str ? `<b>${esc(fmtDuration(rec.str.seconds))}</b><div class="note">${esc(fmtDate(rec.str.date))}</div>` : '<span class="note">pas encore noté</span>'}</div></div></div>
    <div class="card"><h2>Distance par séance (m)</h2>${chart(recent.map(s => ({ label: fmtShort(s.date), v: s.distance })), 'm')}</div>
    <div class="card"><h2>Temps tête sous l'eau (s)</h2>${chart(withSec.map(s => ({ label: fmtShort(s.date), v: s.seconds })), 's')}</div>
    <div class="card"><h2>Par mois</h2><table class="months"><tr><th>Mois</th><th>Séances</th><th>Total</th><th>Moyenne</th></tr>${rows}</table></div>`;
}

/* ----- Réglages ----- */
function viewSettings() {
  const connected = !!getCode();
  const pool = db.settings.poolDays || [];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const chips = order.map((d, i) => `<button class="chip ${pool.includes(d) ? 'on' : ''}" data-act="pooldow" data-d="${d}">${DOW_LONG[i]}</button>`).join('');
  const syncCard = connected
    ? `<div class="note">${esc(syncMsg || 'Synchronisation en cours…')}</div>
       <div class="btns"><button class="btn sec" data-act="sync-now">Synchroniser maintenant</button><button class="btn sec" data-act="disconnect">Déconnecter</button></div>`
    : `<div class="note">${API_URL ? 'Entre ton code d\'accès pour sauvegarder et synchroniser tes séances.' : 'Le serveur n\'est pas encore configuré : les données restent sur cet appareil.'}${syncMsg ? '<br><b>' + esc(syncMsg) + '</b>' : ''}</div>
       ${API_URL ? '<label for="code">Code d\'accès</label><input id="code" type="password" autocomplete="off"><div class="btns"><button class="btn" data-act="connect">Connecter</button></div>' : ''}`;
  return `<div class="card"><h2>Estimation en secondes</h2>
      <label for="sps">Secondes par mouvement de brasse</label>
      <input id="sps" type="number" inputmode="decimal" step="0.1" min="0.5" max="10" value="${db.settings.secPerStroke}" data-act-change="sps">
      <div class="note">Pour calibrer : chronomètre-toi une fois.</div>
      <div class="row"><div><label for="cal-n">Mouvements comptés</label><input id="cal-n" type="number" inputmode="numeric" min="1"></div>
      <div><label for="cal-s">en … secondes</label><input id="cal-s" type="number" inputmode="decimal" min="1"></div></div>
      <div class="btns"><button class="btn sec" data-act="calibrate">Calculer et enregistrer</button></div></div>
    <div class="card"><h2>Jours habituels</h2><div class="chips">${chips}</div><div class="note">Repérés en pointillés sur le calendrier. Tu peux noter une séance n'importe quel jour.</div></div>
    <div class="card"><h2>Synchronisation</h2>${syncCard}</div>
    <div class="card"><h2>Sauvegarde en fichier</h2><div class="note">Une copie de secours que tu peux garder ailleurs.</div>
      <div class="btns"><button class="btn sec" data-act="export">Exporter</button><button class="btn sec" data-act="import">Importer</button></div>
      <input id="importfile" type="file" accept="application/json,.json" hidden></div>
    <div class="card"><h2>Version</h2><div class="note">Piscine v${APP_VERSION}</div><div class="btns"><button class="btn sec" data-act="update">Rechercher une mise à jour</button></div></div>`;
}

/* ---------- Formulaire de séance ---------- */
function openForm(date) {
  const s = sessionOn(date);
  const sps = db.settings.secPerStroke;
  const dlg = $('#dlg');
  dlg.innerHTML = `<form id="sform"><h2>${s ? 'Modifier la séance' : 'Nouvelle séance'}</h2>
    <label for="f-date">Date</label><input id="f-date" type="date" value="${esc(date)}" max="${today()}" required>
    <div class="hint" id="h-goal"></div>
    <label for="f-dist">Distance nagée (m)</label><input id="f-dist" type="number" inputmode="numeric" min="1" step="1" value="${s ? s.distance : ''}" required>
    <div class="hint" id="h-eval" hidden></div>
    <label for="f-sec">Temps tête sous l'eau (secondes)</label><input id="f-sec" type="number" inputmode="numeric" min="0" step="1" value="${s?.seconds ?? ''}">
    <div class="row conv"><div><label for="f-str">…ou mouvements de brasse</label><input id="f-str" type="number" inputmode="numeric" min="0" step="1"></div><div class="note" id="h-sec">Convertis à ${num(sps)} s par mouvement</div></div>
    <label for="f-note">Note (facultatif)</label><textarea id="f-note">${esc(s?.note || '')}</textarea>
    <div class="btns"><button type="button" class="btn sec" data-act="close">Annuler</button><button class="btn" type="submit">Enregistrer</button></div>
    ${s ? '<div class="btns"><button type="button" class="btn danger" data-act="delete-session">Supprimer cette séance</button></div>' : ''}
  </form>`;
  dlg.dataset.orig = s ? s.id : '';
  dlg.dataset.sps = sps;
  dlg.showModal();
  refreshHints();
}

function refreshHints() {
  const date = $('#f-date').value;
  const prev = date ? prevSession(db, date) : null;
  $('#h-goal').textContent = prev
    ? `Objectif : au moins ${prev.distance} m (séance du ${fmtDate(prev.date)})`
    : 'Première séance : pas d\'objectif, note ta distance !';
  const dist = Number($('#f-dist').value);
  const ev = $('#h-eval');
  if (prev && dist > 0) {
    ev.hidden = false;
    ev.className = 'hint ' + (dist >= prev.distance ? 'ok' : 'down');
    ev.textContent = dist >= prev.distance
      ? `✅ Objectif atteint${dist > prev.distance ? ` (+${dist - prev.distance} m)` : ''}`
      : `⚠️ ${prev.distance - dist} m de moins que la séance précédente`;
  } else ev.hidden = true;
  const sec = $('#f-sec').value;
  $('#h-sec').textContent = sec !== '' ? `= ${fmtDuration(Math.round(Number(sec)))}` : `Convertis à ${num(Number($('#dlg').dataset.sps))} s par mouvement`;
}

function submitForm(e) {
  e.preventDefault();
  const dlg = $('#dlg');
  const date = $('#f-date').value;
  const distance = Math.round(Number($('#f-dist').value));
  if (!date || !(distance > 0)) return;
  const secRaw = $('#f-sec').value;
  const seconds = secRaw === '' ? null : Math.max(0, Math.round(Number(secRaw)));
  const orig = dlg.dataset.orig;
  if (date !== orig && sessionOn(date) && !confirm(`Une séance existe déjà le ${fmtDate(date)}. La remplacer ?`)) return;

  const before = records({ sessions: db.sessions.filter(x => x.id !== orig && x.id !== date) });
  if (orig && orig !== date) deleteSession(orig);
  saveSession({ id: date, date, distance, seconds, note: $('#f-note').value.trim() });
  dlg.close();
  const rec = [];
  if (!before.dist || distance > before.dist.distance) rec.push('distance');
  if (seconds != null && (!before.str || seconds > before.str.seconds)) rec.push('apnée');
  toast(rec.length && before.dist ? `🏆 Nouveau record de ${rec.join(' et ')} !` : 'Séance enregistrée');
  month = date.slice(0, 7);
  render();
}

/* ---------- Synchronisation ---------- */
const getCode = () => { try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; } };
const setCode = v => { try { v ? localStorage.setItem(CODE_KEY, v) : localStorage.removeItem(CODE_KEY); } catch (e) { /* ignore */ } };

let syncMsg = '';
let syncing = false, syncAgain = false, syncTimer = null;
let serverRev = null; // dernière version du serveur connue
let lastOk = 0;
try { lastOk = Number(localStorage.getItem(LASTOK_KEY)) || 0; } catch (e) { /* ignore */ }
let syncFails = 0, failSince = 0;

function markSync(ok) {
  if (ok) {
    syncFails = 0; failSince = 0; lastOk = Date.now();
    try { localStorage.setItem(LASTOK_KEY, String(lastOk)); } catch (e) { /* ignore */ }
  } else {
    syncFails++;
    if (!failSince) failSince = Date.now();
  }
  updateBanner();
}
const ago = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} j`; };
function updateBanner() {
  const b = $('#banner');
  const since = lastOk || failSince;
  const show = !!getCode() && syncFails > 0 && since && Date.now() - since >= 10 * 60000;
  b.hidden = !show;
  if (show) b.innerHTML = `<span>⚠ Pas de synchronisation depuis ${ago(Date.now() - since)}.${dirty ? ' Tes dernières séances ne sont que sur cet appareil.' : ''}</span><button data-act="sync-now">Réessayer</button>`;
}

class AuthError extends Error {}
class RateError extends Error {}

async function api(path, body) {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + getCode(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) throw new AuthError();
  if (res.status === 429) throw new RateError();
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

function scheduleSync() {
  if (!getCode() || !API_URL) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 1500);
}

async function sync() {
  if (!getCode() || !API_URL) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  const sending = dirty;
  dirty = false;
  try {
    const r = await api('/api/sync', { rev: serverRev, data: sending || serverRev === null ? db : undefined });
    serverRev = r.rev;
    markSync(true);
    if (r.data) {
      db = normalizeDb(mergeDb(db, r.data));
      persist();
      if (!$('#dlg').open) render();
    }
    const d = new Date();
    syncMsg = `Synchronisé à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (e) {
    dirty = dirty || sending;
    if (!(e instanceof AuthError)) markSync(false);
    if (e instanceof AuthError) { setCode(''); syncMsg = 'Code d\'accès refusé.'; }
    else if (e instanceof RateError) syncMsg = 'Trop d\'essais : réessaie dans 15 minutes.';
    else syncMsg = 'Hors connexion (les données sont gardées sur cet appareil).';
  } finally {
    syncing = false;
    if (tab === 'settings' && !$('#dlg').open) {
      const a = document.activeElement;
      if (!a || !['INPUT', 'TEXTAREA'].includes(a.tagName)) render();
    }
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

/* ---------- Export / import ---------- */
async function exportFile() {
  const name = `piscine-${today()}.json`;
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Sauvegarde Piscine' }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importFile(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.sessions)) throw new Error('format');
    const now = Date.now();
    const incoming = { sessions: d.sessions.filter(s => s && s.id && s.date).map(s => ({ ...s, updatedAt: now })), settings: db.settings };
    if (!confirm(`Importer ${incoming.sessions.filter(s => !s.deleted).length} séance(s) ? Elles remplaceront les séances du même jour.`)) return;
    db = normalizeDb(mergeDb(db, incoming));
    save(); render();
    toast('Sauvegarde importée');
  } catch (e) { toast('Fichier non reconnu'); }
}

/* ---------- Actions ---------- */
const actions = {
  day: el => openForm(el.dataset.date),
  month: el => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + Number(el.dataset.d), 1);
    month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    render();
  },
  close: () => $('#dlg').close(),
  'delete-session': () => {
    const id = $('#dlg').dataset.orig;
    if (id && confirm('Supprimer cette séance ?')) { deleteSession(id); $('#dlg').close(); render(); toast('Séance supprimée'); }
  },
  pooldow: el => {
    const d = Number(el.dataset.d);
    const cur = db.settings.poolDays || [];
    setSettings({ poolDays: cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d] });
    render();
  },
  calibrate: () => {
    const n = Number($('#cal-n').value), s = Number($('#cal-s').value);
    if (!(n > 0 && s > 0)) { toast('Renseigne les deux valeurs'); return; }
    const v = Math.round(s / n * 10) / 10;
    setSettings({ secPerStroke: v });
    render();
    toast(`${num(v)} s par mouvement enregistré`);
  },
  connect: () => {
    const v = $('#code').value.trim();
    if (!v) return;
    setCode(v); syncMsg = ''; serverRev = null; dirty = true; sync(); render();
  },
  disconnect: () => { if (confirm('Déconnecter la synchronisation ? Les séances restent sur cet appareil.')) { setCode(''); syncMsg = ''; render(); } },
  'sync-now': () => { dirty = true; sync(); },
  export: () => exportFile(),
  import: () => $('#importfile').click(),
  update: async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
      for (const k of await caches.keys()) await caches.delete(k);
    } catch (e) { /* ignore */ }
    location.reload();
  },
};

document.addEventListener('click', e => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { tab = lastTab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest('#gear')) { tab = 'settings'; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest('#back')) { tab = lastTab; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest('#fab')) { openForm(today()); return; }
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});
document.addEventListener('submit', e => { if (e.target.id === 'sform') submitForm(e); });
document.addEventListener('input', e => {
  if (e.target.id === 'f-str') { // conversion mouvements -> secondes (seules les secondes sont gardées)
    const n = e.target.value;
    $('#f-sec').value = n === '' ? '' : estSeconds(n, $('#dlg').dataset.sps);
  }
  if (['f-date', 'f-dist', 'f-str', 'f-sec'].includes(e.target.id)) refreshHints();
});
document.addEventListener('change', e => {
  if (e.target.id === 'f-date') refreshHints();
  if (e.target.id === 'sps') {
    const v = Number(e.target.value);
    if (v >= 0.5 && v <= 10) setSettings({ secPerStroke: v });
    else { e.target.value = db.settings.secPerStroke; toast('Valeur entre 0,5 et 10'); }
  }
  if (e.target.id === 'importfile' && e.target.files[0]) { importFile(e.target.files[0]); e.target.value = ''; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', () => sync());

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* hors HTTPS ou non supporté */ });

render();
sync();
