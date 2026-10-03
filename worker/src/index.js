import { mergeDb, EMPTY_DB } from '../../shared.js';

const TZ = 'Europe/Paris';
const ALLOWED_ORIGINS = ['https://philophrosyna.github.io', 'http://127.0.0.1:8766', 'http://localhost:8766'];
const MAX_BODY = 512 * 1024;
const BACKUP_TTL = 60 * 60 * 24 * 45; // 45 jours d'historique
const MAX_FAILS = 5;
const FAIL_TTL = 15 * 60;

/* ---------- Utilitaires ---------- */
function cors(req) {
  const origin = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });

// Comparaison à temps constant du code d'accès (via empreintes SHA-256).
async function authorized(req, env) {
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!env.ACCESS_CODE || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.ACCESS_CODE)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const getJson = async (env, key, fallback) => (await env.KV.get(key, 'json')) ?? fallback;
const putJson = (env, key, value, opts) => env.KV.put(key, JSON.stringify(value), opts);
const parisDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/* ---------- API ---------- */
async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const url = new URL(req.url);
  if (req.method !== 'POST') return json(req, { error: 'not found' }, 404);

  // Protection contre les essais de codes : 5 échecs par adresse IP = blocage 15 minutes.
  // Le compteur n'est écrit que tant que la limite n'est pas atteinte (ménage le quota d'écritures).
  const ip = req.headers.get('CF-Connecting-IP') || 'inconnu';
  const failKey = `fail:${ip}`;
  const fails = Number(await env.KV.get(failKey)) || 0;
  if (fails >= MAX_FAILS) return json(req, { error: 'too many attempts' }, 429);
  if (!(await authorized(req, env))) {
    await env.KV.put(failKey, String(fails + 1), { expirationTtl: FAIL_TTL });
    return json(req, { error: 'unauthorized' }, 401);
  }

  const text = await req.text();
  if (text.length > MAX_BODY) return json(req, { error: 'too large' }, 413);
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (e) { return json(req, { error: 'bad json' }, 400); }

  // Synchro : le client envoie ses données seulement s'il a des modifications (data) et la version
  // du serveur qu'il connaît (rev). Si rien n'a changé des deux côtés, la réponse est minuscule.
  if (url.pathname === '/api/sync') {
    const stored = await getJson(env, 'data', EMPTY_DB());
    let rev = stored._rev || 0;
    let merged = stored;
    let changed = false;
    if (body.data) {
      const m = mergeDb(stored, body.data);
      const { _rev, ...before } = stored;
      if (JSON.stringify(m) !== JSON.stringify(before)) {
        rev = Date.now();
        merged = { ...m, _rev: rev };
        changed = true;
        await putJson(env, 'data', merged);
        // Une sauvegarde par jour (au plus), conservée 45 jours.
        const key = `backup:${parisDate()}`;
        if (!(await env.KV.get(key))) await putJson(env, key, merged, { expirationTtl: BACKUP_TTL });
      }
    }
    if (body.rev != null && body.rev === rev && !changed) return json(req, { rev, unchanged: true });
    const { _rev, ...data } = merged;
    return json(req, { rev, data });
  }

  return json(req, { error: 'not found' }, 404);
}

export default {
  fetch: (req, env) => handle(req, env).catch(() => json(req, { error: 'server error' }, 500)),
};
