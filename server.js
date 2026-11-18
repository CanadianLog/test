'use strict';
/*
 * Ad Screen - digital signage server
 *  - /admin            : login + dashboard where customers manage their ads
 *  - /screen/<key>     : the full-screen player the Chromebook opens on boot
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const SESSION_DAYS = 30;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------- storage
let db = { users: [], ads: [], sessions: {} };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
db.users ||= []; db.ads ||= []; db.sessions ||= {};

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const newId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

function hashPassword(password, salt = newId(16)) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function createUser({ username, password, role = 'customer', businessName = '' }) {
  const { salt, hash } = hashPassword(password);
  const user = {
    id: newId(),
    username: username.trim().toLowerCase(),
    businessName: businessName || username,
    role,
    salt,
    hash,
    screenKey: newId(12),
    settings: { transition: 'fade', defaultDuration: 10, muteVideos: true, fit: 'contain', background: '#000000', rotation: 0 },
    version: 1,
    lastSeen: null,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  save();
  return user;
}

// First run: create the admin account
if (!db.users.some(u => u.role === 'admin')) {
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || newId(6);
  createUser({ username, password, role: 'admin', businessName: 'Administrator' });
  console.log('\n==============================================');
  console.log(' Admin account created');
  console.log(`   username: ${username}`);
  console.log(`   password: ${password}`);
  console.log(' Change it after logging in (Account tab).');
  console.log('==============================================\n');
}

const publicUser = u => ({
  id: u.id, username: u.username, businessName: u.businessName, role: u.role,
  screenKey: u.screenKey, settings: u.settings, lastSeen: u.lastSeen, createdAt: u.createdAt,
});

function bump(user) { user.version = (user.version || 0) + 1; }

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function auth(req, res, next) {
  const token = parseCookies(req).sid;
  const s = token && db.sessions[token];
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Not logged in' });
  const user = db.users.find(u => u.id === s.userId);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  req.token = token;
  next();
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });

// Which account's ads are we editing? Admins can act on behalf of a customer with ?as=<userId>
function target(req) {
  if (req.user.role === 'admin' && req.query.as) {
    return db.users.find(u => u.id === req.query.as) || null;
  }
  return req.user;
}

// --- simple login rate limiting (per IP)
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 10;
}

app.post('/api/login', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { username = '', password = '' } = req.body || {};
  const user = db.users.find(u => u.username === String(username).trim().toLowerCase());
  if (!user || !checkPassword(user, String(password))) {
    attempts.get(req.ip).push(Date.now());
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const token = newId(32);
  db.sessions[token] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 864e5 };
  for (const [t, s] of Object.entries(db.sessions)) if (s.expires < Date.now()) delete db.sessions[t];
  save();
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  res.json(publicUser(user));
});

app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[req.token];
  save();
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

app.post('/api/password', auth, (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(req.user, String(current || ''))) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || String(next).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  Object.assign(req.user, hashPassword(String(next)));
  save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- ads
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => cb(null, newId(12) + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype)),
});

const adsFor = userId => db.ads.filter(a => a.ownerId === userId).sort((a, b) => a.order - b.order);

app.get('/api/ads', auth, (req, res) => {
  const u = target(req);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  res.json({ account: publicUser(u), ads: adsFor(u.id) });
});

app.post('/api/ads', auth, upload.array('files', 20), (req, res) => {
  const u = target(req);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Please choose image or video files' });
  let order = adsFor(u.id).reduce((m, a) => Math.max(m, a.order), 0);
  const added = req.files.map(f => {
    const ad = {
      id: newId(),
      ownerId: u.id,
      file: f.filename,
      type: f.mimetype.startsWith('video/') ? 'video' : 'image',
      name: path.parse(f.originalname).name.slice(0, 80),
      duration: u.settings.defaultDuration || 10,
      enabled: true,
      startDate: null,
      endDate: null,
      order: ++order,
      size: f.size,
      createdAt: new Date().toISOString(),
    };
    db.ads.push(ad);
    return ad;
  });
  bump(u);
  save();
  res.json(added);
});

// --- YouTube ads: customer pastes a link, we store the video id
function youtubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (!id && m) id = m[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

async function youtubeTitle(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`,
      { signal: AbortSignal.timeout(5000) });
    if (r.ok) return (await r.json()).title;
  } catch {}
  return null;
}

app.post('/api/ads/youtube', auth, async (req, res) => {
  const u = target(req);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  const id = youtubeId(req.body?.url);
  if (!id) return res.status(400).json({ error: 'That doesn\'t look like a YouTube link' });
  const title = await youtubeTitle(id);
  const order = adsFor(u.id).reduce((m, a) => Math.max(m, a.order), 0) + 1;
  const ad = {
    id: newId(), ownerId: u.id, type: 'youtube', ytId: id, file: null,
    name: (title || 'YouTube video').slice(0, 80),
    duration: 0,            // 0 = play the whole video
    enabled: true, startDate: null, endDate: null, order,
    createdAt: new Date().toISOString(),
  };
  db.ads.push(ad);
  bump(u); save();
  res.json(ad);
});

const removeMedia = ad => { if (ad.file) fs.rm(path.join(MEDIA_DIR, ad.file), { force: true }, () => {}); };

function ownAd(req, res) {
  const u = target(req);
  const ad = u && db.ads.find(a => a.id === req.params.id && a.ownerId === u.id);
  if (!ad) { res.status(404).json({ error: 'Ad not found' }); return null; }
  return { u, ad };
}

app.patch('/api/ads/:id', auth, (req, res) => {
  const r = ownAd(req, res); if (!r) return;
  const b = req.body || {};
  if (typeof b.name === 'string') r.ad.name = b.name.slice(0, 80);
  if (b.duration !== undefined) {
    r.ad.duration = r.ad.type === 'youtube'
      ? Math.min(36000, Math.max(0, Number(b.duration) || 0))        // 0 = whole video
      : Math.min(3600, Math.max(1, Number(b.duration) || 10));
  }
  if (typeof b.enabled === 'boolean') r.ad.enabled = b.enabled;
  for (const k of ['startDate', 'endDate']) {
    if (b[k] !== undefined) r.ad[k] = /^\d{4}-\d{2}-\d{2}$/.test(b[k]) ? b[k] : null;
  }
  bump(r.u); save();
  res.json(r.ad);
});

app.delete('/api/ads/:id', auth, (req, res) => {
  const r = ownAd(req, res); if (!r) return;
  db.ads = db.ads.filter(a => a !== r.ad);
  removeMedia(r.ad);
  bump(r.u); save();
  res.json({ ok: true });
});

app.post('/api/ads/reorder', auth, (req, res) => {
  const u = target(req);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  ids.forEach((id, i) => {
    const ad = db.ads.find(a => a.id === id && a.ownerId === u.id);
    if (ad) ad.order = i + 1;
  });
  bump(u); save();
  res.json({ ok: true });
});

app.patch('/api/settings', auth, (req, res) => {
  const u = target(req);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  const b = req.body || {};
  const s = u.settings;
  if (['fade', 'slide', 'none'].includes(b.transition)) s.transition = b.transition;
  if (['contain', 'cover'].includes(b.fit)) s.fit = b.fit;
  if ([0, 90, 180, 270].includes(Number(b.rotation))) s.rotation = Number(b.rotation);
  if (b.defaultDuration !== undefined) s.defaultDuration = Math.min(3600, Math.max(1, Number(b.defaultDuration) || 10));
  if (typeof b.muteVideos === 'boolean') s.muteVideos = b.muteVideos;
  if (typeof b.background === 'string' && /^#[0-9a-f]{6}$/i.test(b.background)) s.background = b.background;
  if (typeof b.businessName === 'string' && b.businessName.trim()) u.businessName = b.businessName.trim().slice(0, 80);
  bump(u); save();
  res.json(publicUser(u));
});

// Force every screen for this account to reload right now
app.post('/api/screen/refresh', auth, (req, res) => {
  const u = target(req);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  u.reloadToken = newId(4);
  bump(u); save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- admin: customers
app.get('/api/users', auth, adminOnly, (req, res) => {
  res.json(db.users.map(u => ({ ...publicUser(u), adCount: adsFor(u.id).length })));
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, businessName } = req.body || {};
  if (!username || !/^[a-z0-9._@-]{3,40}$/i.test(username)) return res.status(400).json({ error: 'Username: 3-40 letters/numbers' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.users.some(u => u.username === username.toLowerCase())) return res.status(400).json({ error: 'Username already taken' });
  res.json(publicUser(createUser({ username, password, businessName })));
});

app.post('/api/users/:id/password', auth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  Object.assign(u, hashPassword(pw));
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[t];
  save();
  res.json({ ok: true });
});

app.post('/api/users/:id/newkey', auth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  u.screenKey = newId(12); save();
  res.json(publicUser(u));
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Cannot delete an admin' });
  for (const ad of adsFor(u.id)) removeMedia(ad);
  db.ads = db.ads.filter(a => a.ownerId !== u.id);
  db.users = db.users.filter(x => x !== u);
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[t];
  save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- player (public, by secret screen key)
const today = () => new Date().toISOString().slice(0, 10);
let lastSeenWrite = 0;

app.get('/api/screen/:key/playlist', (req, res) => {
  const u = db.users.find(x => x.screenKey === req.params.key);
  if (!u) return res.status(404).json({ error: 'Unknown screen' });
  u.lastSeen = new Date().toISOString();
  if (Date.now() - lastSeenWrite > 60000) { lastSeenWrite = Date.now(); save(); }
  const d = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : today();
  const items = adsFor(u.id)
    .filter(a => a.enabled && (!a.startDate || a.startDate <= d) && (!a.endDate || a.endDate >= d))
    .map(a => a.type === 'youtube'
      ? { id: a.id, type: 'youtube', ytId: a.ytId, duration: a.duration }
      : { id: a.id, type: a.type, url: '/media/' + a.file, duration: a.duration });
  res.set('Cache-Control', 'no-store');
  res.json({ version: u.version, reloadToken: u.reloadToken || null, settings: u.settings, items });
});

app.get('/screen/:key/manifest.webmanifest', (req, res) => {
  const u = db.users.find(x => x.screenKey === req.params.key);
  if (!u) return res.status(404).end();
  res.type('application/manifest+json').send(JSON.stringify({
    name: `${u.businessName} Ad Screen`,
    short_name: 'Ad Screen',
    start_url: `/screen/${u.screenKey}`,
    scope: `/screen/${u.screenKey}`,
    display: 'fullscreen',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }));
});

app.get('/screen/:key', (req, res) => {
  if (!db.users.some(x => x.screenKey === req.params.key)) return res.status(404).send('Unknown screen');
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.use('/media', express.static(MEDIA_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_UPLOAD_MB} MB)` : err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => console.log(`Ad Screen running on http://localhost:${PORT}  (dashboard: /admin)`));
