// Logique commune à l'appli (navigateur) et au serveur (Worker Cloudflare).

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };

// poolDays : jours habituels de piscine (0 = dimanche … 6 = samedi) ; lundi et mercredi par défaut.
export const DEFAULT_SETTINGS = { secPerStroke: 2, poolDays: [1, 3], updatedAt: 0 };

export const EMPTY_DB = () => ({ sessions: [], settings: { ...DEFAULT_SETTINGS } });

/* ---------- Fusion (la modification la plus récente gagne) ---------- */
const newer = (a, b) => (b?.updatedAt || 0) > (a?.updatedAt || 0);

function mergeById(a = [], b = []) {
  const map = new Map();
  for (const x of a) map.set(x.id, x);
  for (const x of b) {
    const cur = map.get(x.id);
    if (!cur || newer(cur, x)) map.set(x.id, x);
  }
  return [...map.values()];
}

export function mergeDb(a, b) {
  return {
    sessions: mergeById(a.sessions, b.sessions),
    settings: newer(a.settings, b.settings) ? { ...DEFAULT_SETTINGS, ...b.settings } : { ...DEFAULT_SETTINGS, ...(a.settings || {}) },
  };
}

/* ---------- Séances ---------- */
// Une séance par jour : l'identifiant est la date (AAAA-MM-JJ).
// { id, date, distance (m), seconds (temps tête sous l'eau en secondes, ou null), note, updatedAt, deleted? }
// Les mouvements de brasse ne sont pas conservés : ils sont convertis en secondes à la saisie.
export const liveSessions = db => (db.sessions || []).filter(s => !s.deleted).sort((a, b) => a.date.localeCompare(b.date));

// Dernière séance strictement avant une date.
export function prevSession(db, date) {
  let found = null;
  for (const s of liveSessions(db)) if (s.date < date) found = s;
  return found;
}

// 'first' (pas de séance précédente), 'ok' (au moins autant que la précédente) ou 'down' (en recul).
export function evaluate(db, s) {
  const prev = prevSession(db, s.date);
  if (!prev) return 'first';
  return s.distance >= prev.distance ? 'ok' : 'down';
}

// Nombre de séances d'affilée, jusqu'à la dernière, sans régression.
export function streak(db) {
  const list = liveSessions(db);
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    n++;
    if (i > 0 && list[i].distance < list[i - 1].distance) return n - 1;
  }
  return n;
}

export const estSeconds = (strokes, sps) => strokes == null || strokes === '' ? null : Math.round(Number(strokes) * Number(sps));

// Anciennes séances saisies en mouvements : converties en secondes (et le champ mouvements retiré).
export function normalizeSession(s, defaultSps) {
  if (s.strokes === undefined && s.secPerStroke === undefined) return s;
  const { strokes, secPerStroke, ...rest } = s;
  if (rest.seconds == null && strokes != null) rest.seconds = estSeconds(strokes, secPerStroke ?? defaultSps);
  return rest;
}
export const normalizeDb = db => ({ ...db, sessions: (db.sessions || []).map(s => normalizeSession(s, db.settings?.secPerStroke ?? DEFAULT_SETTINGS.secPerStroke)) });

export function fmtDuration(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${sec} s`;
  return `${Math.floor(sec / 60)} min ${pad(sec % 60)} s`;
}

export function records(db) {
  let dist = null, str = null;
  for (const s of liveSessions(db)) {
    if (!dist || s.distance > dist.distance) dist = s;
    if (s.seconds != null && (!str || s.seconds > str.seconds)) str = s;
  }
  return { dist, str };
}
