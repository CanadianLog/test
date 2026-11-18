'use strict';
/*
 * Instagram connection (official "Instagram API with Instagram Login").
 *
 * A customer clicks "Connect Instagram", approves access on instagram.com,
 * then picks posts to copy onto their screen — or turns on auto-add so new
 * Reels appear on the screen by themselves.
 *
 * Needs a Meta developer app. Set on the server:
 *   IG_APP_ID, IG_APP_SECRET   (from the app's Instagram settings)
 *   PUBLIC_URL                 (optional, e.g. https://ads.example.com — used for the redirect URL)
 * Redirect URL to register with Meta: <PUBLIC_URL>/auth/instagram/callback
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const AUTH_BASE = process.env.IG_AUTH_BASE || 'https://www.instagram.com';
const API_BASE = process.env.IG_API_BASE || 'https://api.instagram.com';
const GRAPH_BASE = process.env.IG_GRAPH_BASE || 'https://graph.instagram.com';
const SYNC_MINUTES = 30;
const DAY = 864e5;

module.exports = function instagram(app, ctx) {
  const { db, save, newId, auth, target, adsFor, bump, MEDIA_DIR, MAX_UPLOAD_MB } = ctx;
  const appId = () => process.env.IG_APP_ID;
  const appSecret = () => process.env.IG_APP_SECRET;
  const configured = () => Boolean(appId() && appSecret());

  const baseUrl = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const redirectUri = req => baseUrl(req) + '/auth/instagram/callback';

  async function igJson(url, opts) {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error || data.error_message) {
      const msg = data.error?.message || data.error_message || `Instagram error ${r.status}`;
      const err = new Error(msg);
      err.igCode = data.error?.code;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------- status
  app.get('/api/instagram', auth, (req, res) => {
    const u = target(req);
    if (!u) return res.status(404).json({ error: 'Account not found' });
    res.json({
      configured: configured(),
      redirectUri: req.user.role === 'admin' ? redirectUri(req) : undefined,
      connected: Boolean(u.instagram),
      username: u.instagram?.username || null,
      autoAdd: Boolean(u.instagram?.autoAdd),
      problem: u.instagram?.problem || null,
    });
  });

  // ---------------------------------------------------------------- connect (OAuth)
  app.get('/auth/instagram/start', auth, (req, res) => {
    if (!configured()) return res.status(400).send('Instagram is not set up on this server yet.');
    const u = target(req);
    if (!u) return res.status(404).send('Account not found');
    const state = newId(16);
    db.oauthStates ||= {};
    for (const [k, v] of Object.entries(db.oauthStates)) if (v.expires < Date.now()) delete db.oauthStates[k];
    db.oauthStates[state] = { userId: u.id, by: req.user.id, expires: Date.now() + 15 * 60 * 1000 };
    save();
    const q = new URLSearchParams({
      client_id: appId(), redirect_uri: redirectUri(req), response_type: 'code',
      scope: 'instagram_business_basic', state,
    });
    res.redirect(`${AUTH_BASE}/oauth/authorize?${q}`);
  });

  app.get('/auth/instagram/callback', auth, async (req, res) => {
    const st = db.oauthStates?.[req.query.state];
    if (st) { delete db.oauthStates[req.query.state]; save(); }
    const back = (status, extra = '') => res.redirect(`/admin?ig=${status}${st && st.userId !== st.by ? '&as=' + st.userId : ''}${extra}`);
    if (!st || st.expires < Date.now() || st.by !== req.user.id) return back('error', '&why=expired');
    if (req.query.error || !req.query.code) return back('cancelled');
    const u = db.users.find(x => x.id === st.userId);
    if (!u) return back('error');
    try {
      const code = String(req.query.code).replace(/#_$/, '');
      const short = await igJson(`${API_BASE}/oauth/access_token`, {
        method: 'POST',
        body: new URLSearchParams({ client_id: appId(), client_secret: appSecret(), grant_type: 'authorization_code',
          redirect_uri: redirectUri(req), code }),
      });
      const long = await igJson(`${GRAPH_BASE}/access_token?` + new URLSearchParams({
        grant_type: 'ig_exchange_token', client_secret: appSecret(), access_token: short.access_token }));
      const me = await igJson(`${GRAPH_BASE}/me?` + new URLSearchParams({ fields: 'user_id,username', access_token: long.access_token }));
      u.instagram = {
        igUserId: String(me.user_id || short.user_id || ''),
        username: me.username,
        token: long.access_token,
        tokenIssuedAt: Date.now(),
        expiresAt: Date.now() + (Number(long.expires_in) || 60 * 86400) * 1000,
        autoAdd: false,
        connectedAt: new Date().toISOString(),
        problem: null,
      };
      save();
      back('connected');
    } catch (e) {
      console.error('Instagram connect failed:', e.message);
      back('error');
    }
  });

  app.post('/api/instagram/disconnect', auth, (req, res) => {
    const u = target(req);
    if (!u) return res.status(404).json({ error: 'Account not found' });
    delete u.instagram;
    save();
    res.json({ ok: true });   // ads already copied stay on the screen
  });

  app.patch('/api/instagram', auth, (req, res) => {
    const u = target(req);
    if (!u?.instagram) return res.status(400).json({ error: 'Instagram is not connected' });
    if (typeof req.body?.autoAdd === 'boolean') {
      u.instagram.autoAdd = req.body.autoAdd;
      // only Reels posted from now on get added automatically
      if (req.body.autoAdd) u.instagram.autoAddSince = new Date().toISOString();
    }
    save();
    res.json({ autoAdd: u.instagram.autoAdd });
    if (u.instagram.autoAdd) syncUser(u).catch(() => {});
  });

  // ---------------------------------------------------------------- media
  const FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp';

  async function listMedia(u, limit = 24) {
    const data = await igJson(`${GRAPH_BASE}/me/media?` + new URLSearchParams({
      fields: FIELDS, limit: String(limit), access_token: u.instagram.token }));
    return (data.data || []).filter(m => m.media_type === 'VIDEO' || m.media_type === 'IMAGE');
  }

  function handleTokenError(u, e) {
    // 190 = token expired or revoked: the customer has to reconnect
    if (e.igCode === 190 && u.instagram) {
      u.instagram.problem = 'Instagram access expired. Please reconnect.';
      u.instagram.autoAdd = false;
      save();
    }
  }

  app.get('/api/instagram/media', auth, async (req, res) => {
    const u = target(req);
    if (!u?.instagram) return res.status(400).json({ error: 'Instagram is not connected' });
    try {
      const media = await listMedia(u);
      const added = new Set(adsFor(u.id).filter(a => a.igId).map(a => a.igId));
      res.json(media.map(m => ({
        id: m.id, type: m.media_type === 'VIDEO' ? 'video' : 'image',
        reel: m.media_product_type === 'REELS',
        thumb: m.thumbnail_url || m.media_url, permalink: m.permalink,
        caption: (m.caption || '').slice(0, 140), timestamp: m.timestamp, added: added.has(m.id),
      })));
    } catch (e) {
      handleTokenError(u, e);
      res.status(502).json({ error: 'Could not load Instagram posts: ' + e.message });
    }
  });

  // Copy one post onto the screen (download the file so it plays offline too)
  async function addMedia(u, m) {
    if (adsFor(u.id).some(a => a.igId === m.id)) return null;
    if (!m.media_url) throw new Error('This post has no downloadable file (it may contain copyrighted music).');
    const isVideo = m.media_type === 'VIDEO';
    const file = newId(12) + (isVideo ? '.mp4' : '.jpg');
    const r = await fetch(m.media_url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
    if (!r.ok || !r.body) throw new Error('Download from Instagram failed');
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`File too large (max ${MAX_UPLOAD_MB} MB)`);
    const dest = path.join(MEDIA_DIR, file);
    try {
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
    } catch (e) {
      fs.rm(dest, { force: true }, () => {});
      throw e;
    }
    const firstLine = (m.caption || '').split('\n')[0].trim();
    const ad = {
      id: newId(), ownerId: u.id, file, type: isVideo ? 'video' : 'image',
      name: (firstLine || `Instagram ${isVideo ? 'video' : 'post'}`).slice(0, 80),
      duration: u.settings.defaultDuration || 10, enabled: true, startDate: null, endDate: null,
      order: adsFor(u.id).reduce((mx, a) => Math.max(mx, a.order), 0) + 1,
      size: fs.statSync(dest).size, source: 'instagram', igId: m.id, permalink: m.permalink,
      createdAt: new Date().toISOString(),
    };
    db.ads.push(ad);
    bump(u);
    save();
    return ad;
  }

  app.post('/api/instagram/add', auth, async (req, res) => {
    const u = target(req);
    if (!u?.instagram) return res.status(400).json({ error: 'Instagram is not connected' });
    try {
      // fetch the post fresh: media_url links expire after a while
      const m = await igJson(`${GRAPH_BASE}/${encodeURIComponent(String(req.body?.id || ''))}?` +
        new URLSearchParams({ fields: FIELDS, access_token: u.instagram.token }));
      const ad = await addMedia(u, m);
      if (!ad) return res.status(400).json({ error: 'Already on your screen' });
      res.json(ad);
    } catch (e) {
      handleTokenError(u, e);
      res.status(502).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------- background jobs
  async function syncUser(u) {
    if (!u.instagram?.autoAdd || u.instagram.problem) return;
    const since = Date.parse(u.instagram.autoAddSince || u.instagram.connectedAt);
    let media;
    try { media = await listMedia(u, 10); } catch (e) { handleTokenError(u, e); return; }
    // Instagram writes times like 2026-11-18T10:00:00+0000, so compare as dates, not text
    const fresh = media.filter(m => m.media_type === 'VIDEO' && Date.parse(m.timestamp) > since).reverse();
    for (const m of fresh) {
      try { await addMedia(u, m); } catch (e) { console.error(`Instagram auto-add (${u.username}):`, e.message); }
    }
  }

  async function refreshTokens() {
    for (const u of db.users) {
      const ig = u.instagram;
      // long-lived tokens last 60 days; refresh weekly (allowed once a token is 24h old)
      if (!ig || ig.problem || Date.now() - ig.tokenIssuedAt < 7 * DAY) continue;
      try {
        const r = await igJson(`${GRAPH_BASE}/refresh_access_token?` +
          new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: ig.token }));
        ig.token = r.access_token;
        ig.tokenIssuedAt = Date.now();
        ig.expiresAt = Date.now() + (Number(r.expires_in) || 60 * 86400) * 1000;
        save();
      } catch (e) {
        console.error(`Instagram token refresh (${u.username}):`, e.message);
        handleTokenError(u, e);
      }
    }
  }

  async function tick() {
    if (!configured()) return;
    await refreshTokens();
    for (const u of db.users) await syncUser(u).catch(() => {});
  }
  setTimeout(tick, 60 * 1000);
  setInterval(tick, SYNC_MINUTES * 60 * 1000).unref();

  return { configured };
};
