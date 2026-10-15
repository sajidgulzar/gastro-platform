'use strict';
/*
 * Gastro-Plattform: Server ohne externe Abhängigkeiten.
 * Benötigt Node.js 22.5 oder neuer (nutzt das eingebaute SQLite).
 * Start: node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === '1';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Geheimer Schlüssel für Sitzungen: aus Umgebung oder einmalig erzeugt und gespeichert */
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(f)) SECRET = fs.readFileSync(f, 'utf8').trim();
  else { SECRET = crypto.randomBytes(48).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}

/* ---------- Datenbank ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'gastro.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pass TEXT NOT NULL, role TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shops(
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL,
  data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, nr TEXT NOT NULL, status TEXT NOT NULL,
  data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id, created);
`);
const q = (sql) => db.prepare(sql);
const nid = () => crypto.randomBytes(9).toString('base64url');

/* ---------- Master-Panel: Schema-Erweiterungen ---------- */
function addCol(t, c, def) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  if (!cols.some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
}
addCol('shops', 'status', "TEXT NOT NULL DEFAULT 'active'");
addCol('shops', 'plan', "TEXT NOT NULL DEFAULT 'starter'");
addCol('shops', 'valid_until', 'INTEGER');
addCol('shops', 'notes', "TEXT NOT NULL DEFAULT ''");
db.exec(`
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, user_name TEXT,
  action TEXT NOT NULL, target TEXT, detail TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
`);
const DEFAULT_PLANS = [
  { key: 'starter', name: 'Starter', priceCents: 4990 },
  { key: 'pro', name: 'Pro', priceCents: 7990 },
  { key: 'web_app', name: 'Web + App', priceCents: 9990 }
];
function getSetting(key, fallback) {
  const r = q('SELECT value FROM settings WHERE key=?').get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
function setSetting(key, val) {
  q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(val));
}
function logAudit(u, action, target, detail) {
  try {
    q('INSERT INTO audit(ts,user_id,user_name,action,target,detail) VALUES(?,?,?,?,?,?)')
      .run(Date.now(), u && u.id ? u.id : null, u ? (u.name || u.email || '') : '', action, String(target || '').slice(0, 200), JSON.stringify(detail || {}));
  } catch (e) { console.error('audit', e.message); }
}
/* Wirksamer Status: ein aktiver Shop mit abgelaufenem Abo gilt automatisch als "expired" */
const effStatus = (r) => (r.status === 'active' && r.valid_until && r.valid_until < Date.now()) ? 'expired' : r.status;
const maintenance = () => { const m = getSetting('maintenance', { on: false, message: '' }); return m.on ? (m.message || 'Wartungsarbeiten. Bitte später erneut versuchen.') : null; };

/* Automatische tägliche Sicherung (behält die letzten 14) */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
function makeBackup() {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  const name = `gastro-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.db`;
  db.exec(`VACUUM INTO '${path.join(BACKUP_DIR, name).replace(/'/g, "''")}'`);
  const all = fs.readdirSync(BACKUP_DIR).filter(f => /^gastro-\d{8}-\d{6}\.db$/.test(f)).sort();
  while (all.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
  return name;
}
function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter(f => /^gastro-\d{8}-\d{6}\.db$/.test(f)).sort().reverse()
    .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, bytes: st.size, time: st.mtimeMs }; });
}
function autoBackup() {
  try {
    const today = new Date().toDateString();
    const last = listBackups()[0];
    if (!last || new Date(last.time).toDateString() !== today) { const n = makeBackup(); logAudit(null, 'system.backup_auto', n, {}); }
  } catch (e) { console.error('backup', e.message); }
}
setTimeout(autoBackup, 5000).unref();
setInterval(autoBackup, 3600e3).unref();
const STARTED = Date.now();

/* ---------- Sicherheit ---------- */
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [s, h] = String(stored || '').split(':');
  if (!s || !h) { crypto.scryptSync(pw, 'x', 64); return false; }
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sign(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
}
function verify(tok) {
  const [p, s] = String(tok || '').split('.');
  if (!p || !s) return null;
  const e = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  const a = Buffer.from(s), b = Buffer.from(e);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() ? o : null; } catch { return null; }
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(x => { const i = x.indexOf('='); if (i > 0) out[x.slice(0, i).trim()] = decodeURIComponent(x.slice(i + 1).trim()); });
  return out;
}
function sessionCookie(uid) {
  const maxAge = 14 * 24 * 3600;
  return `gs=${encodeURIComponent(sign({ u: uid, e: Date.now() + maxAge * 1000 }))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (SECURE_COOKIE ? '; Secure' : '');
}
const clearCookie = () => 'gs=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (SECURE_COOKIE ? '; Secure' : '');
function authUser(req) {
  const t = verify(cookies(req).gs);
  if (!t) return null;
  return q('SELECT id,email,name,role FROM users WHERE id=?').get(t.u) || null;
}
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
function clientIp(req) {
  if (TRUST_PROXY) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
  return req.socket.remoteAddress || '?';
}

/* ---------- HTTP-Helfer ---------- */
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function send(res, code, obj, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC, extra || {}));
  res.end(JSON.stringify(obj));
}
const fail = (res, code, msg) => send(res, code, { error: msg });
function readBody(req, limit) {
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > limit) { no(Object.assign(new Error('Anfrage zu groß'), { status: 413 })); req.destroy(); return; } c.push(d); });
    req.on('end', () => { try { const s = Buffer.concat(c).toString('utf8'); ok(s ? JSON.parse(s) : {}); } catch { no(Object.assign(new Error('Ungültige Daten'), { status: 400 })); } });
    req.on('error', no);
  });
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

function slugify(s) {
  const t = String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return t || 'shop';
}
function uniqueSlug(base, exceptId) {
  let s = base, i = 2;
  while (true) {
    const r = q('SELECT id FROM shops WHERE slug=?').get(s);
    if (!r || r.id === exceptId) return s;
    s = base.slice(0, 36) + '-' + i++;
  }
}
const cleanData = (d) => { const o = Object.assign({}, d); delete o.id; delete o.cart; delete o.orders; delete o.slug; delete o.ownerName; delete o.ownerId; return o; };

/* ---------- Live-Benachrichtigung (SSE) ---------- */
const clients = new Set();
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();
function broadcast(shopRow, order) {
  for (const c of clients) {
    if (c.u.role === 'admin' || c.u.id === shopRow.owner) {
      c.res.write('event: order\ndata: ' + JSON.stringify({ shopId: shopRow.id, nr: order.nr }) + '\n\n');
    }
  }
}

/* ---------- Bestellung serverseitig prüfen und berechnen ---------- */
function computeOrder(shop, b) {
  const mode = b.mode === 'pickup' ? 'pickup' : 'delivery';
  const items = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
  if (!items.length) throw new Error('Warenkorb ist leer');
  const lines = [];
  let sub = 0;
  for (const it of items) {
    const p = (shop.products || []).find(x => x.id === it.pid);
    const qty = Math.floor(Number(it.qty));
    if (!p || !(qty >= 1 && qty <= 50)) throw new Error('Ungültiger Artikel');
    const sel = it.sel && typeof it.sel === 'object' ? it.sel : {};
    let unit = Number(p.price) || 0; const names = [];
    for (const gid of (p.groups || [])) {
      const g = (shop.groups || []).find(x => x.id === gid);
      if (!g) continue;
      const chosen = Array.isArray(sel[gid]) ? sel[gid] : [];
      if (!g.multi && chosen.length > 1) throw new Error('Ungültige Auswahl bei ' + g.name);
      if (g.req && !chosen.length) throw new Error('Bitte wählen: ' + g.name + ' bei ' + p.name);
      for (const oid of new Set(chosen)) {
        const o = g.opts.find(x => x.id === oid);
        if (!o) throw new Error('Ungültige Option');
        unit += Number(o.price) || 0; names.push(o.name);
      }
    }
    unit = money(unit);
    sub += unit * qty;
    lines.push({ n: p.name, qty, opts: names, unit });
  }
  sub = money(sub);
  let fee = 0, min = 0, addr = '', plz = '';
  if (mode === 'delivery') {
    const street = str(b.street, 120), city = str(b.city, 80);
    plz = str(b.plz, 5).replace(/\D/g, '');
    if (!street || plz.length < 5 || !city) throw new Error('Bitte Adresse vollständig angeben');
    addr = street + ', ' + plz + ' ' + city;
    const zones = shop.zones || [];
    let zone = null;
    if (zones.length) {
      zone = zones.find(z => { const k = String(z.plz).trim(); return k.endsWith('*') ? plz.startsWith(k.slice(0, -1)) : k === plz; });
      if (!zone) throw new Error('Leider liefern wir nicht in diese PLZ');
    }
    min = zone ? Number(zone.min) || 0 : Number(shop.minOrder) || 0;
    fee = zone ? Number(zone.fee) || 0 : Number(shop.fee) || 0;
    if ((Number(shop.freeFrom) || 0) > 0 && sub >= shop.freeFrom) fee = 0;
    if (sub < min) throw new Error('Mindestbestellwert ' + min.toFixed(2).replace('.', ',') + ' € nicht erreicht');
  }
  const f = shop.freebie || {};
  const gift = f.on && f.threshold > 0 && f.name && sub >= f.threshold ? str(f.name, 100) : '';
  return { mode, items: lines, sub, fee: money(fee), total: money(sub + fee), gift, addr, plz,
    name: str(b.name, 80), tel: str(b.tel, 40), pay: str(b.pay, 40), note: str(b.note, 500) };
}

/* ---------- Routen ---------- */
const STATUS = ['neu', 'zubereitung', 'bereit', 'erledigt', 'storniert'];
async function api(req, res, p, url) {
  const m = req.method;
  if (m !== 'GET' && m !== 'HEAD') {
    if (!sameOrigin(req)) return fail(res, 403, 'Anfrage abgelehnt');
    if (!String(req.headers['content-type'] || '').includes('application/json')) return fail(res, 415, 'JSON erwartet');
  }
  const ip = clientIp(req);
  let mt;

  /* öffentlich */
  if ((mt = p.match(/^\/api\/public\/shops\/([a-z0-9-]+)$/)) && m === 'GET') {
    const r = q('SELECT id,slug,data,status,valid_until FROM shops WHERE slug=?').get(mt[1]);
    if (!r) return fail(res, 404, 'Shop nicht gefunden');
    if (maintenance()) return fail(res, 503, maintenance());
    if (effStatus(r) !== 'active') return fail(res, 403, 'Dieser Shop ist derzeit nicht verfügbar.');
    return send(res, 200, { id: r.id, slug: r.slug, data: JSON.parse(r.data) });
  }
  if ((mt = p.match(/^\/api\/public\/shops\/([a-z0-9-]+)\/orders$/)) && m === 'POST') {
    if (limited('order:' + ip, 15, 600e3)) return fail(res, 429, 'Zu viele Bestellungen. Bitte später erneut versuchen.');
    const r = q('SELECT * FROM shops WHERE slug=?').get(mt[1]);
    if (!r) return fail(res, 404, 'Shop nicht gefunden');
    if (maintenance()) return fail(res, 503, maintenance());
    if (effStatus(r) !== 'active') return fail(res, 403, 'Dieser Shop nimmt derzeit keine Bestellungen an.');
    const body = await readBody(req, 200e3);
    let o;
    try { o = computeOrder(JSON.parse(r.data), body); } catch (e) { return fail(res, 400, e.message); }
    if (!o.name || o.tel.length < 3) return fail(res, 400, 'Bitte Name und Telefon angeben');
    const n = q('SELECT COUNT(*) c FROM orders WHERE shop_id=?').get(r.id).c;
    const order = { id: nid(), nr: '#' + (1001 + n), status: 'neu', created: Date.now() };
    q('INSERT INTO orders(id,shop_id,nr,status,data,created) VALUES(?,?,?,?,?,?)').run(order.id, r.id, order.nr, 'neu', JSON.stringify(o), order.created);
    broadcast(r, order);
    return send(res, 201, { nr: order.nr, total: o.total });
  }

  /* Einrichtung und Anmeldung */
  if (p === '/api/me' && m === 'GET') {
    const u = authUser(req);
    return send(res, 200, { user: u, setup: q('SELECT COUNT(*) c FROM users').get().c === 0 });
  }
  if (p === '/api/setup' && m === 'POST') {
    if (q('SELECT COUNT(*) c FROM users').get().c > 0) return fail(res, 403, 'Bereits eingerichtet');
    const b = await readBody(req, 20e3);
    const email = str(b.email, 120).toLowerCase(), name = str(b.name, 80), pw = String(b.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || pw.length < 8) return fail(res, 400, 'E-Mail, Name und Passwort (mind. 8 Zeichen) angeben');
    const id = nid();
    q('INSERT INTO users(id,email,name,pass,role,created) VALUES(?,?,?,?,?,?)').run(id, email, name, hashPw(pw), 'admin', Date.now());
    return send(res, 201, { user: { id, email, name, role: 'admin' } }, { 'Set-Cookie': sessionCookie(id) });
  }
  if (p === '/api/signup' && m === 'POST') {
    if (!ALLOW_SIGNUP) return fail(res, 403, 'Registrierung ist deaktiviert');
    if (limited('signup:' + ip, 5, 3600e3)) return fail(res, 429, 'Zu viele Versuche');
    const b = await readBody(req, 20e3);
    const email = str(b.email, 120).toLowerCase(), name = str(b.name, 80), pw = String(b.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || pw.length < 8) return fail(res, 400, 'E-Mail, Name und Passwort (mind. 8 Zeichen) angeben');
    if (q('SELECT id FROM users WHERE email=?').get(email)) return fail(res, 409, 'E-Mail bereits registriert');
    const id = nid();
    q('INSERT INTO users(id,email,name,pass,role,created) VALUES(?,?,?,?,?,?)').run(id, email, name, hashPw(pw), 'shop', Date.now());
    return send(res, 201, { user: { id, email, name, role: 'shop' } }, { 'Set-Cookie': sessionCookie(id) });
  }
  if (p === '/api/login' && m === 'POST') {
    if (limited('login:' + ip, 10, 600e3)) return fail(res, 429, 'Zu viele Anmeldeversuche. Bitte in 10 Minuten erneut versuchen.');
    const b = await readBody(req, 20e3);
    const email = str(b.email, 120).toLowerCase();
    const r = q('SELECT * FROM users WHERE email=?').get(email);
    const ok = checkPw(String(b.password || ''), r ? r.pass : '');
    if (!r || !ok) { logAudit(null, 'auth.login_failed', email, { ip }); return fail(res, 401, 'E-Mail oder Passwort falsch'); }
    logAudit(r, 'auth.login', r.email, { ip });
    return send(res, 200, { user: { id: r.id, email: r.email, name: r.name, role: r.role } }, { 'Set-Cookie': sessionCookie(r.id) });
  }
  if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });

  /* ab hier nur angemeldet */
  const u = authUser(req);
  if (!u) return fail(res, 401, 'Bitte anmelden');
  const isAdmin = u.role === 'admin';
  const canShop = (r) => r && (isAdmin || r.owner === u.id);

  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }, SEC));
    res.write('retry: 4000\n\n');
    const c = { res, u }; clients.add(c);
    req.on('close', () => clients.delete(c));
    return;
  }
  if (p === '/api/password' && m === 'POST') {
    const b = await readBody(req, 20e3);
    const r = q('SELECT * FROM users WHERE id=?').get(u.id);
    if (!checkPw(String(b.old || ''), r.pass)) return fail(res, 400, 'Altes Passwort falsch');
    if (String(b.new || '').length < 8) return fail(res, 400, 'Neues Passwort: mindestens 8 Zeichen');
    q('UPDATE users SET pass=? WHERE id=?').run(hashPw(String(b.new)), u.id);
    return send(res, 200, { ok: true });
  }

  /* Benutzer (nur Inhaber der Plattform) */
  if (p === '/api/users' && m === 'GET') {
    if (!isAdmin) return fail(res, 403, 'Keine Berechtigung');
    return send(res, 200, { users: q('SELECT id,email,name,role,created FROM users ORDER BY created').all() });
  }
  if (p === '/api/users' && m === 'POST') {
    if (!isAdmin) return fail(res, 403, 'Keine Berechtigung');
    const b = await readBody(req, 20e3);
    const email = str(b.email, 120).toLowerCase(), name = str(b.name, 80), pw = String(b.password || ''), role = b.role === 'admin' ? 'admin' : 'shop';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || pw.length < 8) return fail(res, 400, 'E-Mail, Name und Passwort (mind. 8 Zeichen) angeben');
    if (q('SELECT id FROM users WHERE email=?').get(email)) return fail(res, 409, 'E-Mail bereits vergeben');
    const id = nid();
    q('INSERT INTO users(id,email,name,pass,role,created) VALUES(?,?,?,?,?,?)').run(id, email, name, hashPw(pw), role, Date.now());
    logAudit(u, 'user.create', email, { role });
    return send(res, 201, { user: { id, email, name, role } });
  }
  if ((mt = p.match(/^\/api\/users\/([\w-]+)$/)) && m === 'DELETE') {
    if (!isAdmin) return fail(res, 403, 'Keine Berechtigung');
    if (mt[1] === u.id) return fail(res, 400, 'Du kannst dich nicht selbst löschen');
    logAudit(u, 'user.delete', mt[1], {});
    q('UPDATE shops SET owner=? WHERE owner=?').run(u.id, mt[1]);
    q('DELETE FROM users WHERE id=?').run(mt[1]);
    return send(res, 200, { ok: true });
  }

  /* Shops */
  if (p === '/api/shops' && m === 'GET') {
    const rows = isAdmin
      ? q('SELECT s.*,u.name AS oname FROM shops s LEFT JOIN users u ON u.id=s.owner ORDER BY s.created').all()
      : q('SELECT s.*,u.name AS oname FROM shops s LEFT JOIN users u ON u.id=s.owner WHERE s.owner=? ORDER BY s.created').all(u.id);
    return send(res, 200, { shops: rows.map(r => ({ id: r.id, slug: r.slug, owner: r.owner, ownerName: r.oname || '', data: JSON.parse(r.data) })) });
  }
  if (p === '/api/shops' && m === 'POST') {
    const b = await readBody(req, 1e6);
    const data = cleanData(b.data || {});
    const name = str(data.name || b.name, 80) || 'Neuer Shop';
    data.name = name;
    const id = nid(), slug = uniqueSlug(slugify(name)), now = Date.now();
    const owner = isAdmin && b.ownerId && q('SELECT id FROM users WHERE id=?').get(b.ownerId) ? b.ownerId : u.id;
    q('INSERT INTO shops(id,slug,name,owner,data,created,updated) VALUES(?,?,?,?,?,?,?)').run(id, slug, name, owner, JSON.stringify(data), now, now);
    logAudit(u, 'shop.create', name, { slug });
    return send(res, 201, { shop: { id, slug, owner, ownerName: '', data } });
  }
  if ((mt = p.match(/^\/api\/shops\/([\w-]+)$/))) {
    const r = q('SELECT * FROM shops WHERE id=?').get(mt[1]);
    if (!canShop(r)) return fail(res, 404, 'Shop nicht gefunden');
    if (m === 'PUT') {
      const b = await readBody(req, 1e6);
      let slug = r.slug, data = JSON.parse(r.data), name = r.name, owner = r.owner;
      if (b.data && typeof b.data === 'object') { data = cleanData(b.data); name = str(data.name, 80) || r.name; data.name = name; }
      if (b.slug != null) {
        const want = slugify(b.slug);
        if (want !== r.slug) {
          const taken = q('SELECT id FROM shops WHERE slug=?').get(want);
          if (taken) return fail(res, 409, 'Diese Web-Adresse ist schon vergeben');
          slug = want;
        }
      }
      if (isAdmin && b.ownerId && q('SELECT id FROM users WHERE id=?').get(b.ownerId)) owner = b.ownerId;
      const json = JSON.stringify(data);
      if (json.length > 800e3) return fail(res, 413, 'Shop-Daten zu groß');
      q('UPDATE shops SET slug=?,name=?,owner=?,data=?,updated=? WHERE id=?').run(slug, name, owner, json, Date.now(), r.id);
      return send(res, 200, { ok: true, slug });
    }
    if (m === 'DELETE') {
      logAudit(u, 'shop.delete', r.name, { slug: r.slug });
      q('DELETE FROM orders WHERE shop_id=?').run(r.id);
      q('DELETE FROM shops WHERE id=?').run(r.id);
      return send(res, 200, { ok: true });
    }
  }

  /* Bestellungen */
  if (p === '/api/orders' && m === 'GET') {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
    const shop = url.searchParams.get('shop');
    let sql = 'SELECT o.*,s.name AS sname,s.slug,s.owner FROM orders o JOIN shops s ON s.id=o.shop_id';
    const args = [], where = [];
    if (!isAdmin) { where.push('s.owner=?'); args.push(u.id); }
    if (shop) { where.push('o.shop_id=?'); args.push(shop); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY o.created DESC LIMIT ?'; args.push(limit);
    const rows = q(sql).all(...args);
    return send(res, 200, { orders: rows.map(r => ({ id: r.id, shopId: r.shop_id, shopName: r.sname, nr: r.nr, status: r.status, created: r.created, data: JSON.parse(r.data) })) });
  }
  if ((mt = p.match(/^\/api\/orders\/([\w-]+)$/)) && m === 'PATCH') {
    const r = q('SELECT o.id,s.owner FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=?').get(mt[1]);
    if (!r || !(isAdmin || r.owner === u.id)) return fail(res, 404, 'Bestellung nicht gefunden');
    const b = await readBody(req, 5e3);
    if (!STATUS.includes(b.status)) return fail(res, 400, 'Ungültiger Status');
    q('UPDATE orders SET status=? WHERE id=?').run(b.status, r.id);
    return send(res, 200, { ok: true });
  }

  /* Bild-Upload */
  if (p === '/api/upload' && m === 'POST') {
    if (limited('up:' + u.id, 120, 600e3)) return fail(res, 429, 'Zu viele Uploads');
    const b = await readBody(req, 3e6);
    const mm = String(b.dataUrl || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!mm) return fail(res, 400, 'Nur JPG, PNG oder WebP erlaubt');
    const buf = Buffer.from(mm[2], 'base64');
    if (buf.length > 1.5e6) return fail(res, 413, 'Bild zu groß (max. 1,5 MB)');
    const ext = mm[1] === 'jpeg' ? 'jpg' : mm[1];
    const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return send(res, 201, { url: '/uploads/' + name });
  }

  /* ===== Master-Panel (nur Inhaber der Plattform) ===== */
  if (p.startsWith('/api/master/')) {
    if (!isAdmin) return fail(res, 403, 'Keine Berechtigung');
    const plansNow = () => getSetting('plans', DEFAULT_PLANS);
    const shopRow = (r, st) => ({
      id: r.id, slug: r.slug, name: r.name, owner: r.owner, ownerName: r.oname || '', status: r.status, effStatus: effStatus(r),
      plan: r.plan, validUntil: r.valid_until, notes: r.notes, created: r.created, updated: r.updated,
      products: st ? st.products : 0, orders30: st ? st.orders30 : 0, revenue30: st ? st.revenue30 : 0, lastOrder: st ? st.lastOrder : null
    });
    const loadShops = () => {
      const rows = q('SELECT s.*,u.name AS oname,json_array_length(json_extract(s.data,\'$.products\')) AS pc FROM shops s LEFT JOIN users u ON u.id=s.owner ORDER BY s.created').all();
      const since = Date.now() - 30 * 86400e3;
      const stats = new Map(q("SELECT shop_id, COUNT(*) n, COALESCE(SUM(json_extract(data,'$.total')),0) rev, MAX(created) last FROM orders WHERE status!='storniert' AND created>=? GROUP BY shop_id").all(since).map(x => [x.shop_id, x]));
      const lasts = new Map(q('SELECT shop_id, MAX(created) last FROM orders GROUP BY shop_id').all().map(x => [x.shop_id, x.last]));
      return rows.map(r => { const st = stats.get(r.id); return shopRow(r, { products: r.pc || 0, orders30: st ? st.n : 0, revenue30: st ? Math.round(st.rev * 100) / 100 : 0, lastOrder: lasts.get(r.id) || null }); });
    };

    if (p === '/api/master/overview' && m === 'GET') {
      const days = 28, now = Date.now(), since = now - days * 86400e3;
      const daily = q("SELECT date(created/1000,'unixepoch','localtime') d, COUNT(*) n, COALESCE(SUM(json_extract(data,'$.total')),0) rev FROM orders WHERE status!='storniert' AND created>=? GROUP BY d ORDER BY d").all(since);
      const byMode = q("SELECT json_extract(data,'$.mode') mode, COUNT(*) n FROM orders WHERE status!='storniert' AND created>=? GROUP BY mode").all(since);
      const top = q("SELECT s.id, s.name, COUNT(*) n, COALESCE(SUM(json_extract(o.data,'$.total')),0) rev FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.status!='storniert' AND o.created>=? GROUP BY s.id ORDER BY rev DESC LIMIT 6").all(since);
      const recent = q('SELECT o.id,o.nr,o.status,o.created,o.data,s.name sname FROM orders o JOIN shops s ON s.id=o.shop_id ORDER BY o.created DESC LIMIT 8').all()
        .map(r => ({ id: r.id, nr: r.nr, status: r.status, created: r.created, shopName: r.sname, data: JSON.parse(r.data) }));
      const open = q("SELECT COUNT(*) c FROM orders WHERE status IN ('neu','zubereitung','bereit')").get().c;
      const shops = loadShops(), plans = plansNow();
      const price = (k) => (plans.find(x => x.key === k) || { priceCents: 0 }).priceCents;
      const active = shops.filter(x => x.effStatus === 'active');
      const attention = [];
      for (const x of shops) {
        if (x.effStatus === 'expired') attention.push({ type: 'expired', shopId: x.id, shopName: x.name, text: 'Abo abgelaufen, Shop ist automatisch offline' });
        else if (x.status === 'active' && x.validUntil && x.validUntil - now < 7 * 86400e3) attention.push({ type: 'expiring', shopId: x.id, shopName: x.name, text: 'Abo endet in ' + Math.max(0, Math.ceil((x.validUntil - now) / 86400e3)) + ' Tag(en)' });
        if (x.status === 'paused') attention.push({ type: 'paused', shopId: x.id, shopName: x.name, text: 'Shop ist pausiert' });
        if (x.status === 'suspended') attention.push({ type: 'suspended', shopId: x.id, shopName: x.name, text: 'Shop ist gesperrt' });
        if (x.effStatus === 'active' && x.products === 0) attention.push({ type: 'empty', shopId: x.id, shopName: x.name, text: 'Noch keine Gerichte angelegt' });
        if (x.effStatus === 'active' && x.products > 0 && now - x.created > 3 * 86400e3 && (!x.lastOrder || now - x.lastOrder > 14 * 86400e3)) attention.push({ type: 'quiet', shopId: x.id, shopName: x.name, text: 'Seit 14 Tagen keine Bestellung' });
      }
      return send(res, 200, {
        now, daily, byMode, top, recent, attention, open,
        kpis: { shopsTotal: shops.length, shopsActive: active.length, mrrCents: active.reduce((a, x) => a + price(x.plan), 0), users: q('SELECT COUNT(*) c FROM users').get().c },
        planCounts: plans.map(pl => ({ key: pl.key, name: pl.name, count: active.filter(x => x.plan === pl.key).length }))
      });
    }
    if (p === '/api/master/shops' && m === 'GET') return send(res, 200, { shops: loadShops(), plans: plansNow() });
    if (p === '/api/master/shops/bulk' && m === 'POST') {
      const b = await readBody(req, 50e3);
      const ids = Array.isArray(b.ids) ? b.ids.slice(0, 200) : [];
      const map = { activate: 'active', pause: 'paused', suspend: 'suspended' };
      if (!map[b.action]) return fail(res, 400, 'Ungültige Aktion');
      let n = 0;
      for (const id of ids) { const r = q('SELECT name FROM shops WHERE id=?').get(String(id)); if (!r) continue; q('UPDATE shops SET status=? WHERE id=?').run(map[b.action], String(id)); logAudit(u, 'shop.status', r.name, { status: map[b.action], bulk: true }); n++; }
      return send(res, 200, { ok: true, changed: n });
    }
    if ((mt = p.match(/^\/api\/master\/shops\/([\w-]+)$/)) && m === 'PATCH') {
      const r = q('SELECT * FROM shops WHERE id=?').get(mt[1]);
      if (!r) return fail(res, 404, 'Shop nicht gefunden');
      const b = await readBody(req, 20e3);
      const ch = {};
      if (b.status !== undefined) { if (!['active', 'paused', 'suspended'].includes(b.status)) return fail(res, 400, 'Ungültiger Status'); ch.status = b.status; }
      if (b.plan !== undefined) { if (!plansNow().some(x => x.key === b.plan)) return fail(res, 400, 'Unbekanntes Paket'); ch.plan = b.plan; }
      if (b.validUntil !== undefined) { ch.valid_until = b.validUntil === null || b.validUntil === '' ? null : Number(b.validUntil); if (ch.valid_until !== null && !Number.isFinite(ch.valid_until)) return fail(res, 400, 'Ungültiges Datum'); }
      if (b.notes !== undefined) ch.notes = str(b.notes, 2000);
      if (b.ownerId !== undefined) { if (!q('SELECT id FROM users WHERE id=?').get(b.ownerId)) return fail(res, 400, 'Besitzer unbekannt'); ch.owner = b.ownerId; }
      const keys = Object.keys(ch);
      if (!keys.length) return fail(res, 400, 'Nichts zu ändern');
      q(`UPDATE shops SET ${keys.map(k => k + '=?').join(',')},updated=? WHERE id=?`).run(...keys.map(k => ch[k]), Date.now(), r.id);
      logAudit(u, 'shop.update', r.name, ch);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/master/settings' && m === 'GET') return send(res, 200, { plans: plansNow(), maintenance: getSetting('maintenance', { on: false, message: '' }) });
    if (p === '/api/master/settings' && m === 'PUT') {
      const b = await readBody(req, 20e3);
      if (Array.isArray(b.plans)) {
        const pl = b.plans.slice(0, 10).map(x => ({ key: str(x.key, 30).toLowerCase().replace(/[^a-z0-9_]/g, ''), name: str(x.name, 40), priceCents: Math.max(0, Math.round(Number(x.priceCents) || 0)) })).filter(x => x.key && x.name);
        if (!pl.length) return fail(res, 400, 'Mindestens ein Paket nötig');
        setSetting('plans', pl); logAudit(u, 'settings.plans', 'plans', { count: pl.length });
      }
      if (b.maintenance && typeof b.maintenance === 'object') {
        const mm = { on: !!b.maintenance.on, message: str(b.maintenance.message, 300) };
        setSetting('maintenance', mm); logAudit(u, 'settings.maintenance', mm.on ? 'an' : 'aus', mm);
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/master/audit' && m === 'GET') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const qq = '%' + str(url.searchParams.get('q'), 60) + '%';
      const rows = q('SELECT * FROM audit WHERE action LIKE ? OR target LIKE ? OR user_name LIKE ? ORDER BY id DESC LIMIT ?').all(qq, qq, qq, limit);
      return send(res, 200, { audit: rows.map(r => ({ id: r.id, ts: r.ts, user: r.user_name, action: r.action, target: r.target, detail: JSON.parse(r.detail || '{}') })) });
    }
    if (p === '/api/master/system' && m === 'GET') {
      let dbBytes = 0; try { dbBytes = fs.statSync(path.join(DATA_DIR, 'gastro.db')).size; } catch {}
      const up = fs.readdirSync(UPLOAD_DIR); let upBytes = 0; for (const f of up) { try { upBytes += fs.statSync(path.join(UPLOAD_DIR, f)).size; } catch {} }
      const mem = process.memoryUsage();
      return send(res, 200, {
        uptimeSec: Math.round((Date.now() - STARTED) / 1000), node: process.version, dbBytes, uploads: up.length, uploadBytes: upBytes, rssBytes: mem.rss,
        counts: { shops: q('SELECT COUNT(*) c FROM shops').get().c, orders: q('SELECT COUNT(*) c FROM orders').get().c, users: q('SELECT COUNT(*) c FROM users').get().c },
        backups: listBackups(), maintenance: getSetting('maintenance', { on: false, message: '' }), liveClients: clients.size
      });
    }
    if (p === '/api/master/backup' && m === 'POST') {
      if (limited('bk:' + u.id, 6, 600e3)) return fail(res, 429, 'Zu viele Sicherungen. Bitte kurz warten.');
      const n = makeBackup(); logAudit(u, 'system.backup', n, {});
      return send(res, 201, { name: n });
    }
    if ((mt = p.match(/^\/api\/master\/backups\/(gastro-\d{8}-\d{6}\.db)$/)) && m === 'GET') {
      const f = path.join(BACKUP_DIR, mt[1]);
      if (!fs.existsSync(f)) return fail(res, 404, 'Sicherung nicht gefunden');
      logAudit(u, 'system.backup_download', mt[1], {});
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + mt[1] + '"', 'Cache-Control': 'no-store' }, SEC));
      return fs.createReadStream(f).pipe(res);
    }
    if ((mt = p.match(/^\/api\/master\/users\/([\w-]+)\/password$/)) && m === 'POST') {
      const b = await readBody(req, 5e3);
      const pw = String(b.password || '');
      if (pw.length < 8) return fail(res, 400, 'Passwort: mindestens 8 Zeichen');
      const r = q('SELECT email FROM users WHERE id=?').get(mt[1]);
      if (!r) return fail(res, 404, 'Benutzer nicht gefunden');
      q('UPDATE users SET pass=? WHERE id=?').run(hashPw(pw), mt[1]);
      logAudit(u, 'user.password_reset', r.email, {});
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, 'Nicht gefunden');
  }
  return fail(res, 404, 'Nicht gefunden');
}

const INDEX = path.join(__dirname, 'public', 'index.html');
const MASTER_PAGE = path.join(__dirname, 'public', 'master.html');
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await api(req, res, p, url);
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    let mt;
    if ((mt = p.match(/^\/uploads\/([a-f0-9]{24}\.(jpg|png|webp))$/)) && req.method === 'GET') {
      const f = path.join(UPLOAD_DIR, mt[1]);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[mt[2]], 'Cache-Control': 'public, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/') { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    if (p === '/master' && req.method === 'GET') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP }, SEC));
      return res.end(fs.readFileSync(MASTER_PAGE));
    }
    if ((p === '/admin' || /^\/s\/[a-z0-9-]+\/?$/.test(p)) && req.method === 'GET') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP }, SEC));
      return res.end(fs.readFileSync(INDEX));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nicht gefunden');
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) send(res, code, { error: code === 500 ? 'Serverfehler' : e.message }); else res.end();
  }
});
server.listen(PORT, () => console.log('Gastro-Plattform läuft auf http://localhost:' + PORT + '/admin'));
