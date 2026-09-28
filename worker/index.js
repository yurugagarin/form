/* FORM · dinlenme bildirimi sunucusu (Cloudflare Worker + Durable Object)

   NEDEN: uygulama bir web sayfası. iPhone ekran kilitlenince ya da başka uygulamaya
   geçilince sayfayı dondurur — kronometre durur, ses çalamaz. Web sayfasından ses
   çalmak da Spotify'ı kesiyordu. Tek yol gerçek bir push bildirimi: sayfa "90 sn
   sonra haber ver" der, bu sunucu süre dolunca Apple'ın bildirim servisine yollar.

   YAPI: tek bir Durable Object ("main") hem zamanlayıcıyı (alarm) hem de VAPID
   anahtarlarını tutar. Anahtarlar ilk istekte üretilir ve burada saklanır —
   kimsenin bir şifre tutması, bir yere yapıştırması gerekmez.

   UÇLAR
     GET  /vapid     → { key }                    tarayıcının abone olurken istediği açık anahtar
     POST /schedule  → { sub, delay, title, body } delay saniye sonra bildirim (aynı cihazın
                                                  bekleyen dinlenmesinin yerine geçer)
     POST /cancel    → { sub }                    bekleyen bildirimi iptal et
     GET  /health    → { ok, pending, last }       bekleyen bildirim sayısı, son gönderimin sonucu

   Web Push şifrelemesi (RFC 8291, aes128gcm) ve VAPID imzası (RFC 8292) WebCrypto ile
   burada yazıldı — dış kütüphane yok. */

const MAX_DELAY = 15 * 60;       /* en uzun dinlenme: 15 dk */
const MAX_JOBS = 50;             /* aynı anda bekleyen en çok bildirim */
const SUBJECT = 'https://yurugagarin.github.io/form/';

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const stub = env.TIMER.get(env.TIMER.idFromName('main'));
    const res = await stub.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  }
};

export class Timer {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const jobs = (await this.state.storage.get('jobs')) || {};
        const last = (await this.state.storage.get('last')) || null;
        return json({ ok: true, pending: Object.keys(jobs).length, last });
      }
      if (req.method === 'GET' && url.pathname === '/vapid') {
        const k = await this.keys();
        return json({ key: k.pub });
      }
      if (req.method === 'POST' && url.pathname === '/schedule') {
        const b = await req.json();
        const sub = cleanSub(b.sub);
        if (!sub) return json({ error: 'abonelik geçersiz' }, 400);
        const delay = Math.max(1, Math.min(MAX_DELAY, Math.round(+b.delay || 0)));
        const jobs = (await this.state.storage.get('jobs')) || {};
        const id = await hashId(sub.endpoint);
        jobs[id] = { sub, at: Date.now() + delay * 1000,
          title: String(b.title || 'Dinlenme bitti').slice(0, 80),
          body: String(b.body || '').slice(0, 160) };
        const ids = Object.keys(jobs);
        if (ids.length > MAX_JOBS) ids.sort((a, c) => jobs[a].at - jobs[c].at).slice(0, ids.length - MAX_JOBS).forEach(x => delete jobs[x]);
        await this.state.storage.put('jobs', jobs);
        await this.arm(jobs);
        return json({ ok: true, at: jobs[id].at });
      }
      if (req.method === 'POST' && url.pathname === '/cancel') {
        const b = await req.json();
        const sub = cleanSub(b.sub);
        if (!sub) return json({ error: 'abonelik geçersiz' }, 400);
        const jobs = (await this.state.storage.get('jobs')) || {};
        delete jobs[await hashId(sub.endpoint)];
        await this.state.storage.put('jobs', jobs);
        await this.arm(jobs);
        return json({ ok: true });
      }
      return json({ error: 'yok' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }

  async alarm() {
    const jobs = (await this.state.storage.get('jobs')) || {};
    const now = Date.now(), k = await this.keys();
    const due = Object.keys(jobs).filter(id => jobs[id].at <= now + 500);
    for (const id of due) {
      const j = jobs[id];
      delete jobs[id];
      let r;
      try {
        r = 'ok ' + await sendPush(j.sub, JSON.stringify({ title: j.title, body: j.body }), k);
      } catch (e) { r = String(e && e.message || e).slice(0, 200); /* abonelik düşmüşse iş zaten silindi */ }
      await this.state.storage.put('last', { t: now, r });
    }
    await this.state.storage.put('jobs', jobs);
    await this.arm(jobs);
  }

  async arm(jobs) {
    const ats = Object.values(jobs).map(j => j.at);
    if (!ats.length) { await this.state.storage.deleteAlarm(); return; }
    await this.state.storage.setAlarm(Math.min(...ats));
  }

  /* VAPID anahtarları: ilk istekte üretilir, bir daha değişmez (değişirse telefonların
     yeniden abone olması gerekir — bu yüzden bir kere saklanıp hep aynısı kullanılır). */
  async keys() {
    let k = await this.state.storage.get('vapid');
    if (!k) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      k = { jwk, pub: b64u(raw) };
      await this.state.storage.put('vapid', k);
    }
    return k;
  }
}

/* ---------- Web Push ---------- */
export async function sendPush(sub, payload, k) {
  const ep = new URL(sub.endpoint);
  const jwt = await vapidJWT(ep.origin, k.jwk);
  const body = await encrypt(sub, new TextEncoder().encode(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'vapid t=' + jwt + ', k=' + k.pub,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '120',
      'Urgency': 'high',
      'Topic': 'rest'
    },
    body
  });
  if (!res.ok) throw new Error('push ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.status;
}

export async function vapidJWT(aud, jwk) {
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: 'JWT', alg: 'ES256' });
  const claims = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT });
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  /* WebCrypto ECDSA imzası zaten r||s (64 bayt) — JWT'nin istediği biçim */
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(head + '.' + claims)));
  return head + '.' + claims + '.' + b64u(sig);
}

/* RFC 8291 — aes128gcm, tek kayıt */
export async function encrypt(sub, plain) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const te = new TextEncoder();
  const ikm = await hkdf(auth, ecdh, cat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key,
    cat(plain, new Uint8Array([2]))));          /* 0x02 = son kayıt ayracı */
  const head = new Uint8Array(16 + 4 + 1);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPub.length;
  return cat(head, asPub, ct);
}

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/* ---------- yardımcılar ---------- */
function cleanSub(s) {
  if (!s || typeof s.endpoint !== 'string' || !s.keys || !s.keys.p256dh || !s.keys.auth) return null;
  if (!/^https:\/\//.test(s.endpoint)) return null;
  return { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } };
}
async function hashId(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return b64u(h.slice(0, 12));
}
function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
function cat(...a) {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0; for (const x of a) { out.set(x, o); o += x.length; }
  return out;
}
export function b64u(u8) {
  let s = ''; for (const c of u8) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const b = atob(s), u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
