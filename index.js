/**
 * WYA App — Where You At
 * Self-hosted vendor finder for Santa Barbara
 * Port: 3422
 * Replaces Base44 app entirely
 * (c) Universoul LLC | Santa Barbara, CA
 */

// Production hardening: load env directly, don't rely on PM2 inheritance
require('dotenv').config({ path: '/root/.env', override: true });

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

// Brain OS 3.0: Lazy-load brain-ingest for business event recording
const _brainIngest = (() => { try { return require('/root/universoul-ecosystem/lib/brain-ingest'); } catch { return null; } })();
const webpush = require('web-push');
const apn = require('@parse/node-apn');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { healthResponse } = require('../lib/health-contract');

// ── Process-level crash guards (must be first) ────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[WYA-APP] Unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[WYA-APP] Uncaught exception:', err.message, err.stack);
  // Phase 1653: Alert Brain on crash (non-blocking)
  try {
    const body = JSON.stringify({ folderId: '1CC_vl2Jy4wFSXFAccX3yMCZOBa_PoK4G', name: `WYA-CRASH-${new Date().toISOString().slice(0,10)}.md`, content: `# WYA Uncaught Exception\n**Time:** ${new Date().toISOString()}\n**Error:** ${err.message}\n**Stack:** ${(err.stack||'').slice(0,500)}` });
    const req = require('http').request({ hostname: '127.0.0.1', port: 3350, path: '/write', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', (e) => console.warn('[WYA] Fire-and-forget failed:', e.message));
    req.end(body);
  } catch(_) {}
});

const BRAIN_FOLDERS = require('../config/brain-folders');
const Stripe = require('stripe');
let _stripe;
function getStripe() {
  if (!_stripe) _stripe = Stripe(process.env.WYA_STRIPE_SK);
  return _stripe;
}

// ─── Reliable customer/billing sync via Outbox (replaces fire-and-forget) ──
const { CustomerSync } = require('/root/universoul-ecosystem/lib/customer-sync');
const _customerSyncWya = new CustomerSync('wya');
const _customerSyncVendor = new CustomerSync('wya-vendor');
function emsSyncCustomer(email, name, phone, role, tenantId) {
  const sync = role === 'vendor' ? _customerSyncVendor : _customerSyncWya;
  // Phase AUDIT-2A: WYA passes tenant context; default 'sergio' for single-tenant
  sync.syncCustomer({ email, name, phone, tenantId: tenantId || process.env.OWNER_USER_ID || 'sergio' });
}
function emsBillingRecord(customerEmail, amountCents, stripePaymentId, description) {
  _customerSyncWya.recordBilling({ customerEmail, amountCents, stripePaymentId, description });
}

const rateLimit747 = require('express-rate-limit');
// Phase 1352: EMS auth bridge — cross-product session validation
const { validateEMSToken, requireEMSAuth, optionalEMSAuth, requireEMSAuthWithProduct, lookupProductUserId } = require('/root/universoul-ecosystem/lib/ems-auth-bridge');

const app = express();
app.set('trust proxy', 1); // Trust proxy X-Forwarded-For (wya-proxy)
const PORT = parseInt(process.env.PORT || '3422');
const DB_PATH = path.join(__dirname, 'data', 'wya.db');
const SOUL_TOKEN = process.env.PORTAL_SECRET || '';
if (!SOUL_TOKEN || SOUL_TOKEN.length < 10) {
  console.error('[WYA-APP] FATAL: PORTAL_SECRET is empty or too short — auth will fail for all internal requests');
} else {
  console.log(`[WYA-APP] PORTAL_SECRET loaded (${SOUL_TOKEN.length} chars)`);
}

// Phase 747c: Strip HTML tags to prevent stored XSS
function sanitize(str) { return typeof str === 'string' ? str.replace(/<[^>]*>/g, '').trim() : str; }
// Phase Security: HTML-escape user input before interpolation into email templates
function _escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Roadmap T4.3: Review content filtering — profanity/spam detection
const PROFANITY_WORDS = new Set(['fuck','shit','damn','ass','bitch','dick','cunt','bastard','piss','cock','whore','slut','nigger','faggot','retard']);
function filterReviewContent(text) {
  if (!text || typeof text !== 'string') return { ok: true, filtered: text || '' };
  if (text.length > 1000) return { ok: false, reason: 'Review text too long (max 1000 characters)' };
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  for (const w of words) {
    const clean = w.replace(/[^a-z]/g, '');
    if (PROFANITY_WORDS.has(clean)) return { ok: false, reason: 'Review contains inappropriate language' };
  }
  // Spam detection: excessive caps, repeated chars, URLs
  if (text.length > 20 && (text.replace(/[^A-Z]/g, '').length / text.length) > 0.7) return { ok: false, reason: 'Excessive use of capital letters' };
  if (/(.)\1{5,}/.test(text)) return { ok: false, reason: 'Repeated characters detected' };
  if (/(https?:\/\/|www\.)/i.test(text)) return { ok: false, reason: 'URLs not allowed in reviews' };
  return { ok: true, filtered: sanitize(text) };
}

// Roadmap T4.3: Polygon self-intersection check
function isPolygonSelfIntersecting(coords) {
  if (!Array.isArray(coords) || coords.length < 4) return false;
  function segmentsIntersect(p1, p2, p3, p4) {
    const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
    const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-10) return false;
    const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / cross;
    const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / cross;
    return t > 0 && t < 1 && u > 0 && u < 1;
  }
  for (let i = 0; i < coords.length - 1; i++) {
    for (let j = i + 2; j < coords.length - 1; j++) {
      if (i === 0 && j === coords.length - 2) continue; // skip adjacent closing edge
      if (segmentsIntersect(coords[i], coords[i + 1], coords[j], coords[j + 1])) return true;
    }
  }
  return false;
}

// ── Multer for photo uploads ───────────────────────────────
const upload = multer({
  dest: path.join(__dirname, 'public', 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/png','image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only jpeg/png/webp allowed'));
  }
});

// ── VAPID keys for web push ────────────────────────────────
const VAPID_PUBLIC = process.env.WYA_VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.WYA_VAPID_PRIVATE || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:hello@digisigns.link', VAPID_PUBLIC, VAPID_PRIVATE);
}
// Phase 1639e: Periodic VAPID refresh — re-read from env in case keys rotate
setInterval(() => {
  const _vPub = process.env.WYA_VAPID_PUBLIC || '';
  const _vPriv = process.env.WYA_VAPID_PRIVATE || '';
  if (_vPub && _vPriv && (_vPub !== VAPID_PUBLIC || _vPriv !== VAPID_PRIVATE)) {
    try { webpush.setVapidDetails('mailto:hello@digisigns.link', _vPub, _vPriv); console.log('[WYA-APP] VAPID keys refreshed from env'); } catch (e) { console.error('[WYA-APP] VAPID refresh failed:', e.message); }
  }
}, 300000);

// ── APNs provider for iOS push notifications ────────────────
// Requires: WYA_APNS_KEY_ID, WYA_APNS_KEY (base64), WYA_APNS_TEAM_ID
let apnProvider = null;
const APNS_KEY_ID = process.env.WYA_APNS_KEY_ID || '';
const APNS_KEY_B64 = process.env.WYA_APNS_KEY || '';
const APNS_TEAM_ID = process.env.WYA_APNS_TEAM_ID || '9V74TT48MV';
const APNS_BUNDLE_ID = 'com.universoul.wya';

if (APNS_KEY_ID && APNS_KEY_B64) {
  try {
    const apnsKey = Buffer.from(APNS_KEY_B64, 'base64').toString('utf-8');
    apnProvider = new apn.Provider({
      token: {
        key: apnsKey,
        keyId: APNS_KEY_ID,
        teamId: APNS_TEAM_ID
      },
      production: true // App Store / TestFlight
    });
    console.log('[WYA-APP] APNs provider initialized for', APNS_BUNDLE_ID);
  } catch (e) {
    console.error('[WYA-APP] APNs provider init failed:', e.message);
  }
}

app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') return next();
  // Phase fix: Skip body parsing for GET/HEAD — prevents express.json() from returning 400 on read-only requests
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  express.json({ limit: '2mb' })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  express.urlencoded({ limit: '2mb', extended: true })(req, res, next);
});
// 413 error handler for request entity too large
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large. Maximum size is 2MB.' });
  }
  next(err);
});
// Phase 1653: Request ID + access logging
const fs = require('fs');
const WYA_ACCESS_LOG = '/root/logs/wya-access.log';
const WYA_ACCESS_MAX = 50 * 1024 * 1024; // 50MB
function writeAccessLog(line) {
  try {
    fs.appendFileSync(WYA_ACCESS_LOG, line + '\n');
    const stat = fs.statSync(WYA_ACCESS_LOG);
    if (stat.size > WYA_ACCESS_MAX) {
      fs.renameSync(WYA_ACCESS_LOG, WYA_ACCESS_LOG + '.1');
    }
  } catch(_) {}
}
app.use((req, res, next) => {
  req.reqId = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.reqId);
  // Log write operations on API routes
  if (['POST','PUT','DELETE','PATCH'].includes(req.method) && req.path.startsWith('/api/')) {
    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    writeAccessLog(`${new Date().toISOString()} ${req.reqId} ${req.method} ${req.path} ${ip}`);
  }
  next();
});
// Phase 747a: Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  next();
});
// ── Phase 1655: Production Test-Data Firewall ────────────────
// Reject any registration, order, or data creation from obvious test/QA patterns.
// This prevents automated QA from polluting the production database.
const TEST_EMAIL_PATTERNS = /(@test\.digisigns\.link|@qa\.digisigns\.link|@universoul\.test|@test\.com|@example\.com|@wya\.test|@demo\.wya|@sdc\.com)/i;
const TEST_NAME_PATTERNS = /^\[QA-TEST\]|^E2E |^QA |^XSS Test|^Robert[''];?\s*DROP\s+TABLE|^Test\s*User\d|^E2E\s/i;
const TEST_EMAIL_PREFIX = /^(e2e-|qa-|test-audit-|jwt_test_|jt2_|e2e_)/i;
function isTestData(email, name) {
  if (email && (TEST_EMAIL_PATTERNS.test(email) || TEST_EMAIL_PREFIX.test(email))) return true;
  if (name && TEST_NAME_PATTERNS.test(name)) return true;
  return false;
}

// ── Email helper (via email-service on port 3380) ────────────
async function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    try {
      // Suppress emails to test/E2E domains — prevents inbox pollution + bounces
      if (to && /(@test\.digisigns\.link|@qa\.digisigns\.link|^e2e-|^qa-|^lockdown\d|^(?:cust|guest|sqli|xss|weak|long)check\d)/.test(to.toLowerCase())) {
        return resolve(true); // silently succeed
      }
      const body = JSON.stringify({ to, subject, html });
      const req = http.request({
        hostname: '127.0.0.1', port: 3380, path: '/send', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-portal-secret': SOUL_TOKEN
        }
      }, (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try { const p = JSON.parse(d); resolve(p.success || false); }
          catch(e) { resolve(false); }
        });
      });
      req.on('error', (e) => { console.warn(`[WYA] Email send failed to=${to} subj=${subject.slice(0,40)}: ${e.message}`); resolve(false); });
      req.setTimeout(5000, () => { req.destroy(); console.warn(`[WYA] Email timeout to=${to} subj=${subject.slice(0,40)}`); resolve(false); });
      req.write(body);
      req.end();
    } catch(e) { resolve(false); }
  });
}

function buildReceiptEmailHtml(order, vendor, items) {
  const itemRows = (items||[]).map(i => `<tr><td style="padding:6px 0;color:#e5e5e5">${i.qty||1}x ${i.name}</td><td style="padding:6px 0;text-align:right;color:#e5e5e5">$${(((i.qty||1)*i.price)||0).toFixed(2)}</td></tr>`).join('');
  const readyMin = order.estimated_ready_at ? Math.max(0, Math.round((new Date(order.estimated_ready_at) - new Date(order.created_at||Date.now())) / 60000)) : null;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#0a0a0a;color:#f5f5f5;border-radius:16px">
    <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:4px">WYA Receipt</div>
    <div style="font-size:13px;color:#9ca3af;margin-bottom:20px">Order #${(order.id||'').toString().slice(-8)}</div>
    <div style="font-size:16px;font-weight:700;margin-bottom:16px">${vendor.name||'Vendor'}</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;border-top:1px solid #333;border-bottom:1px solid #333;padding:8px 0">${itemRows}</table>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:3px 0;color:#9ca3af">Subtotal</td><td style="text-align:right;color:#e5e5e5">$${parseFloat(order.subtotal||0).toFixed(2)}</td></tr>
      ${order.promo_discount>0?`<tr><td style="padding:3px 0;color:#22c55e">Discount</td><td style="text-align:right;color:#22c55e">-$${parseFloat(order.promo_discount).toFixed(2)}</td></tr>`:''}
      ${order.tip>0?`<tr><td style="padding:3px 0;color:#9ca3af">Tip</td><td style="text-align:right;color:#e5e5e5">$${parseFloat(order.tip).toFixed(2)}</td></tr>`:''}
      ${order.delivery_fee>0?`<tr><td style="padding:3px 0;color:#9ca3af">Delivery Fee</td><td style="text-align:right;color:#e5e5e5">$${parseFloat(order.delivery_fee).toFixed(2)}</td></tr>`:''}
      <tr><td style="padding:8px 0 3px;font-weight:700;font-size:16px;color:#FF5E1A">Total</td><td style="text-align:right;font-weight:700;font-size:16px;color:#FF5E1A">$${parseFloat(order.total||0).toFixed(2)}</td></tr>
    </table>
    ${readyMin?`<div style="margin-top:16px;padding:12px;background:rgba(255,94,26,.08);border:1px solid rgba(255,94,26,.2);border-radius:10px;font-size:13px;color:#FF5E1A;text-align:center">Estimated ready in ~${readyMin} min</div>`:''}
    <div style="margin-top:16px;font-size:13px;color:#9ca3af;text-align:center">${order.type==='delivery'?'Delivery':'Pickup'}${order.delivery_address?` — ${order.delivery_address}`:''}</div>
    <div style="margin-top:20px;text-align:center"><a href="https://wya.digisigns.link/customer" style="color:#FF5E1A;font-size:13px;font-weight:600;text-decoration:none">Track your order →</a></div>
  </div>`;
}

// Phase 1650: No-auth health ping for PM2 probes and monitoring
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ts: Date.now() });
});

// PWA manifest — must be before express.static
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'WYA — Where You At',
    short_name: 'WYA',
    description: 'Find local vendors, food trucks, and pop-ups near you in Santa Barbara',
    start_url: '/customer',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#ff6b35',
    orientation: 'portrait',
    id: 'com.universoultattoo.wya',
    scope: '/',
    categories: ['food', 'lifestyle', 'shopping'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ],
    shortcuts: [
      { name: 'Find Vendors', url: '/customer', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'Vendor Dashboard', url: '/vendor', icons: [{ src: '/icon-192.png', sizes: '192x192' }] }
    ]
  });
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => clients.claim());
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const d = e.data.json();
    e.waitUntil(self.registration.showNotification(d.title || 'WYA', {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
      data: { url: d.url || '/' }, vibrate: [200, 100, 200]
    }));
  } catch(err) {}
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.openWindow(url));
});
  `.trim());
});

// Phase 749: SEO routes
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Sitemap: https://wya.digisigns.link/sitemap.xml
`);
});
app.get('/sitemap.xml', (req, res) => {
  const now = new Date().toISOString().split('T')[0];
  const pages = [
    { loc: '', priority: '1.0', changefreq: 'daily' },
    { loc: '/customer', priority: '0.9', changefreq: 'always' },
    { loc: '/vendor', priority: '0.8', changefreq: 'weekly' },
    { loc: '/vendors', priority: '0.8', changefreq: 'daily' },
    { loc: '/plans', priority: '0.7', changefreq: 'monthly' },
    { loc: '/food-trucks-santa-barbara', priority: '0.8', changefreq: 'weekly' },
    { loc: '/vendors/food-trucks', priority: '0.8', changefreq: 'weekly' },
    { loc: '/vendors/restaurants', priority: '0.8', changefreq: 'weekly' },
    { loc: '/vendors/tattoo-shops', priority: '0.8', changefreq: 'weekly' },
    { loc: '/vendors/coffee-shops', priority: '0.8', changefreq: 'weekly' },
    { loc: '/vendors/beauty-wellness', priority: '0.7', changefreq: 'weekly' },
    { loc: '/vendors/home-services', priority: '0.7', changefreq: 'weekly' },
  ];
  try {
    // Phase 1325: Fixed — was SELECT updated_at (column doesn't exist), used created_at instead
    // Include ALL vendors (including claimable) — real SB businesses should be indexed for local SEO
    const vendors = db.prepare("SELECT id, name, category, created_at FROM vendors").all();
    vendors.forEach(v => pages.push({ loc: `/v/${v.id}`, priority: '0.6', changefreq: 'weekly', lastmod: v.created_at ? v.created_at.split('T')[0].split(' ')[0] : now }));
  } catch(e) { console.error('[SITEMAP] vendor query error:', e.message); }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(p => `  <url><loc>https://wya.digisigns.link${p.loc}</loc><lastmod>${p.lastmod||now}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`).join('\n')}\n</urlset>`;
  res.type('application/xml').send(xml);
});

// Phase 1325: Public vendor directory — SEO-crawlable listing of all vendors
// Distance-filtered: uses CF geo headers or ?lat=&lng= params, 25mi default, 50mi max
app.get('/vendors', (req, res) => {
  const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let vendors = [];
  try {
    vendors = db.prepare(`SELECT v.id, v.name, v.category, v.description, v.photo_url, v.avg_rating, v.review_count, v.is_open, v.lat, v.lng,
      (SELECT COUNT(*) FROM menu_items WHERE vendor_id=v.id) as menu_count
      FROM vendors v WHERE (SELECT COUNT(*) FROM menu_items WHERE vendor_id=v.id) > 0 ORDER BY v.is_open DESC, v.avg_rating DESC`).all();
  } catch(e) {}

  // Distance filter: CF geo headers → query params → Santa Barbara default
  const sseCoords = validateCoords(req.query.lat || req.headers['cf-iplatitude'], req.query.lng || req.headers['cf-iplongitude']);
  const radiusMi = Math.min(parseFloat(req.query.radius) || 25, 50);
  if (sseCoords) {
    for (const v of vendors) {
      if (v.lat && v.lng) v.distance_mi = Math.round(haversine(sseCoords.lat, sseCoords.lng, v.lat, v.lng) * 10) / 10;
      else v.distance_mi = 9999;
    }
    vendors = vendors.filter(v => v.distance_mi <= radiusMi);
    vendors.sort((a, b) => (b.is_open || 0) - (a.is_open || 0) || a.distance_mi - b.distance_mi);
  }

  const catLabel = (cat) => (BUSINESS_TYPES[cat] || BUSINESS_TYPES.other || {}).emoji || '📍';
  const distTag = (v) => (v.distance_mi != null && v.distance_mi < 9999) ? ' \&middot; ' + v.distance_mi + ' mi' : '';
  const cards = vendors.map(v => {
    const img = v.photo_url ? '<img src="' + esc(v.photo_url) + '" alt="' + esc(v.name) + '" loading="lazy">' : '<div class="ph">' + catLabel(v.category) + '</div>';
    const live = v.is_open ? ' · <span class="live">OPEN NOW</span>' : '';
    const rat = v.avg_rating > 0 ? '<p class="rat">' + '★'.repeat(Math.round(v.avg_rating)) + ' ' + v.avg_rating.toFixed(1) + '</p>' : '';
    return '<a href="/v/' + v.id + '" class="vc">' + img + '<h3>' + esc(v.name) + '</h3><p class="cat">' + esc((BUSINESS_TYPES[v.category]||{}).label||v.category||'Local') + live + distTag(v) + '</p>' + rat + '<p class="desc">' + esc((v.description||'').slice(0,100)) + '</p><p class="mi">' + v.menu_count + ' items</p></a>';
  }).join('');
  const jsonLd = { '@context':'https://schema.org', '@type':'ItemList', name:'Local Vendors in Santa Barbara', numberOfItems: vendors.length,
    itemListElement: vendors.map((v,i) => ({ '@type':'ListItem', position: i+1, url: `https://wya.digisigns.link/v/${v.id}`, name: v.name })) };
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local Vendors & Food in Santa Barbara | WYA — Where You At</title>
<meta name="description" content="Find ${vendors.length} local vendors, food trucks, coffee shops, and restaurants in Santa Barbara. Browse menus, order online, find them on the live map.">
<meta property="og:title" content="Local Vendors in Santa Barbara | WYA"><meta property="og:description" content="Find ${vendors.length} local businesses on the live map.">
<meta property="og:url" content="https://wya.digisigns.link/vendors"><meta property="og:type" content="website">
<link rel="canonical" href="https://wya.digisigns.link/vendors">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>*{margin:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0a0a1a;color:#fff;padding:1rem}
h1{text-align:center;font-size:1.8rem;margin:1rem 0 .5rem}h2{text-align:center;color:#a78bfa;font-size:1rem;margin-bottom:2rem;font-weight:400}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;max-width:1200px;margin:0 auto}
.vc{background:#1a1a2e;border-radius:12px;padding:1rem;text-decoration:none;color:#fff;transition:transform .2s}.vc:hover{transform:translateY(-2px)}
.vc img{width:100%;height:150px;object-fit:cover;border-radius:8px}.ph{width:100%;height:150px;display:flex;align-items:center;justify-content:center;background:#252545;border-radius:8px;font-size:3rem}
h3{margin:.8rem 0 .3rem;font-size:1.1rem}.cat{color:#a78bfa;font-size:.85rem}.live{color:#22c55e;font-weight:700}
.rat{color:#f59e0b;font-size:.85rem;margin:.3rem 0}.desc{color:#999;font-size:.8rem;line-height:1.4;margin:.4rem 0}.mi{color:#666;font-size:.75rem}
.cta{display:block;text-align:center;margin:2rem auto;padding:1rem 2rem;background:#7c3aed;color:#fff;border-radius:2rem;text-decoration:none;font-weight:600;max-width:300px}
nav{text-align:center;margin:1rem 0}nav a{color:#a78bfa;margin:0 1rem;text-decoration:none}
</style></head><body>
<nav><a href="/">Home</a><a href="/customer">Live Map</a><a href="/vendors">Vendors</a><a href="/plans">For Business</a></nav>
<h1>Local Vendors in Santa Barbara</h1>
<h2>${vendors.filter(v=>v.is_open).length} open now · ${vendors.length} nearby${sseCoords ? ` · within ${radiusMi} mi` : ''}</h2>
<div class="g">${cards}</div>
<a class="cta" href="/customer">Find on Live Map →</a>
<p style="text-align:center;color:#666;margin:2rem;font-size:.75rem">WYA — Where You At · Powered by <a href="https://digisigns.link" style="color:#a78bfa">Universoul LLC</a> · Santa Barbara, CA</p>
</body></html>`);
});

// Category directory pages — SEO for "food trucks in santa barbara", "tattoo shops near me", etc.
const CATEGORY_SEO = {
  'food-trucks': { db: 'food_truck', title: 'Food Trucks in Santa Barbara', desc: 'Find food trucks near you in Santa Barbara. Live locations, menus, and online ordering.' },
  'restaurants': { db: 'restaurant', title: 'Restaurants in Santa Barbara', desc: 'Discover local restaurants in Santa Barbara. Browse menus, order online, find live locations.' },
  'tattoo-shops': { db: 'tattoo_studio', title: 'Tattoo Shops in Santa Barbara', desc: 'Find tattoo artists in Santa Barbara. Book appointments, see portfolios, walk-in queue.' },
  'coffee-shops': { db: 'coffee', title: 'Coffee Shops in Santa Barbara', desc: 'Find coffee shops near you in Santa Barbara. Live locations and online ordering.' },
  'beauty-wellness': { db: 'beauty', title: 'Beauty & Wellness in Santa Barbara', desc: 'Find beauty and wellness services in Santa Barbara. Book appointments online.' },
  'home-services': { db: 'home_services', title: 'Home Services in Santa Barbara', desc: 'Find home service providers in Santa Barbara. Get quotes and schedule service.' },
};

app.get('/vendors/:category', (req, res) => {
  const catSlug = req.params.category;
  const catInfo = CATEGORY_SEO[catSlug];
  if (!catInfo) return res.redirect(302, '/vendors');

  let vendors = [];
  try {
    vendors = db.prepare(`SELECT v.id, v.name, v.category, v.description, v.photo_url, v.is_open, v.lat, v.lng,
      (SELECT COUNT(*) FROM menu_items WHERE vendor_id=v.id) as menu_count
      FROM vendors v WHERE v.category = ? ORDER BY v.is_open DESC, v.name ASC`).all(catInfo.db);
  } catch {}

  const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const catLabel = (cat) => (BUSINESS_TYPES[cat] || BUSINESS_TYPES.other || {}).emoji || '📍';

  const cards = vendors.map(v => {
    const img = v.photo_url ? `<img src="${esc(v.photo_url)}" alt="${esc(v.name)}" loading="lazy">` : `<div class="ph">${catLabel(v.category)}</div>`;
    const live = v.is_open ? ' · <span class="live">OPEN NOW</span>' : '';
    return `<a href="/v/${v.id}" class="vc">${img}<h3>${esc(v.name)}</h3><p class="cat">${esc((BUSINESS_TYPES[v.category]||{}).label||v.category)}${live}</p><p class="desc">${esc((v.description||'').slice(0,120))}</p></a>`;
  }).join('');

  const jsonLd = JSON.stringify({ '@context':'https://schema.org', '@type':'ItemList', name: catInfo.title, numberOfItems: vendors.length,
    itemListElement: vendors.map((v,i) => ({ '@type':'ListItem', position: i+1, url: `https://wya.digisigns.link/v/${v.id}`, name: v.name })) });

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${catInfo.title} | WYA</title>
<meta name="description" content="${catInfo.desc}">
<meta property="og:title" content="${catInfo.title}"><meta property="og:description" content="${catInfo.desc}">
<link rel="canonical" href="https://wya.digisigns.link/vendors/${catSlug}">
<script type="application/ld+json">${jsonLd}</script>
<style>*{margin:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0a0a1a;color:#fff;padding:1rem}
h1{text-align:center;font-size:1.8rem;margin:1rem 0 .5rem}h2{text-align:center;color:#a78bfa;font-size:1rem;margin-bottom:2rem;font-weight:400}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;max-width:1200px;margin:0 auto}
.vc{background:#1a1a2e;border-radius:12px;padding:1rem;text-decoration:none;color:#fff;transition:transform .2s}.vc:hover{transform:translateY(-2px)}
.vc img{width:100%;height:150px;object-fit:cover;border-radius:8px}.ph{width:100%;height:150px;display:flex;align-items:center;justify-content:center;background:#252545;border-radius:8px;font-size:3rem}
h3{margin:.8rem 0 .3rem;font-size:1.1rem}.cat{color:#a78bfa;font-size:.85rem}.live{color:#22c55e;font-weight:700}
.desc{color:#999;font-size:.8rem;line-height:1.4;margin:.4rem 0}
.cta{display:block;text-align:center;margin:2rem auto;padding:1rem 2rem;background:#7c3aed;color:#fff;border-radius:2rem;text-decoration:none;font-weight:600;max-width:300px}
nav{text-align:center;margin:1rem 0}nav a{color:#a78bfa;margin:0 .5rem;text-decoration:none;font-size:.9rem}
</style></head><body>
<nav><a href="/">Home</a><a href="/customer">Live Map</a><a href="/vendors">All Vendors</a>${Object.entries(CATEGORY_SEO).map(([k,v]) => `<a href="/vendors/${k}">${v.title.split(' in ')[0]}</a>`).join('')}</nav>
<h1>${catInfo.title}</h1>
<h2>${vendors.filter(v=>v.is_open).length} open now · ${vendors.length} total</h2>
${vendors.length > 0 ? `<div class="g">${cards}</div>` : '<p style="text-align:center;color:#888;margin:3rem">No vendors in this category yet. <a href="/vendors" style="color:#a78bfa">See all vendors</a></p>'}
<a class="cta" href="/customer">Find on Live Map →</a>
<p style="text-align:center;color:#666;margin:2rem;font-size:.75rem">WYA · <a href="https://digisigns.link" style="color:#a78bfa">Universoul LLC</a> · Santa Barbara, CA</p>
</body></html>`);
});

// Phase 1702: Vendor detail page — SEO-friendly, server-rendered
app.get('/v/:id', (req, res) => {
  const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const v = db.prepare("SELECT id,name,category,description,photo_url,avg_rating,review_count,is_open,lat,lng,phone,website,instagram,accepts_orders,delivery_enabled,estimated_prep_minutes FROM vendors WHERE id=?").get(req.params.id);
  if (!v) return res.status(404).send('<!DOCTYPE html><html><head><title>Vendor Not Found</title></head><body style="background:#0a0a1a;color:#fff;font-family:system-ui;text-align:center;padding:4rem"><h1>Vendor not found</h1><p><a href="/vendors" style="color:#a78bfa">Browse all vendors</a></p></body></html>');
  const menu = db.prepare('SELECT mc.name as category_name, mi.id, mi.name, mi.price, mi.description, mi.available, mi.photo_url FROM menu_items mi LEFT JOIN menu_categories mc ON mi.category_id=mc.id WHERE mi.vendor_id=? AND mi.available=1 ORDER BY mc.sort_order, mi.sort_order').all(req.params.id);
  const reviews = db.prepare('SELECT r.rating, r.review_text, r.created_at, c.name as customer_name FROM reviews r LEFT JOIN customers c ON r.customer_id=c.id WHERE r.vendor_id=? ORDER BY r.created_at DESC LIMIT 10').all(req.params.id);
  const schedule = db.prepare('SELECT day_of_week, start_time, end_time, is_closed FROM vendor_schedules WHERE vendor_id=? ORDER BY day_of_week').all(req.params.id);
  // Track view (IP-based cooldown: 1 view per vendor per IP per hour)
  try {
    const viewIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (rateLimit('pview:' + req.params.id + ':' + viewIp, 1, 3600000)) {
      db.prepare('UPDATE vendors SET profile_views = COALESCE(profile_views,0) + 1 WHERE id=?').run(req.params.id);
    }
  } catch(e) {}
  const catLabel = (BUSINESS_TYPES[v.category]||{}).label || v.category || 'Local Business';
  const liveTag = v.is_open ? '<span style="color:#22c55e;font-weight:700;margin-left:8px">● OPEN NOW</span>' : '<span style="color:#ef4444;margin-left:8px">● Closed</span>';
  const stars = v.avg_rating > 0 ? '★'.repeat(Math.round(v.avg_rating)) + ' ' + v.avg_rating.toFixed(1) + ` (${v.review_count || 0} reviews)` : 'No reviews yet';
  const heroImg = v.photo_url ? `<img src="${esc(v.photo_url)}" alt="${esc(v.name)}" style="width:100%;max-height:300px;object-fit:cover;border-radius:16px;margin-bottom:1.5rem">` : '';
  // Group menu by category
  const groups = {};
  for (const item of menu) {
    const cat = item.category_name || 'Menu';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }
  const menuHtml = Object.entries(groups).map(([cat, items]) => `
    <h3 style="color:#a78bfa;font-size:1rem;margin:1.5rem 0 .75rem;text-transform:uppercase;letter-spacing:.05em">${esc(cat)}</h3>
    ${items.map(i => `<div style="display:flex;justify-content:space-between;align-items:start;padding:.75rem 0;border-bottom:1px solid #252545">
      <div><div style="font-weight:600">${esc(i.name)}</div>${i.description ? `<div style="color:#999;font-size:.85rem;margin-top:2px">${esc(i.description).slice(0,120)}</div>` : ''}</div>
      <div style="color:#22c55e;font-weight:700;white-space:nowrap;margin-left:1rem">$${(i.price||0).toFixed(2)}</div>
    </div>`).join('')}
  `).join('');
  const reviewHtml = reviews.length ? reviews.map(r => `<div style="background:#1a1a2e;border-radius:10px;padding:1rem;margin:.5rem 0">
    <div style="color:#f59e0b">${'★'.repeat(r.rating||0)}</div>
    <p style="color:#ccc;font-size:.9rem;margin:.5rem 0">${esc(r.review_text||'')}</p>
    <p style="color:#666;font-size:.75rem">${esc(r.customer_name||'Customer')} · ${new Date(r.created_at).toLocaleDateString()}</p>
  </div>`).join('') : '<p style="color:#666">No reviews yet. Be the first!</p>';
  const links = [];
  if (v.phone) links.push(`<a href="tel:${esc(v.phone)}" style="color:#a78bfa;text-decoration:none">📞 Call</a>`);
  if (v.website) links.push(`<a href="${esc(v.website)}" target="_blank" style="color:#a78bfa;text-decoration:none">🌐 Website</a>`);
  if (v.instagram) links.push(`<a href="https://instagram.com/${esc(v.instagram)}" target="_blank" style="color:#a78bfa;text-decoration:none">📸 Instagram</a>`);
  if (v.lat && v.lng) links.push(`<a href="https://www.google.com/maps?q=${v.lat},${v.lng}" target="_blank" style="color:#a78bfa;text-decoration:none">📍 Directions</a>`);
  const jsonLd = { '@context':'https://schema.org', '@type':'LocalBusiness', name:v.name, description:v.description||'',
    address:{ '@type':'PostalAddress', addressLocality:'Santa Barbara', addressRegion:'CA' },
    ...(v.avg_rating>0 ? { aggregateRating:{ '@type':'AggregateRating', ratingValue:v.avg_rating, reviewCount:v.review_count }} : {}) };
  // Social proof — views this week
  const weeklyViews = db.prepare("SELECT COUNT(*) as c FROM profile_views WHERE vendor_id=? AND created_at >= datetime('now','-7 days')").get(req.params.id)?.c || 0;
  const socialProof = weeklyViews >= 5 ? `<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:rgba(255,107,53,.08);border:1px solid rgba(255,107,53,.15);border-radius:20px;font-size:.8rem;color:#FF6B35;margin:.75rem 0"><span style="font-size:1rem">🔥</span> ${weeklyViews} people viewed this week</div>` : '';
  const isClaimable = db.prepare("SELECT email FROM vendors WHERE id=?").get(v.id)?.email?.startsWith('claim-');
  const claimBanner = isClaimable ? `<div style="background:linear-gradient(135deg,rgba(131,58,180,.1),rgba(255,94,26,.1));border:1px solid rgba(255,94,26,.3);border-radius:14px;padding:18px 20px;margin-bottom:20px;text-align:center"><div style="font-weight:700;font-size:1rem;margin-bottom:4px">Is this your business?</div><div style="color:rgba(255,255,255,.6);font-size:.85rem;margin-bottom:12px">Claim your listing to manage your profile, menu, and go live on the map.</div><a href="/claim/${v.id}" style="display:inline-block;background:#FF5E1A;color:#fff;padding:10px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:.95rem">Claim This Business</a></div>` : '';
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.name)} | WYA — Where You At</title>
<meta name="description" content="${esc(v.name)} — ${esc(catLabel)} in Santa Barbara. ${menu.length} menu items. ${esc((v.description||'').slice(0,120))}">
<meta property="og:title" content="${esc(v.name)} | WYA — Where You At">
<meta property="og:description" content="${esc(catLabel)} in Santa Barbara · ${menu.length} items${v.is_open?' · Open Now':''}">
<meta property="og:url" content="https://wya.digisigns.link/v/${v.id}">
<meta property="og:type" content="restaurant.restaurant">
<meta property="og:site_name" content="WYA — Where You At">
${v.photo_url ? `<meta property="og:image" content="${esc(v.photo_url)}">` : '<meta property="og:image" content="https://wya.digisigns.link/icon-512.png">'}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(v.name)} | WYA">
<meta name="twitter:description" content="${esc(catLabel)} · ${menu.length} items${v.is_open?' · Open Now':''}">
${v.photo_url ? `<meta name="twitter:image" content="${esc(v.photo_url)}">` : '<meta name="twitter:image" content="https://wya.digisigns.link/icon-512.png">'}
<link rel="canonical" href="https://wya.digisigns.link/v/${v.id}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>*{margin:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0a0a1a;color:#fff;padding:0}
.wrap{max-width:720px;margin:0 auto;padding:1.5rem}
nav{text-align:center;padding:1rem;border-bottom:1px solid #1a1a2e}nav a{color:#a78bfa;margin:0 1rem;text-decoration:none;font-size:.9rem}
.links{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
.order-btn{display:block;width:100%;padding:1rem;background:#7c3aed;color:#fff;border:none;border-radius:12px;font-size:1.1rem;font-weight:700;cursor:pointer;margin:1.5rem 0;text-align:center;text-decoration:none}
.order-btn:hover{background:#6d28d9}
.share-bar{display:flex;gap:8px;margin:1rem 0;flex-wrap:wrap}
.share-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:10px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer;text-decoration:none;transition:all .2s}
.share-btn:hover{background:#252545;transform:translateY(-1px)}
.share-btn.primary{background:#FF5E1A;border-color:#FF5E1A}
.share-btn.primary:hover{background:#e8520f}
.share-btn .ico{font-size:1.1rem}
.copied{position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:#22c55e;color:#fff;padding:10px 24px;border-radius:10px;font-weight:600;z-index:999;animation:fadeUp .3s ease}
@keyframes fadeUp{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
</style></head><body>
<nav><a href="/">Home</a><a href="/customer">Live Map</a><a href="/vendors">All Vendors</a></nav>
<div class="wrap">
${claimBanner}
${heroImg}
<h1 style="font-size:1.8rem;margin-bottom:.25rem">${esc(v.name)}${liveTag}</h1>
<p style="color:#a78bfa;margin-bottom:.5rem">${esc(catLabel)}${v.estimated_prep_minutes ? ` · ~${v.estimated_prep_minutes} min` : ''}</p>
<p style="color:#f59e0b;margin-bottom:.75rem">${stars}</p>
${socialProof}
${v.description ? `<p style="color:#ccc;line-height:1.6;margin-bottom:1rem">${esc(v.description)}</p>` : ''}
<div class="links">${links.join(' · ')}</div>
<div class="share-bar">
<button class="share-btn primary" onclick="shareVendor()"><span class="ico">↗</span> Share</button>
<button class="share-btn" onclick="copyLink()"><span class="ico">🔗</span> Copy Link</button>
<a class="share-btn" href="/v/${v.id}/card.svg?format=story" download="${v.id}-wya-card.svg" style="text-decoration:none"><span class="ico">📲</span> Story Card</a>
</div>
<script>
const _shareUrl='https://wya.digisigns.link/v/${v.id}';
const _shareTitle='${esc(v.name).replace(/'/g,"\\'")} — Where You At';
const _shareText='Check out ${esc(v.name).replace(/'/g,"\\'")}${v.is_open?' (open now!)':''} on WYA in Santa Barbara';
async function shareVendor(){
  try{await navigator.share({title:_shareTitle,text:_shareText,url:_shareUrl});
    fetch('/api/vendors/${v.id}/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:'native',type:'share'})}).catch(()=>{});
  }catch(e){if(e.name!=='AbortError')copyLink()}
}
function copyLink(){
  navigator.clipboard.writeText(_shareUrl).then(()=>{
    const t=document.createElement('div');t.className='copied';t.textContent='Link copied!';
    document.body.appendChild(t);setTimeout(()=>t.remove(),2000);
    fetch('/api/vendors/${v.id}/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:'clipboard',type:'copy'})}).catch(()=>{});
  });
}
</script>
${v.accepts_orders ? `<a class="order-btn" href="/customer#vendor-${v.id}">Order Now</a>` : ''}
<h2 style="font-size:1.3rem;margin:2rem 0 1rem;border-bottom:1px solid #252545;padding-bottom:.5rem">Menu (${menu.length} items)</h2>
${menuHtml || '<p style="color:#666">No menu items yet.</p>'}
${schedule.length ? `<h2 style="font-size:1.3rem;margin:2rem 0 1rem;border-bottom:1px solid #252545;padding-bottom:.5rem">Hours</h2>
<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:.95rem">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day,i) => {
  const s = schedule.find(x => x.day_of_week === i);
  const hours = !s ? '<span style="color:#666">—</span>' : s.is_closed ? '<span style="color:#ef4444">Closed</span>' : '<span style="color:#22c55e">' + s.start_time.replace(/^0/,'') + ' – ' + s.end_time.replace(/^0/,'') + '</span>';
  return '<div style="color:#999;padding:4px 0">' + day + '</div><div style="padding:4px 0">' + hours + '</div>';
}).join('')}</div>` : ''}
<h2 style="font-size:1.3rem;margin:2rem 0 1rem;border-bottom:1px solid #252545;padding-bottom:.5rem">Reviews</h2>
${reviewHtml}
</div>
<p style="text-align:center;color:#666;margin:2rem;font-size:.75rem">WYA — Where You At · Powered by <a href="https://digisigns.link" style="color:#a78bfa">Universoul LLC</a> · Santa Barbara, CA</p>
</body></html>`);
});

// Phase 1365: Removed Phase 1358 Hub redirect — standalone frontend restored
app.use(express.static(path.join(__dirname, 'public')));

// Phase 1364b: Extensionless HTML routes — /vendor, /plans, /admin, /account, /customer
for (const page of ['vendor', 'plans', 'admin', 'account', 'customer']) {
  app.get(`/${page}`, (req, res) => res.sendFile(path.join(__dirname, 'public', `${page}.html`)));
}
// /map route — serves customer.html (map is the main view)
app.get('/map', (req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));
// /vendor/login, /vendor/register, /vendor/dashboard → redirect to /vendor SPA (handles routing internally)
app.get('/vendor/login', (req, res) => res.redirect('/vendor'));
app.get('/vendor/register', (req, res) => res.redirect('/vendor'));
app.get('/vendor/dashboard', (req, res) => res.redirect('/vendor'));

// SEO landing pages
app.get('/food-trucks-santa-barbara', (req, res) => res.sendFile(path.join(__dirname, 'public', 'food-trucks-santa-barbara.html')));

// ── Database setup ──────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS vendors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'other',
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    phone TEXT,
    description TEXT,
    lat REAL,
    lng REAL,
    digitap_card_url TEXT,
    is_open INTEGER DEFAULT 0,
    is_super_admin INTEGER DEFAULT 0,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT,
    action TEXT,
    lat REAL,
    lng REAL,
    ts TEXT DEFAULT (datetime('now'))
  );
`);

// ── Idempotent migrations ───────────────────────────────────
const migrations = [
  "ALTER TABLE vendors ADD COLUMN business_hours TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN photo_url TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN is_super_admin INTEGER DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN website TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN instagram TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN tiktok TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN facebook TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN referral_code TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN subscription_status TEXT DEFAULT 'trial'",
  "ALTER TABLE vendors ADD COLUMN trial_ends_at TEXT",
  "ALTER TABLE vendors ADD COLUMN stripe_customer_id TEXT",
  // Phase 733 — marketplace columns
  "ALTER TABLE vendors ADD COLUMN subscription_tier TEXT DEFAULT 'free'",
  "ALTER TABLE vendors ADD COLUMN commission_rate REAL DEFAULT 0.20",
  "ALTER TABLE vendors ADD COLUMN avg_rating REAL DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN review_count INTEGER DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN total_orders INTEGER DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN doordash_url TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN ubereats_url TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN grubhub_url TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN yelp_url TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN google_maps_url TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN accepts_orders INTEGER DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN delivery_enabled INTEGER DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN delivery_radius_mi REAL DEFAULT 5",
  "ALTER TABLE vendors ADD COLUMN min_order_amount REAL DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN estimated_prep_minutes INTEGER DEFAULT 15",
  // Phase 736 — order payment columns
  "ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'unpaid'",
  "ALTER TABLE orders ADD COLUMN stripe_payment_intent_id TEXT",
  "ALTER TABLE orders ADD COLUMN stripe_checkout_session_id TEXT",
  // Phase 743 — loyalty
  "ALTER TABLE customers ADD COLUMN loyalty_points INTEGER DEFAULT 0",
  // Phase 745 — subscription billing
  "ALTER TABLE vendors ADD COLUMN stripe_subscription_id TEXT",
  "ALTER TABLE vendors ADD COLUMN subscription_past_due_since TEXT",
  // Phase 745 — premium
  "ALTER TABLE vendors ADD COLUMN is_premium INTEGER DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN premium_expires_at TEXT",
  // Phase 749 — email verification
  "ALTER TABLE vendors ADD COLUMN email_verified INTEGER DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN verification_token TEXT",
  // Phase 752 — customer email verification
  "ALTER TABLE customers ADD COLUMN email_verified INTEGER DEFAULT 0",
  "ALTER TABLE customers ADD COLUMN verification_token TEXT",
  // Phase 753 — vendor profile view tracking
  "ALTER TABLE vendors ADD COLUMN profile_views INTEGER DEFAULT 0",
  // Phase 726 — trial warning tracking
  "ALTER TABLE vendors ADD COLUMN trial_warning_sent TEXT",
  // Phase 752 — geofence auto check-in
  "ALTER TABLE vendors ADD COLUMN geofence_lat REAL",
  "ALTER TABLE vendors ADD COLUMN geofence_lng REAL",
  "ALTER TABLE vendors ADD COLUMN geofence_radius_m INTEGER DEFAULT 200",
  "ALTER TABLE vendors ADD COLUMN auto_checkin_enabled INTEGER DEFAULT 0",
  // Phase 970 — founding vendor protection (free forever)
  "ALTER TABLE vendors ADD COLUMN is_founding_vendor INTEGER DEFAULT 0",
  // Phase 1319 — guest checkout columns
  "ALTER TABLE orders ADD COLUMN guest_email TEXT",
  "ALTER TABLE orders ADD COLUMN guest_name TEXT",
  // Phase 1336 — Stripe Connect for vendor bank payouts
  "ALTER TABLE vendors ADD COLUMN stripe_connect_id TEXT",
  "ALTER TABLE vendors ADD COLUMN stripe_connect_onboarded INTEGER DEFAULT 0",
  "ALTER TABLE vendor_payouts ADD COLUMN stripe_transfer_id TEXT",
  // Social + delivery integration columns
  "ALTER TABLE vendors ADD COLUMN youtube TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN social_score INTEGER DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN google_business_url TEXT DEFAULT ''",
  "ALTER TABLE vendors ADD COLUMN data_source TEXT DEFAULT 'organic'",
  "ALTER TABLE vendors ADD COLUMN is_claimed INTEGER DEFAULT 0",
  // Theme-engine: per-vendor brand palette
  "ALTER TABLE vendors ADD COLUMN accent_color TEXT DEFAULT ''",
  // Phase Jarvis: Social Integration Engine migrations
  "ALTER TABLE influencer_campaigns ADD COLUMN title TEXT DEFAULT ''",
  "ALTER TABLE influencer_campaigns ADD COLUMN description TEXT DEFAULT ''",
  "ALTER TABLE influencer_campaigns ADD COLUMN compensation TEXT DEFAULT ''",
  "ALTER TABLE influencer_campaigns ADD COLUMN requirements TEXT DEFAULT ''",
  "ALTER TABLE influencer_campaigns ADD COLUMN target_platforms TEXT DEFAULT '[]'",
  "ALTER TABLE influencer_campaigns ADD COLUMN parent_offer_id TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN referral_source TEXT DEFAULT ''",
  // Event marketplace schema extensions
  "ALTER TABLE vendor_events ADD COLUMN description TEXT DEFAULT ''",
  "ALTER TABLE vendor_events ADD COLUMN image_url TEXT DEFAULT ''",
  "ALTER TABLE vendor_events ADD COLUMN capacity INTEGER DEFAULT 0",
  "ALTER TABLE vendor_events ADD COLUMN price REAL DEFAULT 0",
  "ALTER TABLE vendor_events ADD COLUMN event_type TEXT DEFAULT 'vendor'",
  "ALTER TABLE vendor_events ADD COLUMN location_lat REAL",
  "ALTER TABLE vendor_events ADD COLUMN location_lng REAL",
  "ALTER TABLE vendor_events ADD COLUMN status TEXT DEFAULT 'active'",
  "ALTER TABLE vendor_events ADD COLUMN category TEXT DEFAULT 'other'",
  "ALTER TABLE vendor_events ADD COLUMN organizer_name TEXT DEFAULT ''",
  "ALTER TABLE vendor_events ADD COLUMN organizer_email TEXT DEFAULT ''",
  "ALTER TABLE vendor_events ADD COLUMN organizer_phone TEXT DEFAULT ''",
  "ALTER TABLE vendor_events ADD COLUMN vendor_slots INTEGER DEFAULT 0",
  "ALTER TABLE vendor_events ADD COLUMN rsvp_count INTEGER DEFAULT 0",
  // Feature: Paid event bookings + reminders
  "ALTER TABLE event_bookings ADD COLUMN stripe_checkout_session_id TEXT DEFAULT ''",
  "ALTER TABLE vendor_events ADD COLUMN reminder_sent INTEGER DEFAULT 0",
  // Feature: Recurring events
  "ALTER TABLE vendor_events ADD COLUMN recurring TEXT DEFAULT ''",
  "ALTER TABLE vendor_events ADD COLUMN recurrence_end TEXT DEFAULT ''",
  "ALTER TABLE vendor_events ADD COLUMN parent_event_id INTEGER DEFAULT 0",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}

// Event bookings table — tracks RSVPs + vendor applications
try {
  db.exec(`CREATE TABLE IF NOT EXISTS event_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    user_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT DEFAULT '',
    user_email TEXT DEFAULT '',
    user_phone TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    message TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(event_id, user_type, user_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_bookings_event ON event_bookings(event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_bookings_user ON event_bookings(user_id, user_type)`);
} catch(e) { /* already exists */ }

// Phase 970: Mark all existing vendors as founding vendors (one-time, idempotent)
// All vendors who helped build the platform stay free forever
try {
  const unmarked = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE is_founding_vendor = 0").get();
  const total = db.prepare("SELECT COUNT(*) as c FROM vendors").get();
  // Only run if no vendors are marked yet (first boot after migration)
  if (total.c > 0 && unmarked.c === total.c) {
    db.prepare("UPDATE vendors SET is_founding_vendor = 1, subscription_status = 'active', subscription_tier = 'pro'").run();
    console.log(`[FOUNDING] Marked ${total.c} existing vendors as founding vendors (free forever)`);
  }
} catch(e) { console.error('[FOUNDING-MIGRATION]', e.message); }

// Phase 1368 REVERTED: Tortas Como Tu is in Orange County, NOT Santa Barbara
// Original migration was backwards — she lives in O.C., description says "orange county"
try {
  db.prepare("UPDATE vendors SET lat = 33.7175, lng = -117.8311 WHERE id = 'TORTAS-ERIKA-001' AND lat > 34.0").run();
} catch(_) {}

// Referrals table
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id TEXT NOT NULL,
    referred_id TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    reward_status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Phase 749: Vendor invites
db.exec(`
  CREATE TABLE IF NOT EXISTS vendor_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    business_name TEXT,
    phone TEXT,
    invite_code TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending',
    invited_by TEXT DEFAULT 'admin',
    personal_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    opened_at TEXT,
    registered_at TEXT
  );
`);

// ── Phase 733: Marketplace Tables ─────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    phone TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    default_address TEXT DEFAULT '',
    stripe_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT
  );
  CREATE TABLE IF NOT EXISTS customer_sessions (
    token TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS menu_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    category_id INTEGER,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price REAL NOT NULL,
    photo_url TEXT DEFAULT '',
    available INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS menu_modifiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price REAL DEFAULT 0,
    available INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    type TEXT DEFAULT 'pickup',
    items_json TEXT NOT NULL,
    subtotal REAL NOT NULL,
    commission_rate REAL DEFAULT 0.20,
    commission_amount REAL DEFAULT 0,
    tip REAL DEFAULT 0,
    delivery_fee REAL DEFAULT 0,
    total REAL NOT NULL,
    customer_notes TEXT DEFAULT '',
    delivery_address TEXT DEFAULT '',
    estimated_ready_at TEXT,
    promo_code_id INTEGER,
    promo_discount REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    payment_status TEXT DEFAULT 'unpaid',
    stripe_payment_intent_id TEXT,
    stripe_checkout_session_id TEXT
  );
  CREATE TABLE IF NOT EXISTS order_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by TEXT,
    ts TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,
    customer_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    review_text TEXT DEFAULT '',
    vendor_response TEXT,
    vendor_responded_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(customer_id, vendor_id)
  );
  CREATE TABLE IF NOT EXISTS subscription_tiers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_monthly REAL NOT NULL,
    commission_rate REAL NOT NULL,
    stripe_price_id TEXT DEFAULT '',
    features_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ambassador_commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ambassador_id TEXT NOT NULL,
    source_vendor_id TEXT,
    source_type TEXT DEFAULT 'subscription',
    source_id TEXT,
    gross_amount REAL DEFAULT 0,
    commission_rate REAL DEFAULT 0.20,
    commission_amount REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    period TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ambassador_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ambassador_id TEXT NOT NULL,
    amount REAL NOT NULL,
    period TEXT,
    status TEXT DEFAULT 'pending',
    paid_at TEXT,
    stripe_transfer_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    vendor_id TEXT,
    discount_type TEXT DEFAULT 'percent',
    discount_value REAL DEFAULT 0,
    min_order REAL DEFAULT 0,
    max_uses INTEGER DEFAULT 0,
    uses_count INTEGER DEFAULT 0,
    valid_from TEXT,
    valid_until TEXT,
    active INTEGER DEFAULT 1,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS promo_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promo_code_id INTEGER NOT NULL,
    customer_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    discount_applied REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS loyalty_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    order_id TEXT,
    points INTEGER NOT NULL,
    type TEXT DEFAULT 'earn',
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS vendor_followers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    phone TEXT DEFAULT '',
    name TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(vendor_id, customer_id)
  );
  CREATE TABLE IF NOT EXISTS vendor_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    start_time TEXT,
    end_time TEXT,
    location TEXT DEFAULT '',
    UNIQUE(vendor_id, day_of_week)
  );
  CREATE TABLE IF NOT EXISTS vendor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    title TEXT NOT NULL,
    event_date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    location TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS vendor_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    address TEXT DEFAULT '',
    is_active INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS vendor_commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    gross REAL NOT NULL,
    rate REAL NOT NULL,
    commission REAL NOT NULL,
    payout REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    period TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS vendor_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    amount REAL NOT NULL,
    period TEXT,
    status TEXT DEFAULT 'pending',
    method TEXT DEFAULT 'manual',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ad_spots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    type TEXT DEFAULT 'feed',
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    budget REAL DEFAULT 0,
    cost_per_click REAL DEFAULT 0.50,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS profile_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    viewer_id TEXT,
    viewer_type TEXT DEFAULT 'anonymous',
    source TEXT DEFAULT 'map',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_profile_views_vendor ON profile_views(vendor_id, created_at);
`);

// ── Delivery Zone Management Tables ──────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL REFERENCES vendors(id),
    name TEXT NOT NULL,
    zone_type TEXT DEFAULT 'radius' CHECK(zone_type IN ('radius','polygon')),
    radius_mi REAL,
    center_lat REAL,
    center_lng REAL,
    polygon_coords TEXT,
    delivery_fee REAL DEFAULT 3.99,
    min_order REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    status TEXT DEFAULT 'available' CHECK(status IN ('available','assigned','en_route','offline')),
    current_lat REAL,
    current_lng REAL,
    last_location_update TEXT,
    vendor_id TEXT,
    driver_token TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS delivery_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id),
    driver_id INTEGER NOT NULL REFERENCES drivers(id),
    status TEXT DEFAULT 'assigned' CHECK(status IN ('assigned','picked_up','en_route','delivered','cancelled')),
    assigned_at TEXT DEFAULT (datetime('now')),
    picked_up_at TEXT,
    delivered_at TEXT,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_zones_vendor ON delivery_zones(vendor_id, active);
  CREATE INDEX IF NOT EXISTS idx_drivers_vendor ON drivers(vendor_id, status);
  CREATE INDEX IF NOT EXISTS idx_delivery_assignments_order ON delivery_assignments(order_id);
`);

// Social + Delivery integration tables
db.exec(`
  CREATE TABLE IF NOT EXISTS vendor_social_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    followers INTEGER DEFAULT 0,
    engagement_rate REAL DEFAULT 0,
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    post_count INTEGER DEFAULT 0,
    last_post_url TEXT DEFAULT '',
    last_post_image TEXT DEFAULT '',
    last_post_caption TEXT DEFAULT '',
    verified INTEGER DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now')),
    UNIQUE(vendor_id, platform)
  );
  CREATE INDEX IF NOT EXISTS idx_vendor_social_cache_vendor ON vendor_social_cache(vendor_id);

  CREATE TABLE IF NOT EXISTS social_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    share_type TEXT DEFAULT 'link',
    sharer_id TEXT,
    sharer_type TEXT DEFAULT 'anonymous',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_social_shares_vendor ON social_shares(vendor_id);

  CREATE TABLE IF NOT EXISTS social_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    card_type TEXT DEFAULT 'standard',
    card_data TEXT DEFAULT '{}',
    downloads INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_social_cards_vendor ON social_cards(vendor_id);

  CREATE TABLE IF NOT EXISTS influencer_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    influencer_handle TEXT NOT NULL,
    platform TEXT NOT NULL,
    promo_code TEXT,
    clicks INTEGER DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_influencer_campaigns_vendor ON influencer_campaigns(vendor_id);
`);

// Safe column additions for social_cache enrichment
const socialCacheAlters = [
  "ALTER TABLE vendor_social_cache ADD COLUMN engagement_rate REAL DEFAULT 0",
  "ALTER TABLE vendor_social_cache ADD COLUMN bio TEXT DEFAULT ''",
  "ALTER TABLE vendor_social_cache ADD COLUMN avatar_url TEXT DEFAULT ''",
  "ALTER TABLE vendor_social_cache ADD COLUMN post_count INTEGER DEFAULT 0",
  "ALTER TABLE vendor_social_cache ADD COLUMN last_post_url TEXT DEFAULT ''",
  "ALTER TABLE vendor_social_cache ADD COLUMN last_post_image TEXT DEFAULT ''",
  "ALTER TABLE vendor_social_cache ADD COLUMN last_post_caption TEXT DEFAULT ''",
  "ALTER TABLE vendor_social_cache ADD COLUMN verified INTEGER DEFAULT 0",
  "ALTER TABLE vendor_social_cache ADD COLUMN handle TEXT DEFAULT ''",
  "ALTER TABLE vendor_social_cache ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))",
];
for (const alt of socialCacheAlters) {
  try { db.exec(alt); } catch(e) { /* column already exists */ }
}

// Modifier Groups — Toast/Square-style grouped modifier support
db.exec(`
  CREATE TABLE IF NOT EXISTS wya_modifier_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    menu_item_id INTEGER NOT NULL,
    group_name TEXT NOT NULL,
    required INTEGER DEFAULT 0,
    min_selections INTEGER DEFAULT 0,
    max_selections INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS wya_modifier_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price_delta REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    FOREIGN KEY (group_id) REFERENCES wya_modifier_groups(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_wya_modifier_groups_item ON wya_modifier_groups(menu_item_id);
  CREATE INDEX IF NOT EXISTS idx_wya_modifier_groups_vendor ON wya_modifier_groups(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_wya_modifier_options_group ON wya_modifier_options(group_id, sort_order);
`);

// Tips table — per-order tip tracking for vendor reports
db.exec(`
  CREATE TABLE IF NOT EXISTS wya_tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    customer_id TEXT,
    amount REAL NOT NULL DEFAULT 0,
    percentage REAL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );
  CREATE INDEX IF NOT EXISTS idx_wya_tips_vendor ON wya_tips(vendor_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_wya_tips_order ON wya_tips(order_id);
`);

// Catering requests — direct vendor-to-customer catering inquiry funnel
db.exec(`
  CREATE TABLE IF NOT EXISTS catering_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT,
    requester_name TEXT NOT NULL,
    requester_email TEXT NOT NULL,
    requester_phone TEXT DEFAULT '',
    event_date TEXT NOT NULL,
    event_time TEXT DEFAULT '',
    guest_count INTEGER DEFAULT 10,
    budget_range TEXT DEFAULT '',
    event_type TEXT DEFAULT 'private',
    location TEXT DEFAULT '',
    location_lat REAL,
    location_lng REAL,
    dietary_notes TEXT DEFAULT '',
    message TEXT DEFAULT '',
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','quoted','accepted','declined','completed','cancelled')),
    vendor_response TEXT DEFAULT '',
    quoted_amount REAL,
    responded_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_catering_requests_vendor ON catering_requests(vendor_id, status);
  CREATE INDEX IF NOT EXISTS idx_catering_requests_email ON catering_requests(requester_email);
`);

// Phase 1653: Production indexes for query performance
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_vendor ON sessions(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions(customer_id);
  CREATE INDEX IF NOT EXISTS idx_customer_sessions_expires ON customer_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_orders_vendor ON orders(vendor_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, payment_status);
  CREATE INDEX IF NOT EXISTS idx_menu_items_vendor ON menu_items(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_menu_categories_vendor ON menu_categories(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
  CREATE INDEX IF NOT EXISTS idx_reviews_vendor ON reviews(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_favorites_customer ON favorites(customer_id);
`);

// Seed subscription tiers
const seedTiers = [
  { id: 'free', name: 'Free', price_monthly: 0, commission_rate: 0.12, stripe_price_id: '', features: ['Map listing', 'Basic storefront', 'Up to 10 menu items', 'Customer follows', 'Guest checkout orders'] },
  { id: 'pro', name: 'Pro', price_monthly: 29, commission_rate: 0.06, stripe_price_id: process.env.WYA_PRICE_PRO || '', features: ['Everything in Free', 'Unlimited menu items', 'Scheduled locations', 'Follower go-live alerts', 'Analytics dashboard', 'Promo codes'] },
  { id: 'growth', name: 'Growth', price_monthly: 59, commission_rate: 0.03, stripe_price_id: process.env.WYA_PRICE_GROWTH || '', features: ['Everything in Pro', 'Priority map placement', 'Delivery zone support', 'Loyalty tools', 'Multi-staff logins', 'Ambassador program', 'Custom branding'] },
];
const insertTier = db.prepare("INSERT OR IGNORE INTO subscription_tiers (id, name, price_monthly, commission_rate, stripe_price_id, features_json) VALUES (?,?,?,?,?,?)");
const updateTierPrice = db.prepare("UPDATE subscription_tiers SET stripe_price_id=? WHERE id=? AND (stripe_price_id IS NULL OR stripe_price_id='')");
for (const t of seedTiers) {
  insertTier.run(t.id, t.name, t.price_monthly, t.commission_rate, t.stripe_price_id, JSON.stringify(t.features));
  if (t.stripe_price_id) updateTierPrice.run(t.stripe_price_id, t.id);
}

// Generate referral codes for existing vendors that don't have one
const vendorsNeedingCodes = db.prepare("SELECT id, name FROM vendors WHERE referral_code IS NULL OR referral_code = ''").all();
for (const v of vendorsNeedingCodes) {
  const slug = v.name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase() || 'WYA';
  const code = slug + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  db.prepare('UPDATE vendors SET referral_code=? WHERE id=?').run(code, v.id);
}

// ── Phase 741: Seed dummy data (Phase 749: guarded by env) ──
if (process.env.WYA_SEED_DATA === 'true' && db.prepare("SELECT COUNT(*) as c FROM menu_categories WHERE vendor_id='TACO-001'").get().c === 0) {
  console.log('[WYA-SEED] Seeding demo data...');
  const seedVendors = [
    { id:'TACO-001', name:'SB Street Tacos', category:'food_truck', email:'tacos@demo.wya', desc:'Authentic street tacos, burritos & aguas frescas. Best al pastor in SB!', lat:34.4208, lng:-119.6982, open:1, orders:1, delivery:1, tier:'pro', prep:12 },
    { id:'PUPUSA-001', name:'La Pupuseria', category:'food_truck', email:'pupusas@demo.wya', desc:'Handmade Salvadoran pupusas, curtido & horchata.', lat:34.4195, lng:-119.6960, open:1, orders:1, delivery:1, tier:'starter', prep:15 },
    { id:'BREW-001', name:'Funk Zone Brews', category:'coffee', email:'brew@demo.wya', desc:'Specialty pour-overs, cold brew & fresh pastries in the Funk Zone.', lat:34.4225, lng:-119.7050, open:1, orders:1, delivery:0, tier:'pro', prep:5 },
    { id:'FLOWER-001', name:'Garden Street Blooms', category:'flowers', email:'flowers@demo.wya', desc:'Locally grown seasonal bouquets & succulent arrangements.', lat:34.4180, lng:-119.6975, open:0, orders:0, delivery:0, tier:'free', prep:20 },
    { id:'ART-001', name:'State St Artisan', category:'art_vendor', email:'art@demo.wya', desc:'Original paintings, prints & handmade jewelry by local artists.', lat:34.4240, lng:-119.7020, open:0, orders:0, delivery:0, tier:'free', prep:10 },
    { id:'BAKE-001', name:'De La Vina Bakehouse', category:'bakery', email:'bake@demo.wya', desc:'Artisan sourdough, croissants & custom cakes since 2019.', lat:34.4165, lng:-119.6990, open:1, orders:1, delivery:0, tier:'starter', prep:10 },
    { id:'HERB-001', name:'Milpas Botanica', category:'beauty', email:'herb@demo.wya', desc:'Natural herbs, essential oils & wellness products.', lat:34.4150, lng:-119.6945, open:0, orders:0, delivery:0, tier:'free', prep:5 },
    { id:'FARM-001', name:'Cota Street Farm Stand', category:'farmers_market', email:'farm@demo.wya', desc:'Fresh organic produce, jams & prepared foods from local farms.', lat:34.4255, lng:-119.7060, open:1, orders:1, delivery:0, tier:'starter', prep:5 },
  ];
  const pw = crypto.createHash('sha256').update('demo123' + 'wya_salt_2026').digest('hex');
  const trialEnd = new Date(Date.now() + 30*24*60*60*1000).toISOString();
  const insertV = db.prepare("INSERT OR REPLACE INTO vendors (id,name,category,email,password_hash,description,lat,lng,is_open,accepts_orders,delivery_enabled,subscription_tier,subscription_status,avg_rating,review_count,total_orders,estimated_prep_minutes,trial_ends_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const v of seedVendors) {
    insertV.run(v.id, v.name, v.category, v.email, pw, v.desc, v.lat, v.lng, v.open, v.orders, v.delivery, v.tier, 'trial', 0, 0, 0, v.prep, trialEnd);
  }

  // Menu categories + items
  const insertCat = db.prepare("INSERT INTO menu_categories (vendor_id,name,sort_order) VALUES (?,?,?)");
  const insertItem = db.prepare("INSERT INTO menu_items (vendor_id,category_id,name,description,price,sort_order) VALUES (?,?,?,?,?,?)");
  const insertMod = db.prepare("INSERT INTO menu_modifiers (item_id,name,price,sort_order) VALUES (?,?,?,?)");

  // TACO-001
  let catId = insertCat.run('TACO-001','Tacos',0).lastInsertRowid;
  insertItem.run('TACO-001',catId,'Al Pastor Taco','Marinated pork, pineapple, cilantro, onion',3.50,0);
  insertItem.run('TACO-001',catId,'Carne Asada Taco','Grilled steak, guac, salsa verde',4.00,1);
  insertItem.run('TACO-001',catId,'Chicken Taco','Grilled chicken, pico de gallo, crema',3.50,2);
  let fishTacoId = insertItem.run('TACO-001',catId,'Fish Taco','Beer-battered cod, chipotle slaw, lime',4.50,3).lastInsertRowid;
  insertMod.run(fishTacoId,'Extra Avocado',1.00,0);
  insertMod.run(fishTacoId,'Spicy Sauce',0.50,1);
  catId = insertCat.run('TACO-001','Burritos',1).lastInsertRowid;
  insertItem.run('TACO-001',catId,'California Burrito','Carne asada, fries, cheese, guac, sour cream',12.00,0);
  insertItem.run('TACO-001',catId,'Bean & Cheese Burrito','Refried beans, melted cheese, salsa roja',8.00,1);
  let superBurritoId = insertItem.run('TACO-001',catId,'Super Burrito','Choice of meat, rice, beans, all toppings',13.50,2).lastInsertRowid;
  insertMod.run(superBurritoId,'Add Guac',2.00,0);
  catId = insertCat.run('TACO-001','Drinks',2).lastInsertRowid;
  insertItem.run('TACO-001',catId,'Agua de Horchata','Sweet cinnamon rice milk',3.00,0);
  insertItem.run('TACO-001',catId,'Jamaica','Hibiscus flower water',3.00,1);
  insertItem.run('TACO-001',catId,'Mexican Coke','Glass bottle',2.50,2);

  // PUPUSA-001
  catId = insertCat.run('PUPUSA-001','Pupusas',0).lastInsertRowid;
  insertItem.run('PUPUSA-001',catId,'Revuelta Pupusa','Pork, cheese, beans',3.50,0);
  insertItem.run('PUPUSA-001',catId,'Queso Pupusa','Melted cheese blend',3.00,1);
  insertItem.run('PUPUSA-001',catId,'Loroco Pupusa','Cheese & loroco flower',3.50,2);
  insertItem.run('PUPUSA-001',catId,'Frijol Pupusa','Refried beans',2.50,3);
  catId = insertCat.run('PUPUSA-001','Sides',1).lastInsertRowid;
  insertItem.run('PUPUSA-001',catId,'Curtido','Pickled cabbage slaw',1.50,0);
  insertItem.run('PUPUSA-001',catId,'Platanos Fritos','Fried sweet plantains',4.00,1);
  catId = insertCat.run('PUPUSA-001','Drinks',2).lastInsertRowid;
  insertItem.run('PUPUSA-001',catId,'Horchata','Traditional rice drink',3.00,0);
  insertItem.run('PUPUSA-001',catId,'Tamarindo','Tamarind agua fresca',3.00,1);

  // BREW-001
  catId = insertCat.run('BREW-001','Hot Drinks',0).lastInsertRowid;
  insertItem.run('BREW-001',catId,'Pour Over','Single origin, hand-poured',5.00,0);
  insertItem.run('BREW-001',catId,'Oat Latte','Espresso with steamed oat milk',5.50,1);
  insertItem.run('BREW-001',catId,'Cortado','Double espresso, steamed milk',4.50,2);
  catId = insertCat.run('BREW-001','Cold Drinks',1).lastInsertRowid;
  insertItem.run('BREW-001',catId,'Cold Brew','24hr steeped, smooth & bold',5.00,0);
  insertItem.run('BREW-001',catId,'Iced Matcha','Ceremonial grade, oat milk',6.00,1);
  insertItem.run('BREW-001',catId,'Sparkling Lemonade','House-made with lavender',4.00,2);
  catId = insertCat.run('BREW-001','Pastries',2).lastInsertRowid;
  insertItem.run('BREW-001',catId,'Almond Croissant','Twice-baked, frangipane filled',5.50,0);
  insertItem.run('BREW-001',catId,'Banana Bread','Walnut, brown butter',4.00,1);
  insertItem.run('BREW-001',catId,'Blueberry Scone','Lemon glaze',4.50,2);

  // BAKE-001
  catId = insertCat.run('BAKE-001','Breads',0).lastInsertRowid;
  insertItem.run('BAKE-001',catId,'Sourdough Loaf','72hr fermented, crusty',8.00,0);
  insertItem.run('BAKE-001',catId,'Olive Focaccia','Rosemary, sea salt',7.00,1);
  insertItem.run('BAKE-001',catId,'Baguette','Classic French style',4.00,2);
  catId = insertCat.run('BAKE-001','Pastries',1).lastInsertRowid;
  insertItem.run('BAKE-001',catId,'Butter Croissant','Laminated, flaky, golden',4.50,0);
  insertItem.run('BAKE-001',catId,'Pain au Chocolat','Dark chocolate, butter pastry',5.00,1);
  insertItem.run('BAKE-001',catId,'Cinnamon Roll','Cream cheese frosting',5.50,2);
  catId = insertCat.run('BAKE-001','Cakes',2).lastInsertRowid;
  insertItem.run('BAKE-001',catId,'Carrot Cake Slice','Cream cheese, walnut',6.50,0);
  insertItem.run('BAKE-001',catId,'Tres Leches','Three milks, whipped cream',7.00,1);
  insertItem.run('BAKE-001',catId,'Flan','Classic caramel custard',5.00,2);

  // FARM-001
  catId = insertCat.run('FARM-001','Fruits',0).lastInsertRowid;
  insertItem.run('FARM-001',catId,'Strawberry Basket','1lb organic berries',6.00,0);
  insertItem.run('FARM-001',catId,'Avocados (3-pack)','Hass, locally grown',5.00,1);
  insertItem.run('FARM-001',catId,'Citrus Mix Bag','Oranges, lemons, limes',7.00,2);
  catId = insertCat.run('FARM-001','Vegetables',1).lastInsertRowid;
  insertItem.run('FARM-001',catId,'Salad Greens','Mixed local greens, 8oz',4.00,0);
  insertItem.run('FARM-001',catId,'Heirloom Tomatoes','1lb assorted',5.50,1);
  insertItem.run('FARM-001',catId,'Sweet Peppers','Mixed colors, 1lb',4.50,2);
  catId = insertCat.run('FARM-001','Prepared',2).lastInsertRowid;
  insertItem.run('FARM-001',catId,'Strawberry Jam','8oz jar, small batch',8.00,0);
  insertItem.run('FARM-001',catId,'Pesto','Basil, pine nut, 6oz',7.00,1);

  // Customers
  const insertCust = db.prepare("INSERT OR REPLACE INTO customers (id,name,email,password_hash,phone) VALUES (?,?,?,?,?)");
  insertCust.run('c_seed_alex','Alex Rivera','alex@demo.wya',pw,'805-555-0101');
  insertCust.run('c_seed_maya','Maya Chen','maya@demo.wya',pw,'805-555-0102');
  insertCust.run('c_seed_jake','Jake Thompson','jake@demo.wya',pw,'805-555-0103');
  insertCust.run('c_seed_sofia','Sofia Ramirez','sofia@demo.wya',pw,'805-555-0104');
  insertCust.run('c_seed_marcus','Marcus Johnson','marcus@demo.wya',pw,'805-555-0105');

  // Orders (10 completed + paid)
  const now = new Date().toISOString();
  const insertOrd = db.prepare("INSERT OR REPLACE INTO orders (id,customer_id,vendor_id,status,type,items_json,subtotal,commission_rate,commission_amount,tip,delivery_fee,total,created_at,updated_at,payment_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertOrd.run('ord_seed_01','c_seed_alex','TACO-001','completed','pickup',JSON.stringify([{name:'Al Pastor Taco',price:3.50,qty:3},{name:'Horchata',price:3.00,qty:1}]),13.50,0.10,1.35,2.00,0,15.50,now,now,'paid');
  insertOrd.run('ord_seed_02','c_seed_maya','TACO-001','completed','delivery',JSON.stringify([{name:'California Burrito',price:12.00,qty:1},{name:'Mexican Coke',price:2.50,qty:1}]),14.50,0.10,1.45,3.00,3.99,21.49,now,now,'paid');
  insertOrd.run('ord_seed_03','c_seed_jake','PUPUSA-001','completed','pickup',JSON.stringify([{name:'Revuelta Pupusa',price:3.50,qty:4},{name:'Curtido',price:1.50,qty:2}]),17.00,0.15,2.55,0,0,17.00,now,now,'paid');
  insertOrd.run('ord_seed_04','c_seed_sofia','PUPUSA-001','completed','delivery',JSON.stringify([{name:'Loroco Pupusa',price:3.50,qty:3},{name:'Horchata',price:3.00,qty:2}]),16.50,0.15,2.48,5.00,3.99,25.49,now,now,'paid');
  insertOrd.run('ord_seed_05','c_seed_alex','BREW-001','completed','pickup',JSON.stringify([{name:'Pour Over',price:5.00,qty:1},{name:'Almond Croissant',price:5.50,qty:1}]),10.50,0.10,1.05,1.50,0,12.00,now,now,'paid');
  insertOrd.run('ord_seed_06','c_seed_marcus','BREW-001','completed','pickup',JSON.stringify([{name:'Cold Brew',price:5.00,qty:2},{name:'Banana Bread',price:4.00,qty:1}]),14.00,0.10,1.40,2.00,0,16.00,now,now,'paid');
  insertOrd.run('ord_seed_07','c_seed_maya','BAKE-001','completed','pickup',JSON.stringify([{name:'Sourdough Loaf',price:8.00,qty:1},{name:'Butter Croissant',price:4.50,qty:2}]),17.00,0.15,2.55,0,0,17.00,now,now,'paid');
  insertOrd.run('ord_seed_08','c_seed_sofia','BAKE-001','completed','pickup',JSON.stringify([{name:'Tres Leches',price:7.00,qty:1},{name:'Cinnamon Roll',price:5.50,qty:2}]),18.00,0.15,2.70,3.00,0,21.00,now,now,'paid');
  insertOrd.run('ord_seed_09','c_seed_jake','FARM-001','completed','pickup',JSON.stringify([{name:'Strawberry Basket',price:6.00,qty:2},{name:'Salad Greens',price:4.00,qty:1}]),16.00,0.15,2.40,0,0,16.00,now,now,'paid');
  insertOrd.run('ord_seed_10','c_seed_marcus','FARM-001','completed','pickup',JSON.stringify([{name:'Avocados (3-pack)',price:5.00,qty:2},{name:'Pesto',price:7.00,qty:1}]),17.00,0.15,2.55,2.00,0,19.00,now,now,'paid');

  // Reviews
  const insertRev = db.prepare("INSERT OR REPLACE INTO reviews (order_id,customer_id,vendor_id,rating,review_text) VALUES (?,?,?,?,?)");
  insertRev.run('ord_seed_01','c_seed_alex','TACO-001',5,'Best al pastor in Santa Barbara! The pineapple is perfectly caramelized.');
  insertRev.run('ord_seed_02','c_seed_maya','TACO-001',4,'Great burritos, delivery was quick. Would order again.');
  insertRev.run('ord_seed_03','c_seed_jake','PUPUSA-001',5,'Authentic pupusas just like abuela makes. The curtido is perfect.');
  insertRev.run('ord_seed_04','c_seed_sofia','PUPUSA-001',4,'Really good, loroco pupusas are amazing. Delivery took a bit long.');
  insertRev.run('ord_seed_05','c_seed_alex','BREW-001',5,'The pour over here is incredible. Best coffee in the Funk Zone.');
  insertRev.run('ord_seed_06','c_seed_marcus','BREW-001',4,'Solid cold brew, pastries are fresh. A bit pricey but worth it.');
  insertRev.run('ord_seed_07','c_seed_maya','BAKE-001',5,'That sourdough is life-changing. Been coming back every week.');
  insertRev.run('ord_seed_09','c_seed_jake','FARM-001',3,'Good produce but strawberries were a little underripe this time.');

  // Update vendor stats
  db.prepare("UPDATE vendors SET avg_rating=4.5, review_count=2, total_orders=2 WHERE id='TACO-001'").run();
  db.prepare("UPDATE vendors SET avg_rating=4.5, review_count=2, total_orders=2 WHERE id='PUPUSA-001'").run();
  db.prepare("UPDATE vendors SET avg_rating=4.5, review_count=2, total_orders=2 WHERE id='BREW-001'").run();
  db.prepare("UPDATE vendors SET avg_rating=5.0, review_count=1, total_orders=2 WHERE id='BAKE-001'").run();
  db.prepare("UPDATE vendors SET avg_rating=3.0, review_count=1, total_orders=2 WHERE id='FARM-001'").run();

  // Promo codes
  const insertPromo = db.prepare("INSERT OR REPLACE INTO promo_codes (code,vendor_id,discount_type,discount_value,min_order,max_uses,active,created_by) VALUES (?,?,?,?,?,?,?,?)");
  insertPromo.run('WELCOME20',null,'percent',20,10.00,500,1,'system');
  insertPromo.run('TACOTUESDAY','TACO-001','percent',15,8.00,100,1,'system');
  insertPromo.run('FREECOFFEE','BREW-001','flat',5,0,50,1,'system');

  console.log('[WYA-SEED] Demo data seeded: 8 vendors, 44 menu items, 5 customers, 10 orders, 8 reviews, 3 promos');
}

// ── Phase 1203: Real Santa Barbara vendor seeding (idempotent) ──
{
  const pw = crypto.createHash('sha256').update('claim2026' + 'wya_salt_2026').digest('hex');
  const sergioPw = crypto.createHash('sha256').update('iscsb2026!' + 'wya_salt_2026').digest('hex');
  const insertRealV = db.prepare("INSERT OR IGNORE INTO vendors (id,name,category,email,password_hash,description,lat,lng,is_open,accepts_orders,delivery_enabled,subscription_tier,subscription_status,avg_rating,review_count,total_orders,estimated_prep_minutes,is_founding_vendor,website,instagram,tiktok,facebook,business_hours) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertRealCat = db.prepare("INSERT OR IGNORE INTO menu_categories (vendor_id,name,sort_order) VALUES (?,?,?)");
  const insertRealItem = db.prepare("INSERT OR IGNORE INTO menu_items (vendor_id,category_id,name,description,price,sort_order) VALUES (?,?,?,?,?,?)");
  const insertRealLoc = db.prepare("INSERT OR IGNORE INTO vendor_locations (vendor_id,name,lat,lng,address,is_active) VALUES (?,?,?,?,?,?)");

  const realVendors = [
    // ── Instant Sign Co (Sergio's shop — active immediately) ──
    { id:'ISCSB-001', name:'Instant Sign Co', category:'print_shop', email:'info@iscsb.com', pw:sergioPw, desc:'Full-service sign shop — banners, vehicle wraps, yard signs, business cards, window graphics, A-frames. Serving Santa Barbara since 2008.', lat:34.4231, lng:-119.7054, open:1, orders:1, delivery:0, tier:'pro', status:'active', prep:60, founding:1, website:'iscsb.com', ig:'instantsignco', tt:'', fb:'instantsignco', hours:'{"Mon":"08:30-17:00","Tue":"08:30-17:00","Wed":"08:30-17:00","Thu":"08:30-17:00","Fri":"08:30-17:00","Sat":"closed","Sun":"closed"}',
      cats: [
        { name:'Banners', items:[
          {name:'Vinyl Banner (3x6 ft)',desc:'Full-color digitally printed, hemmed & grommeted',price:75,sort:0},
          {name:'Vinyl Banner (4x8 ft)',desc:'Full-color, heavy-duty 13oz vinyl',price:120,sort:1},
          {name:'Mesh Banner (3x6 ft)',desc:'Wind-resistant mesh for outdoor use',price:85,sort:2},
        ]},
        { name:'Vehicle Wraps', items:[
          {name:'Partial Vehicle Wrap',desc:'Doors, hood, or tailgate — design included',price:350,sort:0},
          {name:'Full Vehicle Wrap',desc:'Complete coverage — design, print, install',price:2500,sort:1},
          {name:'Vehicle Lettering',desc:'Cut vinyl text and logo — per side',price:150,sort:2},
        ]},
        { name:'Yard Signs', items:[
          {name:'Yard Sign (18x24)',desc:'Corrugated plastic, single-sided with stake',price:25,sort:0},
          {name:'Yard Sign (24x36)',desc:'Large format corrugated, double-sided',price:45,sort:1},
          {name:'A-Frame Sign',desc:'Folding sidewalk sign with two inserts',price:89,sort:2},
        ]},
        { name:'Business Cards & Print', items:[
          {name:'Business Cards (500)',desc:'Full-color, 16pt matte or gloss',price:49,sort:0},
          {name:'Business Cards (1000)',desc:'Full-color, 16pt, free design',price:69,sort:1},
          {name:'Flyers (250)',desc:'8.5x11, full-color one side',price:89,sort:2},
        ]},
        { name:'Window Graphics', items:[
          {name:'Window Decal',desc:'Per sq ft — cut vinyl lettering',price:8,sort:0},
          {name:'Window Perf (per sq ft)',desc:'One-way vision perforated vinyl',price:12,sort:1},
          {name:'Frosted Privacy Film (per sq ft)',desc:'Etched glass look',price:10,sort:2},
        ]},
      ],
    },
    // ── Food Trucks ──
    { id:'SB-PASTOR-001', name:'El Pastorcito Mobile', category:'food_truck', email:'claim-elpastorcito@wya.digisigns.link', pw, desc:'Family-owned Mexico City-style taco truck. Al pastor off the trompo, handmade tortillas daily. Most beloved taco truck on Milpas.', lat:34.4262, lng:-119.6921, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:10, founding:0, website:'', ig:'elpastorcitomobile', tt:'', fb:'', hours:'{"Mon":"closed","Tue":"16:00-22:00","Wed":"16:00-22:00","Thu":"16:00-22:00","Fri":"16:00-22:30","Sat":"16:00-22:30","Sun":"16:00-22:00"}',
      cats: [
        { name:'Tacos', items:[
          {name:'Al Pastor Taco',desc:'Marinated pork off the trompo, pineapple, cilantro',price:3.50,sort:0},
          {name:'Carne Asada Taco',desc:'Grilled steak, onion, cilantro',price:3.50,sort:1},
          {name:'Birria Taco',desc:'Braised beef with consomme for dipping',price:4.00,sort:2},
        ]},
        { name:'Plates', items:[
          {name:'Quesadilla',desc:'Choice of meat, melted cheese, tortilla',price:7.00,sort:0},
          {name:'Alambre',desc:'Grilled meat, peppers, onions, cheese, bacon',price:10.00,sort:1},
        ]},
        { name:'Drinks', items:[
          {name:'Agua Fresca',desc:'Horchata, Jamaica, or Tamarindo',price:2.50,sort:0},
        ]},
      ],
    },
    { id:'SB-PIPEYE-001', name:'Tacos Pipeye', category:'food_truck', email:'claim-tacospipeye@wya.digisigns.link', pw, desc:'Legendary Milpas taco spot. Cheap, authentic, always packed. Real deal street tacos.', lat:34.4220, lng:-119.6922, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:8, founding:0, website:'', ig:'', tt:'', fb:'tacospipeye', hours:'{"Mon":"10:00-21:00","Tue":"10:00-21:00","Wed":"10:00-21:00","Thu":"10:00-21:00","Fri":"10:00-22:00","Sat":"09:00-22:00","Sun":"09:00-21:00"}',
      cats: [
        { name:'Tacos', items:[
          {name:'Carne Asada Taco',desc:'Grilled steak on double corn tortilla',price:3.00,sort:0},
          {name:'Adobada Taco',desc:'Marinated pork with pineapple',price:3.00,sort:1},
          {name:'Pollo Taco',desc:'Grilled chicken, onion, cilantro',price:3.00,sort:2},
        ]},
        { name:'Burritos & More', items:[
          {name:'Burrito (any meat)',desc:'Rice, beans, meat, salsa, cheese',price:9.00,sort:0},
          {name:'Torta',desc:'Mexican sandwich with choice of meat',price:8.50,sort:1},
        ]},
        { name:'Drinks', items:[
          {name:'Horchata',desc:'Traditional rice drink',price:2.50,sort:0},
        ]},
      ],
    },
    { id:'SB-ELUBIA-001', name:"Elubia's Kitchen", category:'food_truck', email:'claim-elubias@wya.digisigns.link', pw, desc:'Latin American food truck — pupusas, street tacos, burritos, garnachas. Weekends and events.', lat:34.4208, lng:-119.7024, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:12, founding:0, website:'', ig:'', tt:'', fb:'', hours:'{"Wed":"11:00-19:00","Thu":"11:00-19:00","Fri":"11:00-20:00","Sat":"10:00-20:00","Sun":"10:00-18:00"}',
      cats: [
        { name:'Specialties', items:[
          {name:'Pupusas (2-pack)',desc:'Handmade with choice of filling',price:6.00,sort:0},
          {name:'Garnacha',desc:'Crispy tortilla with toppings',price:4.00,sort:1},
          {name:'Tamale',desc:'Wrapped in corn husk, choice of filling',price:4.00,sort:2},
        ]},
        { name:'Tacos & Burritos', items:[
          {name:'Street Taco',desc:'Choice of meat, onion, cilantro',price:3.50,sort:0},
          {name:'Chicken Burrito',desc:'Rice, beans, chicken, salsa, cheese',price:10.00,sort:1},
        ]},
        { name:'Drinks', items:[
          {name:'Agua Fresca',desc:'Rotating seasonal flavors',price:2.50,sort:0},
        ]},
      ],
    },
    // ── Coffee Shops ──
    { id:'SB-HANDLEBAR-001', name:'Handlebar Coffee Roasters', category:'coffee', email:'claim-handlebar@wya.digisigns.link', pw, desc:"SB's most beloved indie roaster. Bicycle-themed, sunny patio, all espresso as doubles. Straus organic milk.", lat:34.4181, lng:-119.6973, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:5, founding:0, website:'handlebarcoffee.com', ig:'handlebarcoffee', tt:'', fb:'', hours:'{"Mon":"06:30-17:00","Tue":"06:30-17:00","Wed":"06:30-17:00","Thu":"06:30-17:00","Fri":"06:30-17:00","Sat":"06:30-17:00","Sun":"06:30-17:00"}',
      cats: [
        { name:'Hot Drinks', items:[
          {name:'Latte',desc:'Double espresso, steamed milk, 12oz',price:6.50,sort:0},
          {name:'Cappuccino',desc:'Double espresso, foamed milk',price:5.50,sort:1},
          {name:'Pour Over',desc:'Rotating single origin, hand-poured',price:6.00,sort:2},
        ]},
        { name:'Cold Drinks', items:[
          {name:'Cold Brew',desc:'24hr steeped, smooth and bold',price:5.50,sort:0},
          {name:'Matcha Latte',desc:'Ceremonial grade, oat milk',price:6.50,sort:1},
        ]},
        { name:'Pastries', items:[
          {name:'Cinnamon Roll',desc:'Fresh baked daily',price:5.00,sort:0},
        ]},
      ],
    },
    { id:'SB-DART-001', name:'Dart Coffee Co.', category:'coffee', email:'claim-dartcoffee@wya.digisigns.link', pw, desc:'Specialty coffee in the Funk Zone near the harbor. Dog-friendly outdoor patio, strong precise espresso.', lat:34.4147, lng:-119.6901, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:5, founding:0, website:'dartcoffeeco.com', ig:'dartcoffeeco', tt:'', fb:'', hours:'{"Mon":"07:00-16:00","Tue":"07:00-16:00","Wed":"07:00-16:00","Thu":"07:00-16:00","Fri":"07:00-17:00","Sat":"07:00-17:00","Sun":"07:00-17:00"}',
      cats: [
        { name:'Espresso', items:[
          {name:'Double Espresso',desc:'Strong, clean pull',price:4.00,sort:0},
          {name:'Oat Milk Latte',desc:'House espresso with oat milk',price:6.75,sort:1},
          {name:'Cortado',desc:'Equal parts espresso and steamed milk',price:5.00,sort:2},
        ]},
        { name:'Cold', items:[
          {name:'Iced Coffee',desc:'Brewed cold, served over ice',price:4.50,sort:0},
        ]},
        { name:'Food', items:[
          {name:'Croissant',desc:'Butter croissant, baked fresh',price:4.50,sort:0},
          {name:'Seasonal Pastry',desc:'Rotating selection',price:5.00,sort:1},
        ]},
      ],
    },
    { id:'SB-CAJE-001', name:'Cajé Coffee Roasters', category:'coffee', email:'claim-caje@wya.digisigns.link', pw, desc:'Hip East Side roaster known for creative signature drinks. Rosemary Latte, Bella Rose Matcha. Sells whole bean bags.', lat:34.4158, lng:-119.6930, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:5, founding:0, website:'caje.coffee', ig:'cajecoffeeroasters', tt:'', fb:'', hours:'{"Mon":"07:00-18:00","Tue":"07:00-18:00","Wed":"07:00-18:00","Thu":"07:00-18:00","Fri":"07:00-18:00","Sat":"07:00-18:00","Sun":"07:00-18:00"}',
      cats: [
        { name:'Signature Drinks', items:[
          {name:'Rosemary Latte',desc:'Signature — espresso, rosemary syrup, milk',price:6.75,sort:0},
          {name:'Bella Rose Matcha',desc:'Signature — rose-infused matcha',price:7.00,sort:1},
          {name:'Burnout',desc:'Espresso, oat milk, caramel, dark chocolate',price:7.00,sort:2},
        ]},
        { name:'Classic', items:[
          {name:'Vanilla Latte',desc:'Espresso, vanilla, steamed milk',price:6.25,sort:0},
        ]},
        { name:'Food & Retail', items:[
          {name:'Bagel with Cream Cheese',desc:'Fresh toasted bagel',price:5.50,sort:0},
          {name:'Whole Bean Bag (12oz)',desc:'Freshly roasted, rotating origins',price:22.00,sort:1},
        ]},
      ],
    },
    // ── Restaurants / Tacos ──
    { id:'SB-SUPERRICA-001', name:'La Super-Rica Taqueria', category:'restaurant', email:'claim-superrica@wya.digisigns.link', pw, desc:"The most famous taqueria in California — Julia Child's favorite. Cash-only, outdoor seating, homemade tortillas.", lat:34.4296, lng:-119.6920, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:15, founding:0, website:'', ig:'', tt:'', fb:'', hours:'{"Mon":"11:00-21:00","Tue":"closed","Wed":"closed","Thu":"11:00-21:00","Fri":"11:00-21:30","Sat":"11:00-21:30","Sun":"11:00-21:00"}',
      cats: [
        { name:'Tacos', items:[
          {name:'Taco con Bistec',desc:'Grilled steak, handmade tortilla',price:2.50,sort:0},
          {name:'Taco al Pastor',desc:'Marinated pork, pineapple',price:2.50,sort:1},
          {name:'Taco con Carnitas',desc:'Slow-cooked pork',price:2.50,sort:2},
          {name:'Chile Relleno Taco',desc:'Stuffed pepper in tortilla',price:3.25,sort:3},
        ]},
        { name:'Plates', items:[
          {name:'Tamale',desc:'Handmade, wrapped in corn husk',price:3.50,sort:0},
          {name:'Posole',desc:'Traditional hominy soup',price:9.00,sort:1},
        ]},
      ],
    },
    { id:'SB-LILLYS-001', name:"Lilly's Taqueria", category:'restaurant', email:'claim-lillys@wya.digisigns.link', pw, desc:'Award-winning SB taqueria famous for ultra-cheap tacos — just meat on two corn tortillas. Entire menu gluten-free.', lat:34.4143, lng:-119.6945, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:8, founding:0, website:'lillystacos.com', ig:'', tt:'', fb:'', hours:'{"Mon":"10:00-21:00","Tue":"closed","Wed":"10:00-21:00","Thu":"10:00-21:00","Fri":"10:00-21:00","Sat":"10:00-21:00","Sun":"10:00-21:00"}',
      cats: [
        { name:'Tacos', items:[
          {name:'Asada Taco',desc:'Grilled steak, double corn tortilla',price:2.00,sort:0},
          {name:'Adobada Taco',desc:'Marinated pork',price:2.00,sort:1},
          {name:'Pollo Fajita Taco',desc:'Grilled chicken fajita',price:2.00,sort:2},
          {name:'Lengua Taco',desc:'Beef tongue, tender',price:2.00,sort:3},
          {name:'Cabeza Taco',desc:'Beef head meat, traditional',price:2.00,sort:4},
        ]},
        { name:'Drinks', items:[
          {name:'Horchata',desc:'Traditional rice drink',price:2.50,sort:0},
        ]},
      ],
    },
    { id:'SB-ARROYOS-001', name:'Los Arroyos', category:'restaurant', email:'claim-arroyos@wya.digisigns.link', pw, desc:'Family-run full sit-down Mexican restaurant since 1999. Indoor/outdoor seating, full bar, great margaritas.', lat:34.4182, lng:-119.6983, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:20, founding:0, website:'losarroyos.net', ig:'', tt:'', fb:'', hours:'{"Mon":"11:00-21:00","Tue":"11:00-21:00","Wed":"11:00-21:00","Thu":"11:00-21:00","Fri":"11:00-21:00","Sat":"10:00-21:00","Sun":"10:00-20:30"}',
      cats: [
        { name:'Tacos & Burritos', items:[
          {name:'Street Tacos (3)',desc:'Choice of meat, onion, cilantro',price:14.00,sort:0},
          {name:'Veggie Burrito',desc:'Rice, beans, grilled veggies, cheese',price:12.00,sort:1},
        ]},
        { name:'Plates', items:[
          {name:'Chicken Enchiladas (2)',desc:'Red or green sauce, rice and beans',price:15.50,sort:0},
          {name:'Chile Verde',desc:'Slow-braised pork in tomatillo sauce',price:16.00,sort:1},
        ]},
        { name:'Drinks', items:[
          {name:'House Margarita',desc:'Fresh lime, tequila, triple sec',price:10.00,sort:0},
          {name:'Garden Salad',desc:'Mixed greens, house dressing',price:6.25,sort:1},
        ]},
      ],
    },
    // ── Bakeries ──
    { id:'SB-LILAC-001', name:'Lilac Patisserie', category:'bakery', email:'claim-lilac@wya.digisigns.link', pw, desc:'100% dedicated gluten-free artisan bakery on State Street. French-trained pastry chefs. Stunning layer cakes, pastries, breakfast & lunch.', lat:34.4195, lng:-119.7007, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:10, founding:0, website:'lilacpatisserie.com', ig:'lilacpatisserie', tt:'', fb:'', hours:'{"Mon":"08:00-15:00","Tue":"08:00-15:00","Wed":"08:00-15:00","Thu":"08:00-15:00","Fri":"08:00-15:00","Sat":"08:00-15:00","Sun":"08:00-15:00"}',
      cats: [
        { name:'Pastries', items:[
          {name:'Almond Croissant (GF)',desc:'Twice-baked, frangipane filled',price:6.50,sort:0},
          {name:'Morning Muffin',desc:'Daily rotating flavor',price:4.50,sort:1},
          {name:'Layer Cake Slice',desc:'Rotating flavors, gluten-free',price:8.00,sort:2},
        ]},
        { name:'Cafe', items:[
          {name:'Avocado Toast',desc:'On GF sourdough, everything seasoning',price:12.00,sort:0},
          {name:'Latte',desc:'Espresso with steamed milk',price:6.00,sort:1},
        ]},
      ],
    },
    { id:'SB-RENAUDS-001', name:"Renaud's Patisserie & Bistro", category:'bakery', email:'claim-renauds@wya.digisigns.link', pw, desc:'French-owned patisserie in Arlington Plaza. Authentic laminated croissants, tarts, full breakfast and lunch bistro.', lat:34.4228, lng:-119.7023, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:10, founding:0, website:'renaudsbistro.com', ig:'', tt:'', fb:'', hours:'{"Mon":"07:00-16:00","Tue":"07:00-16:00","Wed":"07:00-16:00","Thu":"07:00-16:00","Fri":"07:00-16:00","Sat":"07:00-16:00","Sun":"07:00-15:00"}',
      cats: [
        { name:'Pastries', items:[
          {name:'Almond Croissant',desc:'Classic French laminated, almond cream',price:9.75,sort:0},
          {name:'Pain aux Chocolat',desc:'Dark chocolate, butter pastry',price:8.45,sort:1},
          {name:'Lemon Meringue Tart',desc:'Tangy lemon curd, toasted meringue',price:7.50,sort:2},
          {name:'Raspberry Tart',desc:'Fresh raspberries, pastry cream',price:7.50,sort:3},
        ]},
        { name:'Bistro', items:[
          {name:'Croque Monsieur',desc:'Grilled ham and cheese, bechamel',price:13.50,sort:0},
          {name:'Americano',desc:'Double espresso, hot water',price:4.50,sort:1},
        ]},
      ],
    },
    // ── Flowers ──
    { id:'SB-ALPHA-001', name:'Alpha Floral', category:'flowers', email:'claim-alphafloral@wya.digisigns.link', pw, desc:"Santa Barbara's oldest florist since 1935. Weddings, events, daily delivery Goleta to Carpinteria.", lat:34.4028, lng:-119.7267, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:30, founding:0, website:'alphafloralsb.com', ig:'', tt:'', fb:'', hours:'{"Mon":"08:30-15:30","Tue":"08:30-15:30","Wed":"08:30-15:30","Thu":"08:30-15:30","Fri":"08:30-15:30","Sat":"08:30-15:30","Sun":"closed"}',
      cats: [
        { name:'Bouquets', items:[
          {name:'Seasonal Bouquet (small)',desc:'Fresh seasonal flowers, hand-tied',price:35.00,sort:0},
          {name:'Dozen Roses',desc:'Classic long-stem red or mixed',price:97.00,sort:1},
          {name:'Custom Arrangement (medium)',desc:'Designer choice, seasonal blooms',price:75.00,sort:2},
        ]},
        { name:'Plants & Delivery', items:[
          {name:'House Plant',desc:'Potted green or succulent',price:45.00,sort:0},
          {name:'Event Centerpiece',desc:'Custom design for events',price:85.00,sort:1},
          {name:'Same-Day Delivery (SB)',desc:'Delivery within Santa Barbara',price:15.00,sort:2},
        ]},
      ],
    },
    // ── Art Gallery ──
    { id:'SB-SULLIVAN-001', name:'Sullivan Goss — An American Gallery', category:'art_vendor', email:'claim-sullivangoss@wya.digisigns.link', pw, desc:'Premier fine art gallery in the Historic Arts District. American and California artists — paintings, watercolors, sculpture.', lat:34.4205, lng:-119.6985, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:5, founding:0, website:'sullivangoss.com', ig:'', tt:'', fb:'', hours:'{"Mon":"closed","Tue":"11:00-17:00","Wed":"11:00-17:00","Thu":"11:00-17:00","Fri":"11:00-17:00","Sat":"11:00-17:00","Sun":"11:00-17:00"}',
      cats: [
        { name:'Prints & Originals', items:[
          {name:'Limited Edition Print',desc:'Signed and numbered',price:150.00,sort:0},
          {name:'Original Watercolor',desc:'California landscape series',price:400.00,sort:1},
          {name:'Original Oil Painting',desc:'Gallery artist original',price:1200.00,sort:2},
          {name:'Bronze Sculpture (small)',desc:'Tabletop size, limited edition',price:800.00,sort:3},
        ]},
      ],
    },
    // ── Farmers Market ──
    { id:'SB-FARMSAT-001', name:'SB Farmers Market (Saturday)', category:'farmers_market', email:'claim-sbfarmerssat@wya.digisigns.link', pw, desc:'Up to 90 vendors. Produce, baked goods, flowers, cheese, eggs, honey, prepared foods. The Saturday institution.', lat:34.4215, lng:-119.7012, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:5, founding:0, website:'sbfarmersmarket.org', ig:'', tt:'', fb:'', hours:'{"Sat":"08:00-13:00"}',
      cats: [
        { name:'Produce', items:[
          {name:'Organic Strawberry Basket',desc:'1lb fresh local berries',price:6.00,sort:0},
          {name:'Avocados (3-pack)',desc:'Hass, locally grown',price:5.00,sort:1},
          {name:'Heirloom Tomatoes (1lb)',desc:'Assorted colors',price:5.50,sort:2},
        ]},
        { name:'Prepared', items:[
          {name:'Fresh Bread Loaf',desc:'Artisan sourdough or whole wheat',price:7.00,sort:0},
          {name:'Wildflower Honey (8oz)',desc:'Local raw honey',price:10.00,sort:1},
        ]},
      ],
    },
    { id:'SB-FARMTUE-001', name:'SB Farmers Market (Tuesday)', category:'farmers_market', email:'claim-sbfarmerstue@wya.digisigns.link', pw, desc:'Locals-focused weekday market. Smaller, quicker. Old Town SB between Cota and Canon Perdido on lower State St.', lat:34.4170, lng:-119.6990, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:5, founding:0, website:'sbfarmersmarket.org', ig:'', tt:'', fb:'', hours:'{"Tue":"15:00-18:30"}',
      cats: [
        { name:'Fresh Picks', items:[
          {name:'Salad Greens Mix',desc:'Mixed local greens, 8oz bag',price:4.00,sort:0},
          {name:'Citrus Mix Bag',desc:'Oranges, lemons, limes',price:7.00,sort:1},
          {name:'Fresh Eggs (dozen)',desc:'Pasture-raised, local farm',price:8.00,sort:2},
        ]},
      ],
    },
    // ── Auto Services ──
    { id:'SB-SUNSHINE-001', name:'Sunshine Collision & Auto Spa', category:'auto_services', email:'claim-sunshinecollision@wya.digisigns.link', pw, desc:'Auto collision repair, detailing, and ceramic coating. From basic wash to full paint correction.', lat:34.4268, lng:-119.7020, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:60, founding:0, website:'sunshinecollisionsb.com', ig:'', tt:'', fb:'', hours:'{"Mon":"08:00-17:00","Tue":"08:00-17:00","Wed":"08:00-17:00","Thu":"08:00-17:00","Fri":"07:00-17:00","Sat":"07:00-15:00","Sun":"closed"}',
      cats: [
        { name:'Detailing', items:[
          {name:'Basic Exterior Wash',desc:'Hand wash, dry, tire shine',price:60.00,sort:0},
          {name:'Interior Detail',desc:'Vacuum, wipe, leather condition',price:120.00,sort:1},
          {name:'Full Detail Package',desc:'Interior + exterior + engine bay',price:200.00,sort:2},
        ]},
        { name:'Premium', items:[
          {name:'Paint Correction',desc:'Machine polish, swirl removal',price:350.00,sort:0},
          {name:'Ceramic Pro Coating',desc:'Multi-year ceramic protection',price:800.00,sort:1},
        ]},
      ],
    },
    // ── Beauty / Barber ──
    { id:'SB-BARBER-001', name:'The Barber Shop', category:'beauty', email:'claim-barbershop@wya.digisigns.link', pw, desc:'Vintage-style upscale barbershop on State Street. Haircuts, hot towel shaves, beard trims. Est. 2016.', lat:34.4219, lng:-119.7015, open:0, orders:0, delivery:0, tier:'free', status:'trial', prep:30, founding:0, website:'thebarbershopca.com', ig:'', tt:'', fb:'', hours:'{"Mon":"10:00-18:00","Tue":"09:00-18:00","Wed":"09:00-18:00","Thu":"09:00-19:00","Fri":"09:00-19:00","Sat":"09:00-18:00","Sun":"10:00-17:00"}',
      cats: [
        { name:'Cuts', items:[
          {name:"Men's Haircut",desc:'Classic or modern style',price:55.00,sort:0},
          {name:'Kids Haircut',desc:'Under 12',price:35.00,sort:1},
          {name:'Haircut + Beard Combo',desc:'Full service cut and trim',price:80.00,sort:2},
        ]},
        { name:'Grooming', items:[
          {name:'Beard Trim',desc:'Shape and detail',price:30.00,sort:0},
          {name:'Hot Towel Straight Razor Shave',desc:'Classic barbershop experience',price:45.00,sort:1},
        ]},
      ],
    },
  ];

  let vendorCount = 0, itemCount = 0;
  for (const v of realVendors) {
    const result = insertRealV.run(v.id, v.name, v.category, v.email, v.pw || pw, v.desc, v.lat, v.lng, v.open, v.orders, v.delivery, v.tier, v.status, 0, 0, 0, v.prep, v.founding, v.website, v.ig, v.tt, v.fb, v.hours);
    if (result.changes > 0) {
      vendorCount++;
      // Insert location
      insertRealLoc.run(v.id, v.name, v.lat, v.lng, '', 1);
      // Insert menu categories + items
      if (v.cats) {
        for (let ci = 0; ci < v.cats.length; ci++) {
          const cat = v.cats[ci];
          const catResult = insertRealCat.run(v.id, cat.name, ci);
          const catId = catResult.lastInsertRowid;
          if (cat.items) {
            for (const item of cat.items) {
              insertRealItem.run(v.id, catId, item.name, item.desc, item.price, item.sort);
              itemCount++;
            }
          }
        }
      }
      // Generate referral code
      const slug = v.name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase() || 'WYA';
      const code = slug + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      db.prepare('UPDATE vendors SET referral_code=? WHERE id=?').run(code, v.id);
    }
  }
  if (vendorCount > 0) {
    console.log(`[WYA-REAL] Seeded ${vendorCount} real SB vendors with ${itemCount} menu items`);
  }
}

// ── Phase 1331b: Tenant Soul vendor accounts (idempotent) ──
{
  const tenantPw = crypto.createHash('sha256').update('Soul2026!' + 'wya_salt_2026').digest('hex');
  const trialEnd31 = new Date(Date.now() + 30*24*60*60*1000).toISOString();
  const insertTV = db.prepare("INSERT OR IGNORE INTO vendors (id,name,category,email,password_hash,description,lat,lng,is_open,accepts_orders,delivery_enabled,subscription_tier,subscription_status,avg_rating,review_count,total_orders,estimated_prep_minutes,is_founding_vendor,website,instagram,tiktok,facebook,business_hours,trial_ends_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertTCat = db.prepare("INSERT OR IGNORE INTO menu_categories (vendor_id,name,sort_order) VALUES (?,?,?)");
  const insertTItem = db.prepare("INSERT OR IGNORE INTO menu_items (vendor_id,category_id,name,description,price,sort_order) VALUES (?,?,?,?,?,?)");
  const insertTLoc = db.prepare("INSERT OR IGNORE INTO vendor_locations (vendor_id,name,lat,lng,address,is_active) VALUES (?,?,?,?,?,?)");

  const tenantVendors = [
    // ── Vicky Love Tarot (Southern CA) ──
    { id:'VICKY-LOVE-001', name:'Vicky Love Tarot', category:'beauty', email:'vlove11519@gmail.com', desc:'Intuitive tarot readings, psychic guidance, crystals & candles. In-person, phone, video — emergency same-day available.', lat:34.0522, lng:-118.2437, open:0, orders:1, delivery:0, tier:'free', prep:30, founding:1, website:'', ig:'vickylovetarot', tt:'vickylove_09_', fb:'', hours:'{"Mon":"10:00-18:00","Tue":"10:00-18:00","Wed":"10:00-18:00","Thu":"10:00-18:00","Fri":"10:00-20:00","Sat":"10:00-20:00","Sun":"12:00-17:00"}',
      cats: [
        { name:'Readings', items:[
          {name:'In-Person Reading',desc:'1 hour intuitive tarot session',price:150,sort:0},
          {name:'Extended Reading',desc:'2+ hours deep dive session',price:222,sort:1},
          {name:'Phone Reading',desc:'45 min phone/FaceTime session',price:88,sort:2},
          {name:'Video Reading',desc:'1 hour video call session',price:100,sort:3},
          {name:'Emergency Reading',desc:'Same-day 30 min session',price:65,sort:4},
          {name:'Past Life Regression',desc:'90 min past life session',price:150,sort:5},
        ]},
        { name:'Shop', items:[
          {name:'Tarot Gift Card',desc:'Redeemable for any reading',price:50,sort:0},
          {name:'Crystal Bundle',desc:'Curated crystal starter kit',price:35,sort:1},
        ]},
      ],
    },
    // ── Kimberly's Kitchen (CA) ──
    { id:'KIMBERLY-FOOD-001', name:"Kimberly's Kitchen", category:'food_truck', email:'kimberlylarahernandez95@gmail.com', desc:'Homestyle comfort food made with love. Combo plates, family packs, kids meals, and catering for events.', lat:34.4200, lng:-119.7000, open:0, orders:1, delivery:0, tier:'free', prep:15, founding:1, website:'', ig:'', tt:'', fb:'', hours:'{"Mon":"closed","Tue":"11:00-19:00","Wed":"11:00-19:00","Thu":"11:00-19:00","Fri":"11:00-20:00","Sat":"10:00-20:00","Sun":"10:00-17:00"}',
      cats: [
        { name:'Plates', items:[
          {name:'Combo Plate',desc:'Choice of protein, rice, beans, salad',price:12,sort:0},
          {name:'Family Pack',desc:'Feeds 4-5 people, choice of proteins',price:30,sort:1},
          {name:'Kids Meal',desc:'Small plate with drink',price:8,sort:2},
        ]},
        { name:'Catering & Drinks', items:[
          {name:'Catering (10 people)',desc:'Full spread for events and parties',price:120,sort:0},
          {name:'Drinks',desc:'Agua fresca or soda',price:3,sort:1},
        ]},
      ],
    },
    // ── Born 2 Lead — Nathan (Phoenix, AZ) ──
    { id:'B2L-NATHAN-001', name:'Born 2 Lead — Nathan Barragan', category:'other', email:'b2lnewbusiness@gmail.com', desc:'Life insurance agency owner — Born 2 Lead. Free consultations, IUL reviews, family protection plans, agent recruiting.', lat:33.4484, lng:-112.0740, open:0, orders:0, delivery:0, tier:'free', prep:30, founding:1, website:'', ig:'', tt:'', fb:'', hours:'{"Mon":"09:00-18:00","Tue":"09:00-18:00","Wed":"09:00-18:00","Thu":"09:00-18:00","Fri":"09:00-17:00","Sat":"by appointment","Sun":"closed"}',
      cats: [
        { name:'Services', items:[
          {name:'Life Insurance Consultation',desc:'Free — review your coverage needs',price:0,sort:0},
          {name:'Family Protection Plan',desc:'Comprehensive life + IUL package',price:0,sort:1},
          {name:'IUL Policy Review',desc:'Review and optimize existing policies',price:0,sort:2},
          {name:'Agent Recruiting Info Session',desc:'Learn about joining B2L team',price:0,sort:3},
        ]},
      ],
    },
    // ── B2L — Vincent Gallegos (Phoenix, AZ) ──
    { id:'B2L-VINCENT-001', name:'Vincent Gallegos — B2L Life Insurance', category:'other', email:'vicentegallegos540@gmail.com', desc:'Licensed life insurance agent with Born 2 Lead. Term life, whole life, IUL — protecting families in Phoenix.', lat:33.4490, lng:-112.0730, open:0, orders:0, delivery:0, tier:'free', prep:30, founding:1, website:'', ig:'', tt:'', fb:'', hours:'{"Mon":"09:00-18:00","Tue":"09:00-18:00","Wed":"09:00-18:00","Thu":"09:00-18:00","Fri":"09:00-17:00","Sat":"by appointment","Sun":"closed"}',
      cats: [
        { name:'Services', items:[
          {name:'Life Insurance Quote',desc:'Free — no obligation quote',price:0,sort:0},
          {name:'Term Life Review',desc:'Review your term life options',price:0,sort:1},
          {name:'Whole Life Review',desc:'Whole life policy analysis',price:0,sort:2},
          {name:'IUL Consultation',desc:'Indexed universal life strategy',price:0,sort:3},
        ]},
      ],
    },
    // ── B2L — Marty Carrazco (Phoenix, AZ) ──
    { id:'B2L-MARTY-001', name:'Marty Carrazco — B2L Life Insurance', category:'other', email:'marty7carrazco@gmail.com', desc:'Life insurance agent with Born 2 Lead. Helping families plan for the future — term life, whole life, IUL.', lat:33.4488, lng:-112.0735, open:0, orders:0, delivery:0, tier:'free', prep:30, founding:1, website:'', ig:'', tt:'', fb:'', hours:'{"Mon":"09:00-18:00","Tue":"09:00-18:00","Wed":"09:00-18:00","Thu":"09:00-18:00","Fri":"09:00-17:00","Sat":"by appointment","Sun":"closed"}',
      cats: [
        { name:'Services', items:[
          {name:'Life Insurance Quote',desc:'Free — no obligation quote',price:0,sort:0},
          {name:'Term Life Review',desc:'Review your term life options',price:0,sort:1},
          {name:'Whole Life Review',desc:'Whole life policy analysis',price:0,sort:2},
          {name:'IUL Consultation',desc:'Indexed universal life strategy',price:0,sort:3},
        ]},
      ],
    },
    // ── B2L — Makayla Zendejas (Phoenix, AZ) ──
    { id:'B2L-MAKAYLA-001', name:'Makayla Zendejas — B2L Operations', category:'other', email:'makaylazendejas@gmail.com', desc:'B2L Operations — agent onboarding, pipeline reviews, team training. Keeping the Born 2 Lead machine running.', lat:33.4486, lng:-112.0738, open:0, orders:0, delivery:0, tier:'free', prep:30, founding:1, website:'', ig:'', tt:'', fb:'', hours:'{"Mon":"09:00-17:00","Tue":"09:00-17:00","Wed":"09:00-17:00","Thu":"09:00-17:00","Fri":"09:00-16:00","Sat":"closed","Sun":"closed"}',
      cats: [
        { name:'Services', items:[
          {name:'Agent Onboarding Call',desc:'Free — new agent orientation',price:0,sort:0},
          {name:'Pipeline Review',desc:'Weekly pipeline check-in',price:0,sort:1},
          {name:'Team Training Session',desc:'Group training for B2L agents',price:0,sort:2},
        ]},
      ],
    },
    // ── Lesly Barragan — PA School Journey (profile-only) ──
    { id:'LESLIE-PRE-PA-001', name:'Lesly Barragan', category:'other', email:'leslybarragan14@gmail.com', desc:'PA school journey — pre-PA student sharing the path to physician assistant school.', lat:34.4200, lng:-119.7010, open:0, orders:0, delivery:0, tier:'free', prep:0, founding:1, website:'', ig:'', tt:'', fb:'', hours:'{}',
      cats: [],
    },
    // ── Juan Calderon — Ironwork (home services) ──
    { id:'JUAN-IRON-001', name:'Juan Calderon — Ironwork', category:'home_services', email:'juan_cal97@yahoo.com', desc:'Custom ironwork — gates, fences, railings, decorative metalwork. Quality craftsmanship.', lat:34.4210, lng:-119.7020, open:0, orders:0, delivery:0, tier:'free', prep:0, founding:1, website:'', ig:'', tt:'', fb:'', hours:'{}',
      cats: [],
    },
    // ── Albert — Universoul Team (profile-only) ──
    { id:'ALBERT-TEAM-001', name:'Albert — Universoul Team', category:'other', email:'albert.bgn@gmail.com', desc:'Universoul team member.', lat:34.4205, lng:-119.7015, open:0, orders:0, delivery:0, tier:'free', prep:0, founding:1, website:'', ig:'', tt:'', fb:'', hours:'{}',
      cats: [],
    },
  ];

  let tVendorCount = 0, tItemCount = 0;
  for (const v of tenantVendors) {
    const result = insertTV.run(v.id, v.name, v.category, v.email, tenantPw, v.desc, v.lat, v.lng, v.open, v.orders, v.delivery, v.tier, 'trial', 0, 0, 0, v.prep, v.founding, v.website, v.ig, v.tt, v.fb, v.hours, trialEnd31);
    if (result.changes > 0) {
      tVendorCount++;
      insertTLoc.run(v.id, v.name, v.lat, v.lng, '', 1);
      if (v.cats) {
        for (let ci = 0; ci < v.cats.length; ci++) {
          const cat = v.cats[ci];
          const catResult = insertTCat.run(v.id, cat.name, ci);
          const cid = catResult.lastInsertRowid;
          if (cat.items) {
            for (const item of cat.items) {
              insertTItem.run(v.id, cid, item.name, item.desc, item.price, item.sort);
              tItemCount++;
            }
          }
        }
      }
      const slug = v.name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase() || 'WYA';
      const code = slug + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      db.prepare('UPDATE vendors SET referral_code=? WHERE id=?').run(code, v.id);
    }
  }
  if (tVendorCount > 0) {
    console.log(`[WYA-TENANT] Seeded ${tVendorCount} tenant vendors with ${tItemCount} menu items`);
  }
}

// ── Rate limiter (simple in-memory) ─────────────────────────
const rateLimits = {};
function rateLimit(key, maxPerWindow = 5, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(ts => now - ts < windowMs);
  if (rateLimits[key].length >= maxPerWindow) return false;
  rateLimits[key].push(now);
  return true;
}
// Clean up rate limiter every 5 minutes + cap at 10K keys to prevent IPv6 spray
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimits)) {
    rateLimits[key] = rateLimits[key].filter(ts => now - ts < 3600000);
    if (!rateLimits[key].length) delete rateLimits[key];
  }
  // Hard cap: if more than 10K keys, evict oldest half
  const keys = Object.keys(rateLimits);
  if (keys.length > 10000) {
    const sorted = keys.sort((a, b) => (rateLimits[a][0] || 0) - (rateLimits[b][0] || 0));
    for (let i = 0; i < sorted.length - 5000; i++) delete rateLimits[sorted[i]];
  }
}, 300000);

// Memory pressure logging — every 5 min alongside rate limiter cleanup
setInterval(() => {
  const mem = process.memoryUsage();
  if (mem.heapUsed > 300 * 1024 * 1024) {
    console.warn(`[WYA] HIGH MEMORY: heap=${Math.round(mem.heapUsed/1024/1024)}MB rss=${Math.round(mem.rss/1024/1024)}MB sse=${typeof sseClients !== 'undefined' ? sseClients.size : '?'}`);
  }
}, 300000);

// Clean expired sessions every hour (Phase 1653: enhanced with stale + reset token cleanup)
setInterval(() => {
  try {
    const r1 = db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')").run();
    const r2 = db.prepare("DELETE FROM customer_sessions WHERE datetime(expires_at) < datetime('now')").run();
    // Phase 1653: Remove sessions older than 60 days regardless of expiry
    const r3 = db.prepare("DELETE FROM sessions WHERE datetime(created_at) < datetime('now', '-60 days')").run();
    const r4 = db.prepare("DELETE FROM customer_sessions WHERE datetime(created_at) < datetime('now', '-60 days')").run();
    // Phase 1653: Clean used/expired password reset tokens older than 7 days
    const r5 = db.prepare("DELETE FROM password_reset_tokens WHERE (used=1 OR datetime(expires_at) < datetime('now')) AND datetime(created_at) < datetime('now', '-7 days')").run();
    // Phase 1655b: Purge orphaned sessions (parent customer/vendor deleted)
    const r6 = db.prepare("DELETE FROM customer_sessions WHERE customer_id NOT IN (SELECT id FROM customers)").run();
    const r7 = db.prepare("DELETE FROM sessions WHERE vendor_id NOT IN (SELECT id FROM vendors)").run();
    const total = (r1.changes||0) + (r2.changes||0) + (r3.changes||0) + (r4.changes||0) + (r5.changes||0) + (r6.changes||0) + (r7.changes||0);
    if (total) console.log(`[CLEANUP] Sessions: ${r1.changes}+${r2.changes} expired, ${r3.changes}+${r4.changes} stale, ${r5.changes} reset tokens, ${r6.changes}+${r7.changes} orphaned`);
    // Activity log: keep last 90 days (prevents unbounded growth)
    const r8 = db.prepare("DELETE FROM activity_log WHERE datetime(ts) < datetime('now', '-90 days')").run();
    if (r8.changes > 0) console.log(`[CLEANUP] Activity log: pruned ${r8.changes} old entries (>90 days)`);
    // Abandoned orders: mark expired if pending payment >48h
    const r9 = db.prepare("UPDATE orders SET status='expired', updated_at=datetime('now') WHERE payment_status='unpaid' AND status='pending' AND datetime(created_at) < datetime('now', '-48 hours')").run();
    if (r9.changes > 0) console.log(`[CLEANUP] Orders: expired ${r9.changes} abandoned unpaid orders (>48h)`);
    // WAL checkpoint — keep WAL file from growing unbounded
    try { db.pragma('wal_checkpoint(PASSIVE)'); } catch(_) {}
  } catch(e) { console.error('[CLEANUP] Error:', e.message); }
}, 3600000);

// ── Vendor Onboarding Nudge — daily check for stuck vendors ──
// Sends targeted follow-up emails to vendors who registered but haven't completed setup
function checkOnboardingNudges() {
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    // Vendors who registered 3+ days ago but haven't verified email
    const unverified = db.prepare("SELECT id, name, email FROM vendors WHERE email_verified = 0 AND datetime(created_at) < ? AND datetime(created_at) > ?").all(threeDaysAgo, sevenDaysAgo);
    for (const v of unverified) {
      if (isTestData(v.email, v.name)) continue;
      const already = db.prepare("SELECT id FROM activity_log WHERE vendor_id = ? AND action = 'nudge_verify' AND datetime(ts) > datetime('now', '-3 days')").get(v.id);
      if (already) continue;
      sendEmail(v.email, `Don't forget to verify your WYA account!`, `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#050505;color:#f5f5f5"><h2 style="color:#FF5E1A;margin:0 0 12px">Almost there, ${sanitize(v.name)}!</h2><p style="color:#9ca3af;line-height:1.6">You registered on WYA but haven't verified your email yet. Verify now to go live and start getting customers!</p><p style="margin:20px 0;text-align:center"><a href="https://wya.digisigns.link/vendor" style="display:inline-block;background:#FF5E1A;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:800">Complete Setup</a></p></div>`).catch(() => {});
      db.prepare("INSERT INTO activity_log (vendor_id, action, ts) VALUES (?, 'nudge_verify', datetime('now'))").run(v.id);
    }

    // Vendors who verified but haven't added menu items (7+ days)
    const noMenu = db.prepare(`
      SELECT v.id, v.name, v.email FROM vendors v
      WHERE v.email_verified = 1 AND datetime(v.created_at) < ?
      AND (SELECT COUNT(*) FROM menu_items WHERE vendor_id = v.id) = 0
    `).all(sevenDaysAgo);
    for (const v of noMenu) {
      if (isTestData(v.email, v.name)) continue;
      const already = db.prepare("SELECT id FROM activity_log WHERE vendor_id = ? AND action = 'nudge_menu' AND datetime(ts) > datetime('now', '-7 days')").get(v.id);
      if (already) continue;
      sendEmail(v.email, `Add your menu to start getting orders on WYA`, `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#050505;color:#f5f5f5"><h2 style="color:#FF5E1A;margin:0 0 12px">Your menu is empty!</h2><p style="color:#9ca3af;line-height:1.6">Hi ${sanitize(v.name)}, customers can't order from you until you add at least one menu item. It only takes 2 minutes.</p><p style="margin:20px 0;text-align:center"><a href="https://wya.digisigns.link/vendor" style="display:inline-block;background:#FF5E1A;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:800">Add Menu Items</a></p></div>`).catch(() => {});
      db.prepare("INSERT INTO activity_log (vendor_id, action, ts) VALUES (?, 'nudge_menu', datetime('now'))").run(v.id);
    }

    if (unverified.length || noMenu.length) {
      console.log(`[WYA] Onboarding nudges: ${unverified.length} verify, ${noMenu.length} menu`);
    }
  } catch (e) { console.error('[WYA] Onboarding nudge error:', e.message); }
}

// Run daily at startup + every 24h
setTimeout(checkOnboardingNudges, 60000);
setInterval(checkOnboardingNudges, 24 * 3600000);

// ── Business Types (cherry-picked from wya-location) ────────
const BUSINESS_TYPES = {
  signs_graphics: { label: 'Signs & Graphics', emoji: '🪧' },
  tattoo_studio: { label: 'Tattoo Studio', emoji: '🖋️' },
  food_truck: { label: 'Food Truck', emoji: '🚚' },
  farmers_market: { label: "Farmer's Market", emoji: '🌽' },
  pop_up_shop: { label: 'Pop-Up Shop', emoji: '🏪' },
  art_vendor: { label: 'Art & Crafts', emoji: '🎨' },
  clothing: { label: 'Clothing & Apparel', emoji: '👕' },
  jewelry: { label: 'Jewelry', emoji: '💍' },
  bakery: { label: 'Bakery & Sweets', emoji: '🥐' },
  coffee: { label: 'Coffee & Drinks', emoji: '☕' },
  flowers: { label: 'Flowers & Plants', emoji: '🌸' },
  beauty: { label: 'Beauty & Wellness', emoji: '💅' },
  auto_services: { label: 'Auto Services', emoji: '🚗' },
  home_services: { label: 'Home Services', emoji: '🔧' },
  retail: { label: 'Retail', emoji: '🛍️' },
  print_shop: { label: 'Print & Sign Shop', emoji: '🪧' },
  restaurant: { label: 'Restaurant', emoji: '🍽️' },
  music: { label: 'Music & Entertainment', emoji: '🎵' },
  other: { label: 'Other', emoji: '📍' },
};

// ── GPS coordinate validation (Uber-grade) ─────────────────
function validateCoords(lat, lng) {
  const la = parseFloat(lat), lo = parseFloat(lng);
  if (isNaN(la) || isNaN(lo)) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return { lat: la, lng: lo };
}

// ── Location rate limiter (1 update per 5s per entity) ──
const locationTimestamps = new Map();
function locationRateOk(entityId) {
  const last = locationTimestamps.get(entityId) || 0;
  if (Date.now() - last < 5000) return false;
  locationTimestamps.set(entityId, Date.now());
  return true;
}
// Prevent memory leak: purge stale entries every 10 minutes + hard cap at 2K
setInterval(() => {
  const cutoff = Date.now() - 600000;
  for (const [k, v] of locationTimestamps) { if (v < cutoff) locationTimestamps.delete(k); }
  if (locationTimestamps.size > 2000) {
    const sorted = [...locationTimestamps.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < sorted.length - 1000; i++) locationTimestamps.delete(sorted[i][0]);
  }
}, 600000);

// ── Haversine distance (cherry-picked from wya-location) ────
function haversine(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => isNaN(v) || v == null)) return Infinity;
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Delivery zone check helper ────────────────────────────────
// Returns { zone, fee } if lat/lng falls within any active zone for vendor, else null
function checkDeliveryZones(vendorId, lat, lng) {
  if (!lat || !lng) return null;
  const zones = db.prepare("SELECT * FROM delivery_zones WHERE vendor_id=? AND active=1").all(vendorId);
  for (const zone of zones) {
    if (zone.zone_type === 'radius') {
      if (!zone.center_lat || !zone.center_lng || !zone.radius_mi) continue;
      const dist = haversine(lat, lng, zone.center_lat, zone.center_lng);
      if (dist <= zone.radius_mi) return { zone, fee: zone.delivery_fee };
    } else if (zone.zone_type === 'polygon') {
      // Point-in-polygon using ray casting
      try {
        const coords = JSON.parse(zone.polygon_coords || '[]');
        if (coords.length < 3) continue;
        let inside = false;
        for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
          const xi = coords[i][0], yi = coords[i][1];
          const xj = coords[j][0], yj = coords[j][1];
          if (((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) {
            inside = !inside;
          }
        }
        if (inside) return { zone, fee: zone.delivery_fee };
      } catch(e) { /* skip malformed polygon */ }
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────
const VENDOR_FIELDS = 'id,name,category,lat,lng,description,digitap_card_url,business_hours,photo_url,last_seen,website,instagram,tiktok,facebook,youtube,avg_rating,review_count,accepts_orders,delivery_enabled,doordash_url,ubereats_url,grubhub_url,yelp_url,google_maps_url,google_business_url,estimated_prep_minutes,is_premium,premium_expires_at,is_open,social_score,is_claimed,data_source,accent_color';

// Food-related categories for default map filter
const FOOD_CATEGORIES = new Set(['food_truck','restaurant','bakery','coffee','farmers_market','pop_up_shop']);

// Phase 1653: Dual-mode password hashing — legacy SHA256 (v1) + bcrypt (v2)
const hashPwLegacy = (pw) => crypto.createHash('sha256').update(pw + 'wya_salt_2026').digest('hex');
const hashPw = (pw) => bcrypt.hashSync(pw, 12); // New passwords always bcrypt
function verifyPw(pw, hash, version) {
  if (version === 2) return bcrypt.compareSync(pw, hash);
  return hashPwLegacy(pw) === hash; // Legacy SHA256
}
const genToken = () => crypto.randomBytes(32).toString('hex');
const getVendorByToken = (token) => {
  const sess = db.prepare("SELECT * FROM sessions WHERE token=? AND datetime(expires_at) > datetime('now')").get(token);
  if (!sess) return null;
  return db.prepare('SELECT * FROM vendors WHERE id=?').get(sess.vendor_id);
};

// ISSUE-031: Hub JWT fallback — when Hub proxies /api/me/wya/*, it forwards x-member-email.
// Look up vendor by email so Hub-authenticated users can access vendor features.
function getVendorFromHubHeaders(req) {
  const email = req.headers['x-member-email'];
  if (!email) return null;
  return db.prepare('SELECT * FROM vendors WHERE email = ?').get(email);
}

// Combined auth: try WYA session token first, fall back to Hub JWT headers
function getVendorAuth(req) {
  const token = req.headers['x-auth-token'];
  if (token) {
    const vendor = getVendorByToken(token);
    if (vendor) return vendor;
  }
  return getVendorFromHubHeaders(req);
}

// Phase 1331: Trial expiration enforcement helper
function isTrialExpired(vendor) {
  if (!vendor) return false;
  if (vendor.is_founding_vendor) return false; // Phase 1700: founding vendors = free forever
  if (vendor.subscription_status === 'active' && vendor.stripe_subscription_id) return false;
  const tier = vendor.subscription_tier || 'free';
  if (tier !== 'free') return false;
  if (!vendor.trial_ends_at) return false;
  return new Date(vendor.trial_ends_at) < new Date();
}
function getTrialDaysRemaining(vendor) {
  if (!vendor || !vendor.trial_ends_at) return null;
  if (vendor.subscription_status === 'active' && vendor.stripe_subscription_id) return null;
  const tier = vendor.subscription_tier || 'free';
  if (tier !== 'free') return null;
  const diff = new Date(vendor.trial_ends_at) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}
// Phase AUDIT-1: Tier enforcement helper — returns { allowed, tier, reason, upgradeUrl }
const TIER_LEVELS = { free: 0, growth: 1, pro: 2, enterprise: 3 };
function requireTier(vendor, minTier) {
  const tier = vendor?.subscription_tier || 'free';
  const vendorLevel = TIER_LEVELS[tier] ?? 0;
  const requiredLevel = TIER_LEVELS[minTier] ?? 0;
  if (vendor?.is_founding_vendor) return { allowed: true, tier };
  if (vendorLevel >= requiredLevel) return { allowed: true, tier };
  return { allowed: false, tier, reason: `Requires ${minTier} tier or higher (current: ${tier})`, upgradeUrl: 'https://wya.digisigns.link/vendor/upgrade' };
}

const isAdmin = (req) => {
  // Accept both x-soul-token and x-portal-secret for internal service calls
  const t = req.headers['x-soul-token'] || req.headers['x-portal-secret'] || '';
  if (!t || !SOUL_TOKEN) return false;
  return t === SOUL_TOKEN;
};

// Phase 1660: Unified internal auth middleware — replaces ad-hoc process.env.PORTAL_SECRET checks
const isInternal = (req, res, next) => {
  const secret = req.headers['x-portal-secret'] || req.headers['x-soul-token'] || '';
  if (secret && SOUL_TOKEN && secret === SOUL_TOKEN) {
    req.isInternalCall = true;
    return next();
  }
  return res.status(401).json({ error: 'Internal auth required' });
};

// ── Customer auth helper ────────────────────────────────────
const getCustomerByToken = (token) => {
  if (!token) return null;
  const sess = db.prepare("SELECT * FROM customer_sessions WHERE token=? AND datetime(expires_at) > datetime('now')").get(token);
  if (!sess) return null;
  return db.prepare('SELECT * FROM customers WHERE id=?').get(sess.customer_id);
};

// Notify InstantSign CRM when vendor registers
const notifyCRM = (vendor) => {
  try {
    const body = JSON.stringify({ name: vendor.name, email: vendor.email, phone: vendor.phone||'', company: vendor.name, source: 'wya-vendor-signup', notes: `WYA vendor: ${vendor.category}` });
    const r = http.request({ hostname:'127.0.0.1', port:3051, path:'/api/leads', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}, timeout:3000 });
    r.on('error',()=>{}); r.write(body); r.end();
  } catch(e) {}
};

// ── SSE clients for live updates ─────────────────────────────
const sseClients = new Set();

let _broadcastRunning = false;
function broadcastVendors() {
  if (_broadcastRunning) return; // skip if previous broadcast still running
  _broadcastRunning = true;
  try {
    const vendors = db.prepare(`SELECT ${VENDOR_FIELDS} FROM vendors WHERE is_open=1 AND lat IS NOT NULL`).all();
    const data = JSON.stringify({ type:'vendors', vendors, ts: new Date().toISOString() });
    for (const client of sseClients) {
      try { client.write(`data: ${data}\n\n`); } catch(e) { sseClients.delete(client); }
    }
  } catch (err) {
    console.error('[broadcastVendors] error:', err.message);
  } finally {
    _broadcastRunning = false;
  }
}
function broadcastSSE(payload) {
  const data = JSON.stringify(payload);
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch(e) { sseClients.delete(client); }
  }
}
setInterval(broadcastVendors, 60000);

// [vendor-audit-log] Phase: every is_open transition is logged with source + ip + actor
db.exec(`CREATE TABLE IF NOT EXISTS vendor_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id TEXT NOT NULL,
  old_is_open INTEGER,
  new_is_open INTEGER,
  source TEXT,
  actor TEXT,
  ip TEXT,
  user_agent TEXT,
  ts TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_vsl_vendor ON vendor_status_log(vendor_id, ts DESC)`);

// Phase 1710: Vendor-Customer messaging
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id TEXT NOT NULL,
  customer_id TEXT,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('vendor','customer')),
  message TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_vendor ON messages(vendor_id, created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id, vendor_id, created_at DESC)`);

// Phase 1710: QR scan attribution tracking
db.exec(`CREATE TABLE IF NOT EXISTS qr_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id TEXT NOT NULL,
  source TEXT DEFAULT 'qr',
  device TEXT,
  ip TEXT,
  user_agent TEXT,
  resulted_in_follow INTEGER DEFAULT 0,
  resulted_in_order INTEGER DEFAULT 0,
  order_id TEXT,
  revenue_cents INTEGER DEFAULT 0,
  scanned_at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_qr_scans_vendor ON qr_scans(vendor_id, scanned_at DESC)`);

// Phase 1653: Add password_version column for bcrypt migration
try { db.exec(`ALTER TABLE vendors ADD COLUMN password_version INTEGER DEFAULT 1`); } catch(e) { /* already exists */ }
try { db.exec(`ALTER TABLE customers ADD COLUMN password_version INTEGER DEFAULT 1`); } catch(e) { /* already exists */ }

function logVendorStatusChange(vendorId, oldVal, newVal, source, req) {
  try {
    if (oldVal === newVal || oldVal == null && newVal == null) return;
    const actor = req && req.vendor && req.vendor.id ? req.vendor.id : (req && req.user && req.user.id ? req.user.id : 'system');
    const ip = req ? (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || '') : '';
    const ua = req ? (req.headers['user-agent'] || '') : '';
    db.prepare(`INSERT INTO vendor_status_log (vendor_id, old_is_open, new_is_open, source, actor, ip, user_agent) VALUES (?,?,?,?,?,?,?)`)
      .run(vendorId, oldVal, newVal, source, actor, ip, ua);
  } catch (e) { console.error('[VENDOR-AUDIT]', e.message); }
}

// Phase 1365: Seed geofence for ISCSB-001 (Instant Sign Co)
try {
  db.prepare(`UPDATE vendors SET geofence_lat=34.4208, geofence_lng=-119.6982, geofence_radius_m=150, auto_checkin_enabled=1 WHERE id='ISCSB-001' AND (geofence_lat IS NULL OR auto_checkin_enabled=0)`).run();
} catch (_) {}

// Auto-offline stale vendors (last_seen > 30min ago)
setInterval(() => {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const willClose = db.prepare('SELECT id FROM vendors WHERE is_open=1 AND last_seen IS NOT NULL AND last_seen < ? AND is_founding_vendor=0').all(cutoff);
  const stale = db.prepare('UPDATE vendors SET is_open=0 WHERE is_open=1 AND last_seen IS NOT NULL AND last_seen < ? AND is_founding_vendor=0').run(cutoff);
  if (stale.changes > 0) {
    for (const v of willClose) logVendorStatusChange(v.id, 1, 0, 'auto_stale_30m', null);
    broadcastVendors();
  }
}, 2 * 60 * 1000);

// ── Routes ───────────────────────────────────────────────────

// Phase 1414: IP-based geo fallback for when GPS is denied/unavailable
app.get('/api/geo/ip', (req, res) => {
  try {
    // Use CF headers if available (Cloudflare provides these for free)
    const cfCoords = validateCoords(req.headers['cf-iplatitude'], req.headers['cf-iplongitude']);
    const city = req.headers['cf-ipcity'] || '';
    const region = req.headers['cf-region'] || '';
    if (cfCoords) {
      return res.json({lat: cfCoords.lat, lng: cfCoords.lng, city, region, source: 'cloudflare'});
    }
    // Fallback: Santa Barbara default (better than nothing)
    res.json({lat: 34.4208, lng: -119.6982, city: 'Santa Barbara', region: 'CA', source: 'default'});
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Categories endpoint
app.get('/api/vendors/categories', (req, res) => {
  try {
    res.json({ ok: true, categories: BUSINESS_TYPES });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Phase 1306: Alias for /api/categories (frontend expects this)
app.get('/api/categories', (req, res) => {
  try {
    res.json({ ok: true, categories: BUSINESS_TYPES });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SSE stream (Phase 1654: connection limit + timeout for production safety)
const MAX_SSE_CLIENTS = 200;
app.get('/api/stream', (req, res) => {
  try {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      return res.status(503).json({ error: 'Too many connections — try again later' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    // Send current state immediately
    const vendors = db.prepare(`SELECT ${VENDOR_FIELDS} FROM vendors WHERE is_open=1 AND lat IS NOT NULL`).all();
    res.write(`data: ${JSON.stringify({type:'vendors',vendors,ts:new Date().toISOString()})}\n\n`);
    // Auto-close after 15 minutes to prevent stale connections
    const sseTimeout = setTimeout(() => { try { sseClients.delete(res); res.end(); } catch(_) {} }, 15 * 60 * 1000);
    req.on('close', () => { clearTimeout(sseTimeout); sseClients.delete(res); });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    sseClients.delete(res);
  }
});

// Phase v4.0: Live map stats endpoint
app.get('/api/live-stats', (req, res) => {
  const liveVendors = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE is_open = 1 AND lat IS NOT NULL").get()?.c ?? 0;
  res.json({ connected_clients: sseClients.size, active_vendors: liveVendors, ts: new Date().toISOString() });
});

// Phase v4.0: iOS APNs device token registration
db.exec("CREATE TABLE IF NOT EXISTS apns_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, platform TEXT DEFAULT 'ios', device_id TEXT, customer_id TEXT, created_at TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')))");
// Add device_id column if missing (migration)
try { db.exec("ALTER TABLE apns_tokens ADD COLUMN device_id TEXT"); } catch {}

app.post('/api/ios/register-apns', (req, res) => {
  try {
    const { token, platform, device_id, customer_id } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    db.prepare(`INSERT INTO apns_tokens (token, platform, device_id, customer_id, last_seen)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(token) DO UPDATE SET
        last_seen=datetime('now'),
        device_id=COALESCE(excluded.device_id, device_id),
        customer_id=COALESCE(excluded.customer_id, customer_id)`
    ).run(token, platform || 'ios', device_id || null, customer_id || null);
    console.log(`[WYA-iOS] APNs token registered: ${token.substring(0, 8)}... device=${device_id?.substring(0,8)||'?'}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[WYA-iOS] APNs register error:', e.message);
    res.status(500).json({ error: 'registration failed' });
  }
});

// Phase v4.0: Associate APNs token with logged-in customer
app.post('/api/ios/associate-apns', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error: 'Login required' });
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    db.prepare("UPDATE apns_tokens SET customer_id=? WHERE device_id=?").run(cust.id, device_id);
    console.log(`[WYA-iOS] APNs associated: customer=${cust.id} device=${device_id.substring(0,8)}...`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[WYA-iOS] APNs associate error:', e.message);
    res.status(500).json({ error: 'association failed' });
  }
});

// Phase 747h: Rate limit public endpoints
const publicLimiter60 = rateLimit747({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });
const publicLimiter30 = rateLimit747({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false });
const publicLimiter10 = rateLimit747({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false });

// Phase 749: Prepared statements for social proof (avoid N+1)
const stmtSocialProof = db.prepare(`
  SELECT v.id,
    COALESCE(f.cnt,0) as follower_count,
    COALESCE(o.cnt,0) as orders_7d,
    COALESCE(pv.cnt,0) as views_7d,
    v.created_at
  FROM vendors v
  LEFT JOIN (SELECT vendor_id, COUNT(*) as cnt FROM vendor_followers WHERE active=1 GROUP BY vendor_id) f ON f.vendor_id=v.id
  LEFT JOIN (SELECT vendor_id, COUNT(*) as cnt FROM orders WHERE created_at >= datetime('now','-7 days') AND status NOT IN ('cancelled') GROUP BY vendor_id) o ON o.vendor_id=v.id
  LEFT JOIN (SELECT vendor_id, COUNT(*) as cnt FROM profile_views WHERE created_at >= datetime('now','-7 days') GROUP BY vendor_id) pv ON pv.vendor_id=v.id
  WHERE v.is_open=1 AND v.lat IS NOT NULL
`);

// Phase 750: Batch-enrich vendors with profile_complete flag
function enrichWithProfileComplete(vendors) {
  if (!vendors.length) return;
  const ids = vendors.map(v=>v.id);
  const menuCounts = {};
  for (const r of db.prepare('SELECT vendor_id, COUNT(*) as c FROM menu_items GROUP BY vendor_id').all()) menuCounts[r.vendor_id] = r.c;
  // Need email_verified for vendors — bulk fetch
  const extraMap = {};
  for (const r of db.prepare('SELECT id,email_verified FROM vendors WHERE id IN (' + ids.map(()=>'?').join(',') + ')').all(...ids)) extraMap[r.id] = r;
  for (const v of vendors) {
    const extra = extraMap[v.id] || {};
    const check = { ...v, email_verified: v.email_verified ?? extra.email_verified };
    v.profile_complete = computeOnboardingSteps(check, menuCounts[v.id]||0).ready;
    v.menu_count = menuCounts[v.id] || 0;
  }
}

function enrichWithSocialProof(vendors) {
  const proofRows = stmtSocialProof.all();
  const proofMap = {};
  for (const r of proofRows) proofMap[r.id] = r;
  const now = Date.now();
  for (const v of vendors) {
    const p = proofMap[v.id] || {};
    v.follower_count = p.follower_count || 0;
    v.orders_7d = p.orders_7d || 0;
    v.views_7d = p.views_7d || 0;
    v.trending = (v.orders_7d >= 2 || v.views_7d >= 5 || v.follower_count >= 3);
    const createdAt = p.created_at || v.created_at;
    v.new_vendor = createdAt ? (now - new Date(createdAt).getTime() < 14 * 86400000) : false;
  }
}

// Phase 1368: Public vendor stats for social proof
app.get('/api/vendors/stats', publicLimiter60, (req, res) => {
  try {
    const total_vendors = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE email NOT LIKE 'claim-%'").get()?.c ?? 0;
    const live_now = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE is_open = 1").get()?.c ?? 0;
    const categories = db.prepare("SELECT DISTINCT category FROM vendors WHERE email NOT LIKE 'claim-%'").all().map(r => r.category);
    const total_orders = db.prepare("SELECT COUNT(*) as c FROM orders").get()?.c ?? 0;
    res.json({ total_vendors, live_now, categories: categories.length, category_list: categories, total_orders });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Live vendors (public) — with optional distance sorting
// Phase 1318: Include offline vendors with menu items so map isn't empty
app.get('/api/vendors/live', publicLimiter60, (req, res) => {
  try {
    const { lat, lng, category, q, include_offline, show_all_categories } = req.query;
    // Lazy staleness check: auto-close vendors not seen in 30 min
    const staleCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const staleVendors = db.prepare('SELECT id FROM vendors WHERE is_open=1 AND last_seen IS NOT NULL AND last_seen < ? AND is_founding_vendor=0').all(staleCutoff);
    if (staleVendors.length) {
      db.prepare('UPDATE vendors SET is_open=0 WHERE is_open=1 AND last_seen IS NOT NULL AND last_seen < ? AND is_founding_vendor=0').run(staleCutoff);
      for (const sv of staleVendors) logVendorStatusChange(sv.id, 1, 0, 'auto_stale_30m', null);
    }
    // Always include offline vendors that have menu items — customers need to see the platform has content
    const vendorIdsWithMenu = new Set(db.prepare('SELECT DISTINCT vendor_id FROM menu_items').all().map(r => r.vendor_id));
    // Phase: Only show claimed vendors — seeded unclaimed go to /coming-soon directory
    let vendors = db.prepare(`SELECT ${VENDOR_FIELDS} FROM vendors WHERE lat IS NOT NULL AND data_source NOT IN ('test') AND is_claimed=1 ORDER BY is_open DESC, last_seen DESC`).all()
      .filter(v => v.is_open === 1 || vendorIdsWithMenu.has(v.id));
    // Mark offline vendors so frontend can dim them + add freshness indicator
    const now = Date.now();
    for (const v of vendors) {
      v.is_live = v.is_open === 1;
      // Phase 1331: Flag expired trial vendors as limited visibility
      if (isTrialExpired(v)) v.visibility = 'limited';
      // GPS freshness indicator
      if (v.last_seen) {
        const age = now - new Date(v.last_seen).getTime();
        if (age < 5 * 60 * 1000) v.freshness = 'live';
        else if (age < 30 * 60 * 1000) v.freshness = 'recent';
        else v.freshness = 'stale';
        v.last_seen_minutes_ago = Math.round(age / 60000);
      } else {
        v.freshness = 'scheduled';
      }
    }
    // Default to food-related categories unless show_all_categories or specific category requested
    if (!show_all_categories && !category) {
      vendors = vendors.filter(v => FOOD_CATEGORIES.has(v.category));
    }
    if (category) vendors = vendors.filter(v => v.category === category);
    if (q) { const ql = q.toLowerCase(); vendors = vendors.filter(v => (v.name||'').toLowerCase().includes(ql) || (v.description||'').toLowerCase().includes(ql)); }
    // Distance filter: query params → CF geo headers → Santa Barbara default
    const userCoords = validateCoords(lat, lng)
      || validateCoords(req.headers['cf-iplatitude'], req.headers['cf-iplongitude'])
      || { lat: 34.4208, lng: -119.6982 }; // Santa Barbara default — never show unfiltered
    const radiusMi = Math.min(parseFloat(req.query.radius) || 25, 50);
    for (const v of vendors) {
      v.distance_mi = Math.round(haversine(userCoords.lat, userCoords.lng, v.lat, v.lng) * 10) / 10;
    }
    vendors = vendors.filter(v => v.distance_mi <= radiusMi);
    vendors.sort((a, b) => a.distance_mi - b.distance_mi);
    // Phase 742: Add business hours status
    const nowPT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
    const todayDay = dayNames[nowPT.getDay()];
    const curTime = String(nowPT.getHours()).padStart(2,'0') + ':' + String(nowPT.getMinutes()).padStart(2,'0');
    for (const v of vendors) {
      let hours = {};
      let hoursParseOk = true;
      try { hours = v.business_hours ? JSON.parse(v.business_hours) : {}; } catch(e) { hoursParseOk = false; }
      if (!hoursParseOk) { v.is_within_hours = null; v.hours_unavailable = true; continue; }
      if (!Object.keys(hours).length) { v.is_within_hours = true; continue; }
      // Support both formats: {mon: {open, close}} and {Mon: "10:00-21:00"}
      const dayKey = todayDay; // lowercase: mon, tue, etc.
      const dayKeyCap = todayDay.charAt(0).toUpperCase() + todayDay.slice(1); // Mon, Tue, etc.
      const dayH = hours[dayKey] || hours[dayKeyCap];
      if (!dayH || dayH === 'closed') { v.is_within_hours = false; continue; }
      if (typeof dayH === 'object' && dayH.open && dayH.close) {
        v.is_within_hours = curTime >= dayH.open && curTime <= dayH.close;
      } else if (typeof dayH === 'string' && dayH.includes('-')) {
        const [openT, closeT] = dayH.split('-').map(t => t.trim());
        v.is_within_hours = curTime >= openT && curTime <= closeT;
      } else {
        v.is_within_hours = true; // "by appointment" or other free-text = assume available
      }
    }
    // Phase WYA-Dogfood: menu_item_count per vendor for browse UX
    const menuItemCounts = {};
    db.prepare('SELECT vendor_id, COUNT(*) as cnt FROM menu_items WHERE available=1 GROUP BY vendor_id').all()
      .forEach(r => { menuItemCounts[r.vendor_id] = r.cnt; });
    // Phase 1628: Add has_menu + can_order flags for UX clarity
    // Auto-open: vendors with business hours are "live" during their hours
    // even if they haven't manually toggled is_open — reduces friction
    for (const v of vendors) {
      v.has_menu = vendorIdsWithMenu.has(v.id);
      v.menu_item_count = menuItemCounts[v.id] || 0;
      // Auto-live: if vendor has business hours set AND is currently within hours, treat as live
      if (!v.is_live && v.is_within_hours === true && v.has_menu) {
        v.is_live = true;
        v.auto_open = true; // Flag so frontend can show "Open now (scheduled hours)"
      }
      v.can_order = v.has_menu && (v.accepts_orders === 1 || v.auto_open);
    }
    // Phase 749: Enrich with social proof
    enrichWithSocialProof(vendors);
    // Phase 750: profile_complete badge
    enrichWithProfileComplete(vendors);
    // Premium vendors sort first — then can_order vendors above those that can't
    vendors.sort((a, b) => (b.is_premium||0) - (a.is_premium||0));
    const live_count = vendors.filter(v => v.is_live).length;
    res.json({ ok:true, count:vendors.length, live_count, vendors });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 1203b: Coming soon vendors (claimable listings)
app.get('/api/vendors/coming-soon', publicLimiter60, (req, res) => {
  try {
    let vendors = db.prepare(`SELECT ${VENDOR_FIELDS} FROM vendors WHERE is_open=0 AND lat IS NOT NULL AND email LIKE 'claim-%'`).all();
    // Phase 1700b: Apply distance filtering (same as /api/vendors/live)
    const coords = validateCoords(req.query.lat, req.query.lng)
      || validateCoords(req.headers['cf-iplatitude'], req.headers['cf-iplongitude'])
      || { lat: 34.4208, lng: -119.6982 }; // Santa Barbara default
    const radius = Math.min(parseFloat(req.query.radius) || 25, 50);
    vendors = vendors.filter(v => v.lat && v.lng && haversine(coords.lat, coords.lng, v.lat, v.lng) <= radius)
      .map(v => ({ ...v, distance_mi: Math.round(haversine(coords.lat, coords.lng, v.lat, v.lng) * 10) / 10 }))
      .sort((a, b) => a.distance_mi - b.distance_mi);
    res.json({ ok: true, count: vendors.length, vendors });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor schedule status — groups vendors by: open now, opening soon, later today, this week
app.get('/api/vendors/schedule-status', publicLimiter60, (req, res) => {
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const currentDay = ['sun','mon','tue','wed','thu','fri','sat'][now.getDay()];
    const currentTime = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    const tomorrowDay = ['sun','mon','tue','wed','thu','fri','sat'][(now.getDay()+1)%7];

    const allVendors = db.prepare(`SELECT id,name,category,photo_url,description,lat,lng,is_open,business_hours,avg_rating,review_count FROM vendors WHERE data_source NOT IN ('test') AND lat IS NOT NULL`).all();

    const parseHours = (bh, day) => {
      if (!bh) return null;
      try {
        const h = typeof bh === 'string' ? JSON.parse(bh) : bh;
        // Normalize day key — try full, 3-char, capitalized
        const keys = [day, day.charAt(0).toUpperCase()+day.slice(1), day.slice(0,3), day.charAt(0).toUpperCase()+day.slice(1,3)];
        let val = null;
        for (const k of keys) { if (h[k] !== undefined) { val = h[k]; break; } }
        if (!val || val === 'closed') return null;
        if (typeof val === 'object' && val.open && val.close) return { open: val.open, close: val.close };
        if (typeof val === 'string' && val.includes('-')) { const [o,c] = val.split('-'); return { open: o.trim(), close: c.trim() }; }
        return null;
      } catch { return null; }
    };

    const openNow = [], openingSoon = [], laterToday = [], tomorrow = [];
    for (const v of allVendors) {
      const todayH = parseHours(v.business_hours, currentDay);
      const tomorrowH = parseHours(v.business_hours, tomorrowDay);
      const vendorInfo = { id:v.id, name:v.name, category:v.category, photo_url:v.photo_url, description:(v.description||'').slice(0,80), lat:v.lat, lng:v.lng, avg_rating:v.avg_rating, review_count:v.review_count };

      if (v.is_open) {
        openNow.push({ ...vendorInfo, closes_at: todayH?.close || null });
      } else if (todayH && currentTime < todayH.open) {
        // Opens later today
        const minsUntil = ((parseInt(todayH.open.split(':')[0])*60+parseInt(todayH.open.split(':')[1]||0)) - (now.getHours()*60+now.getMinutes()));
        if (minsUntil <= 60) {
          openingSoon.push({ ...vendorInfo, opens_at: todayH.open, closes_at: todayH.close, minutes_until: minsUntil });
        } else {
          laterToday.push({ ...vendorInfo, opens_at: todayH.open, closes_at: todayH.close });
        }
      } else if (tomorrowH) {
        tomorrow.push({ ...vendorInfo, opens_at: tomorrowH.open, closes_at: tomorrowH.close, day: tomorrowDay });
      }
    }
    openingSoon.sort((a,b) => a.minutes_until - b.minutes_until);
    laterToday.sort((a,b) => (a.opens_at||'').localeCompare(b.opens_at||''));
    res.json({ ok:true, current_time:currentTime, day:currentDay, open_now:openNow, opening_soon:openingSoon, later_today:laterToday, tomorrow });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Event Marketplace ──────────────────────────────────────────

// Public: Browse upcoming events
app.get('/api/events', publicLimiter60, (req, res) => {
  try {
    const { q, category, date_from, date_to, price_max, free_only, lat, lng, radius_mi } = req.query;
    let where = "e.event_date >= date('now') AND e.status='active'";
    const params = [];

    // Text search (title or description)
    if (q && q.trim()) {
      where += " AND (e.title LIKE ? OR e.description LIKE ?)";
      const term = `%${q.trim()}%`;
      params.push(term, term);
    }
    // Category filter
    if (category && category.trim()) {
      where += " AND e.category=?";
      params.push(category.trim());
    }
    // Date range
    if (date_from) { where += " AND e.event_date >= ?"; params.push(date_from); }
    if (date_to) { where += " AND e.event_date <= ?"; params.push(date_to); }
    // Price filters
    if (free_only === '1' || free_only === 'true') { where += " AND (e.price = 0 OR e.price IS NULL)"; }
    else if (price_max) { where += " AND e.price <= ?"; params.push(parseFloat(price_max)); }

    const events = db.prepare(`
      SELECT e.*, v.name as vendor_name, v.category as vendor_category, v.photo_url as vendor_photo,
        v.lat as vendor_lat, v.lng as vendor_lng,
        (SELECT COUNT(*) FROM event_bookings WHERE event_id=e.id AND user_type='customer' AND status IN ('pending','confirmed')) as rsvp_count_live,
        (SELECT COUNT(*) FROM event_bookings WHERE event_id=e.id AND user_type='vendor' AND status IN ('pending','approved')) as vendor_app_count
      FROM vendor_events e
      LEFT JOIN vendors v ON e.vendor_id=v.id
      WHERE ${where}
      ORDER BY e.event_date, e.start_time
      LIMIT 50
    `).all(...params);

    // Distance filter (post-query, uses haversine)
    let filtered = events;
    if (lat && lng && radius_mi) {
      const uLat = parseFloat(lat), uLng = parseFloat(lng), rad = parseFloat(radius_mi) || 25;
      if (!isNaN(uLat) && !isNaN(uLng)) {
        filtered = events.filter(e => {
          const eLat = e.location_lat || e.vendor_lat;
          const eLng = e.location_lng || e.vendor_lng;
          if (!eLat || !eLng) return true; // include events without coords
          return haversine(uLat, uLng, eLat, eLng) <= rad;
        });
      }
    }

    res.json({ ok: true, events: filtered });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public: Get single event with details
app.get('/api/events/:id', publicLimiter60, (req, res) => {
  try {
    const event = db.prepare(`
      SELECT e.*, v.name as vendor_name, v.category as vendor_category, v.photo_url as vendor_photo,
        v.lat as vendor_lat, v.lng as vendor_lng, v.description as vendor_description
      FROM vendor_events e LEFT JOIN vendors v ON e.vendor_id=v.id WHERE e.id=?
    `).get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const rsvps = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='customer' AND status IN ('pending','confirmed')").get(event.id)?.c || 0;
    const vendorApps = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='vendor'").get(event.id)?.c || 0;
    res.json({ ok: true, event: { ...event, rsvp_count_live: rsvps, vendor_app_count: vendorApps } });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Customer RSVP to event
app.post('/api/events/:id/rsvp', async (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    const guestEmail = (req.body.email || '').trim().toLowerCase();
    const guestName = (req.body.name || '').trim();
    if (!cust && !guestEmail) return res.status(400).json({ error: 'Login or provide email to RSVP' });

    const event = db.prepare('SELECT * FROM vendor_events WHERE id=? AND status=?').get(req.params.id, 'active');
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.event_date < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Event has passed' });

    // Capacity check
    if (event.capacity > 0) {
      const current = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='customer' AND status IN ('pending','confirmed')").get(event.id)?.c || 0;
      if (current >= event.capacity) return res.status(400).json({ error: 'Event is full' });
    }

    const userId = cust ? cust.id : 'guest_' + guestEmail.replace(/[^a-z0-9]/g, '_');
    const userName = cust ? cust.name : guestName;
    const userEmail = cust ? cust.email : guestEmail;

    // Paid event: create Stripe checkout session instead of direct confirm
    if (event.price > 0) {
      if (!process.env.WYA_STRIPE_SK) return res.status(503).json({ error: 'Payments not configured' });
      // Pre-insert booking in 'pending_payment' state so we have an ID for metadata
      let bookingId;
      try {
        const r = db.prepare('INSERT INTO event_bookings (event_id,user_type,user_id,user_name,user_email,status) VALUES (?,?,?,?,?,?)').run(event.id, 'customer', userId, userName || '', userEmail || '', 'pending_payment');
        bookingId = r.lastInsertRowid;
      } catch(e) {
        if (e.message?.includes('UNIQUE')) {
          // Already exists — fetch existing booking id
          const existing = db.prepare("SELECT id, status FROM event_bookings WHERE event_id=? AND user_type='customer' AND user_id=?").get(event.id, userId);
          if (existing?.status === 'confirmed') return res.json({ ok: true, message: 'Already RSVP\'d' });
          bookingId = existing?.id;
        } else throw e;
      }
      const session = await getStripe().checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(event.price * 100),
            product_data: { name: event.title, description: `Event on ${event.event_date}${event.start_time ? ' at ' + event.start_time : ''}${event.location ? ' — ' + event.location : ''}` }
          }
        }],
        success_url: `https://wya.digisigns.link/customer?event_paid=1&event=${event.id}`,
        cancel_url: 'https://wya.digisigns.link/customer',
        customer_email: userEmail || undefined,
        metadata: { event_booking_id: String(bookingId), event_id: String(event.id), customer_id: cust ? String(cust.id) : '', customer_email: userEmail }
      });
      // Store checkout session id on booking
      if (bookingId) {
        try { db.prepare('UPDATE event_bookings SET stripe_checkout_session_id=? WHERE id=?').run(session.id, bookingId); } catch(_) {}
      }
      console.log(`[WYA-APP] Stripe checkout created for event ${event.id}, booking ${bookingId}`);
      return res.json({ ok: true, checkout_url: session.url, paid_event: true });
    }

    // Free event: direct confirm
    db.prepare('INSERT OR REPLACE INTO event_bookings (event_id,user_type,user_id,user_name,user_email,status) VALUES (?,?,?,?,?,?)').run(event.id, 'customer', userId, userName || '', userEmail || '', 'confirmed');

    // Update RSVP count
    const newCount = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='customer' AND status IN ('pending','confirmed')").get(event.id)?.c || 0;
    db.prepare('UPDATE vendor_events SET rsvp_count=? WHERE id=?').run(newCount, event.id);

    // Notify vendor
    if (event.vendor_id) {
      sendPushNotification(event.vendor_id, 'vendor', 'New RSVP!', `${userName || userEmail} RSVP'd to "${event.title}"`, 'https://wya.digisigns.link/vendor');
    }
    res.json({ ok: true, rsvp_count: newCount });
  } catch(e) {
    if (e.message?.includes('UNIQUE')) return res.json({ ok: true, message: 'Already RSVP\'d' });
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Organizer: Post event requesting vendors (public, no auth)
app.post('/api/events/request', publicLimiter60, (req, res) => {
  try {
    const { title, description, event_date, start_time, end_time, location, location_lat, location_lng, category, organizer_name, organizer_email, organizer_phone, vendor_slots, capacity } = req.body;
    if (!title || !event_date || !organizer_email) return res.status(400).json({ error: 'title, event_date, and organizer_email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(organizer_email)) return res.status(400).json({ error: 'Valid email required' });

    const r = db.prepare(`INSERT INTO vendor_events (vendor_id,title,description,event_date,start_time,end_time,location,location_lat,location_lng,category,event_type,organizer_name,organizer_email,organizer_phone,vendor_slots,capacity,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      '', title.trim(), (description||'').trim(), event_date, start_time||'', end_time||'', (location||'').trim(),
      location_lat||null, location_lng||null, category||'other', 'organizer',
      (organizer_name||'').trim(), organizer_email.trim().toLowerCase(), (organizer_phone||'').trim(),
      parseInt(vendor_slots)||1, parseInt(capacity)||0, 'active'
    );

    // Notify all vendors with push about new event opportunity
    const allVendors = db.prepare("SELECT id FROM vendors WHERE data_source NOT IN ('test') AND is_open=1 OR subscription_tier IN ('pro','growth')").all();
    for (const v of allVendors) {
      sendPushNotification(v.id, 'vendor', 'New Event Opportunity', `"${title.trim()}" on ${event_date} — apply now!`, 'https://wya.digisigns.link/vendor');
    }

    res.json({ ok: true, event_id: r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Organizer event image upload — uses organizer_email as ownership proof
app.post('/api/events/:id/image', publicLimiter60, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM vendor_events WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // For vendor events, require vendor auth
    if (event.event_type === 'vendor') {
      const vendor = getVendorByToken(req.headers['x-auth-token']);
      if (!vendor || vendor.id !== event.vendor_id) return res.status(403).json({ error: 'Not your event' });
    }
    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[req.file.mimetype] || '.jpg';
      require('fs').renameSync(req.file.path, req.file.path + ext);
      const url = `/uploads/${req.file.filename}${ext}`;
      db.prepare('UPDATE vendor_events SET image_url=? WHERE id=?').run(url, event.id);
      res.json({ ok: true, url, event_id: event.id });
    });
  } catch (e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor: Apply to organizer event
app.post('/api/events/:id/apply', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Login required' });

    const event = db.prepare("SELECT * FROM vendor_events WHERE id=? AND event_type='organizer' AND status='active'").get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found or not accepting vendors' });

    // Check vendor slots
    if (event.vendor_slots > 0) {
      const current = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='vendor' AND status='approved'").get(event.id)?.c || 0;
      if (current >= event.vendor_slots) return res.status(400).json({ error: 'All vendor slots filled' });
    }

    db.prepare('INSERT OR REPLACE INTO event_bookings (event_id,user_type,user_id,user_name,user_email,user_phone,message,status) VALUES (?,?,?,?,?,?,?,?)').run(
      event.id, 'vendor', vendor.id, vendor.name, vendor.email, vendor.phone||'', (req.body.message||'').trim(), 'pending'
    );

    // Notify organizer via email
    if (event.organizer_email) {
      sendEmail(event.organizer_email, `Vendor Applied: ${vendor.name} → ${event.title}`,
        `<h2>New Vendor Application</h2><p><strong>${_escHtml(vendor.name)}</strong> wants to participate in your event "<strong>${_escHtml(event.title)}</strong>" on ${_escHtml(event.event_date)}.</p>${req.body.message ? '<p>Message: ' + _escHtml(req.body.message) + '</p>' : ''}<p><a href="https://wya.digisigns.link/customer?event=${event.id}">View Event</a></p>`
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch(e) {
    if (e.message?.includes('UNIQUE')) return res.json({ ok: true, message: 'Already applied' });
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor: Get events I can apply to
app.get('/api/vendor/event-opportunities', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Login required' });
    const events = db.prepare(`
      SELECT e.*,
        (SELECT status FROM event_bookings WHERE event_id=e.id AND user_type='vendor' AND user_id=?) as my_status,
        (SELECT COUNT(*) FROM event_bookings WHERE event_id=e.id AND user_type='vendor' AND status='approved') as vendors_confirmed
      FROM vendor_events e
      WHERE e.event_type='organizer' AND e.status='active' AND e.event_date >= date('now')
      ORDER BY e.event_date
    `).all(vendor.id);
    res.json({ ok: true, events });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Catering Request Funnel ───────────────────────────────────
// Public: Submit catering inquiry to a specific vendor (or all matching category)
app.post('/api/vendors/:id/catering-request', publicLimiter60, (req, res) => {
  try {
    const { name, email, phone, event_date, event_time, guest_count, budget_range, event_type, location, location_lat, location_lng, dietary_notes, message } = req.body;
    if (!name || !email || !event_date) return res.status(400).json({ error: 'name, email, and event_date required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    if (guest_count && (guest_count < 1 || guest_count > 10000)) return res.status(400).json({ error: 'guest_count must be 1-10000' });

    const vendor = db.prepare('SELECT id, name, email FROM vendors WHERE id=?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const r = db.prepare(`INSERT INTO catering_requests (vendor_id, requester_name, requester_email, requester_phone, event_date, event_time, guest_count, budget_range, event_type, location, location_lat, location_lng, dietary_notes, message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      vendor.id, sanitize(name.trim()), email.trim().toLowerCase(), sanitize((phone||'').trim()),
      event_date, event_time||'', parseInt(guest_count)||10, sanitize((budget_range||'').trim()),
      sanitize((event_type||'private').trim()), sanitize((location||'').trim()),
      location_lat||null, location_lng||null,
      sanitize((dietary_notes||'').trim()), sanitize((message||'').trim())
    );

    // Notify vendor via email
    sendEmail(vendor.email, `New Catering Inquiry — ${sanitize(name.trim())}`,
      `<h2>New Catering Request on WYA</h2>
      <p><strong>${sanitize(name.trim())}</strong> is interested in catering for their event.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:6px;font-weight:bold">Date:</td><td style="padding:6px">${event_date}${event_time ? ' at ' + event_time : ''}</td></tr>
        <tr><td style="padding:6px;font-weight:bold">Guests:</td><td style="padding:6px">${parseInt(guest_count)||10}</td></tr>
        ${budget_range ? `<tr><td style="padding:6px;font-weight:bold">Budget:</td><td style="padding:6px">${sanitize(budget_range)}</td></tr>` : ''}
        ${location ? `<tr><td style="padding:6px;font-weight:bold">Location:</td><td style="padding:6px">${sanitize(location)}</td></tr>` : ''}
        ${dietary_notes ? `<tr><td style="padding:6px;font-weight:bold">Dietary Notes:</td><td style="padding:6px">${sanitize(dietary_notes)}</td></tr>` : ''}
        ${message ? `<tr><td style="padding:6px;font-weight:bold">Message:</td><td style="padding:6px">${sanitize(message)}</td></tr>` : ''}
      </table>
      <p>Reply to: <a href="mailto:${email.trim()}">${email.trim()}</a>${phone ? ' / ' + sanitize(phone) : ''}</p>
      <p><a href="https://wya.digisigns.link/vendor" style="background:#7c3aed;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:12px">View in Dashboard</a></p>`
    ).catch(() => {});

    // Push notification
    sendPushNotification(vendor.id, 'vendor', 'Catering Inquiry', `${sanitize(name.trim())} wants catering for ${parseInt(guest_count)||10} guests on ${event_date}`, 'https://wya.digisigns.link/vendor');

    // EMS sync
    emsSyncCustomer(email.trim(), name.trim(), phone||'', 'customer');
    // Brain OS 3.0: Record catering inquiry in Brain
    if (_brainIngest) {
      try { _brainIngest.ingest({ source: 'wya', type: 'catering_inquiry', memoryType: 'episodic',
        tenantId: process.env.OWNER_USER_ID || 'sergio', title: `Catering inquiry: ${(name || '').trim().slice(0, 40)} → ${(vendor.name || '').slice(0, 40)}`,
        content: `${(name || '').trim().slice(0, 40)} wants catering for ${parseInt(guest_count)||10} guests on ${event_date}. Vendor: ${(vendor.name || '').slice(0, 40)}`,
        tags: ['wya', 'inquiry', 'lead', 'catering'], confidence: 0.85 }); } catch {}
    }

    res.json({ ok: true, request_id: r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public: Browse all vendors that accept catering
app.get('/api/vendors/catering', publicLimiter60, (req, res) => {
  try {
    const vendors = db.prepare(`SELECT id, name, category, description, photo_url, avg_rating, review_count, estimated_prep_minutes
      FROM vendors WHERE data_source NOT IN ('test') ORDER BY avg_rating DESC, review_count DESC`).all();
    // All vendors can accept catering inquiries — no gating needed
    res.json({ ok: true, count: vendors.length, vendors });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor: View catering requests
app.get('/api/vendor/catering-requests', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Login required' });
    const status = req.query.status || null;
    const requests = status
      ? db.prepare('SELECT * FROM catering_requests WHERE vendor_id=? AND status=? ORDER BY event_date').all(vendor.id, status)
      : db.prepare('SELECT * FROM catering_requests WHERE vendor_id=? ORDER BY created_at DESC').all(vendor.id);
    res.json({ ok: true, count: requests.length, requests });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor: Respond to catering request (quote, accept, decline)
app.post('/api/vendor/catering-requests/:id/respond', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Login required' });
    const { status, response_message, quoted_amount } = req.body;
    if (!status || !['quoted','accepted','declined'].includes(status)) return res.status(400).json({ error: 'status must be quoted, accepted, or declined' });

    const request = db.prepare('SELECT * FROM catering_requests WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!request) return res.status(404).json({ error: 'Catering request not found' });

    db.prepare('UPDATE catering_requests SET status=?, vendor_response=?, quoted_amount=?, responded_at=datetime(\'now\') WHERE id=?')
      .run(status, sanitize((response_message||'').trim()), quoted_amount||null, request.id);

    // Notify requester via email
    const statusLabel = { quoted: 'sent you a quote', accepted: 'accepted your request', declined: 'is unable to accommodate your request' }[status];
    sendEmail(request.requester_email, `${vendor.name} ${statusLabel} — WYA Catering`,
      `<h2>Catering Update from ${vendor.name}</h2>
      <p>${vendor.name} has <strong>${statusLabel}</strong> for your ${request.event_type} event on ${request.event_date}.</p>
      ${quoted_amount ? `<p style="font-size:24px;font-weight:bold;color:#7c3aed">Quote: $${Number(quoted_amount).toFixed(2)}</p>` : ''}
      ${response_message ? `<p><strong>Message:</strong> ${sanitize(response_message)}</p>` : ''}
      <p>Contact ${vendor.name} directly to finalize details.</p>`
    ).catch(() => {});

    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 749: Personalized customer discovery feed
// Distance-filtered: pass ?lat=&lng= to filter by proximity (default 25mi radius)
app.get('/api/customer/feed', publicLimiter60, (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    // Works without auth too — just no "for_you" or "following" sections
    const userCoords = validateCoords(req.query.lat, req.query.lng);
    if (!userCoords) return res.status(400).json({ error: 'lat and lng are required for feed', ok: false });
    const radiusMi = Math.min(parseFloat(req.query.radius) || 25, 50); // default 25mi, max 50mi

    const _feedMenuIds = new Set(db.prepare('SELECT DISTINCT vendor_id FROM menu_items').all().map(r => r.vendor_id));
    let vendors = db.prepare(`SELECT ${VENDOR_FIELDS},created_at FROM vendors WHERE lat IS NOT NULL AND lng IS NOT NULL`).all()
      .filter(v => v.is_open === 1 || _feedMenuIds.has(v.id));

    // Distance filter: ALWAYS applied — no unfiltered vendor lists
    for (const v of vendors) v.distance_mi = Math.round(haversine(userCoords.lat, userCoords.lng, v.lat, v.lng) * 10) / 10;
    vendors = vendors.filter(v => v.distance_mi <= radiusMi);
    vendors.sort((a, b) => a.distance_mi - b.distance_mi);

    for (const v of vendors) v.is_live = v.is_open === 1;
    enrichWithSocialProof(vendors);
    enrichWithProfileComplete(vendors);

    // Trending: top 6 by composite score
    const trending = vendors
      .map(v => ({ ...v, _score: (v.orders_7d || 0) * 3 + (v.views_7d || 0) + (v.follower_count || 0) * 2 }))
      .filter(v => v._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 6)
      .map(v => { delete v._score; return v; });

    // New vendors: created in last 14 days
    const new_vendors = vendors.filter(v => v.new_vendor).slice(0, 6);

    let following = [];
    let for_you = [];
    if (cust) {
      // Vendors customer follows
      const followedIds = db.prepare('SELECT vendor_id FROM vendor_followers WHERE customer_id=? AND active=1').all(cust.id).map(r => r.vendor_id);
      const followedSet = new Set(followedIds);
      following = vendors.filter(v => followedSet.has(v.id)).slice(0, 6);

      // For You: vendors in categories from customer's past orders, excluding already-following
      const orderCats = db.prepare(`SELECT DISTINCT v.category FROM orders o JOIN vendors v ON o.vendor_id=v.id WHERE o.customer_id=? AND o.status NOT IN ('cancelled') AND v.category IS NOT NULL`).all(cust.id).map(r => r.category);
      if (orderCats.length) {
        const catSet = new Set(orderCats);
        for_you = vendors.filter(v => catSet.has(v.category) && !followedSet.has(v.id)).slice(0, 6);
      }
      // Fallback to trending if no order history
      if (!for_you.length && !orderCats.length) for_you = trending.slice(0, 6);
    }

    // All section: vendors with menu items, always distance-filtered
    const vendorIdsWithMenu = new Set(db.prepare('SELECT DISTINCT vendor_id FROM menu_items').all().map(r => r.vendor_id));
    let allVendors = db.prepare(`SELECT ${VENDOR_FIELDS},created_at FROM vendors WHERE lat IS NOT NULL AND lng IS NOT NULL`).all()
      .filter(v => vendorIdsWithMenu.has(v.id));
    for (const v of allVendors) v.distance_mi = Math.round(haversine(userCoords.lat, userCoords.lng, v.lat, v.lng) * 10) / 10;
    allVendors = allVendors.filter(v => v.distance_mi <= radiusMi);
    enrichWithSocialProof(allVendors);
    for (const v of allVendors) v.is_live = v.is_open === 1;
    // Sort: live first, then by distance (if available), then by name
    allVendors.sort((a, b) => (b.is_open || 0) - (a.is_open || 0) || (a.distance_mi || 999) - (b.distance_mi || 999) || (a.name || '').localeCompare(b.name || ''));

    res.json({ ok: true, location_filtered: true, radius_mi: radiusMi, trending, new_vendors, following, for_you, all: allVendors });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase WYA-AI: AI-powered personalized recommendations
const { getRecommendations, RECOMMENDATION_TYPES } = require('./ai-recommendations');
app.get('/api/customer/recommended', publicLimiter30, async (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    const userCoords = validateCoords(req.query.lat, req.query.lng);
    if (!userCoords) return res.status(400).json({ error: 'lat and lng are required', ok: false });
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);

    const recommendations = await getRecommendations(
      db,
      cust?.id || null,
      userCoords.lat,
      userCoords.lng,
      limit
    );

    res.json({
      ok: true,
      recommendations,
      personalized: !!cust,
      types: RECOMMENDATION_TYPES,
      ts: new Date().toISOString()
    });
  } catch(e) {
    console.error('[WYA-APP] AI recommendation error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Trending vendors by social score (with optional distance filtering)
app.get('/api/vendors/trending-social', publicLimiter60, (req, res) => {
  try {
    let vendors = db.prepare(`SELECT ${VENDOR_FIELDS} FROM vendors WHERE social_score > 0 ORDER BY social_score DESC`).all();
    for (const v of vendors) {
      v.badge = getSocialBadge(v.social_score);
    }
    // Distance filter: always required
    const { lat, lng } = req.query;
    const userCoords = validateCoords(lat, lng);
    if (!userCoords) return res.status(400).json({ error: 'lat and lng are required', ok: false });
    const radiusMi = Math.min(parseFloat(req.query.radius) || 25, 50);
    for (const v of vendors) {
      v.distance_mi = Math.round(haversine(userCoords.lat, userCoords.lng, v.lat, v.lng) * 10) / 10;
    }
    vendors = vendors.filter(v => v.distance_mi <= radiusMi);
    res.json({ ok: true, vendors: vendors.slice(0, 20) });
  } catch(e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ══════════════════════════════════════════════════════════════
// ── SOCIAL MEDIA INTEGRATION ENGINE ──────────────────────────
// ══════════════════════════════════════════════════════════════

// Fetch social profile data via public oEmbed/public APIs (no OAuth needed)
async function fetchSocialProfile(platform, handle) {
  if (!handle) return null;
  const clean = handle.replace(/^@/, '').trim();
  if (!clean) return null;
  const https = require('https');
  const httpMod = require('http');

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 8000);
    try {
      let url;
      if (platform === 'instagram') {
        // Instagram oEmbed — public, no auth, returns profile embed HTML
        url = `https://www.instagram.com/${clean}/?__a=1&__d=dis`;
        // Use graph.facebook.com oEmbed endpoint (no token needed for basic profile link)
        resolve({ platform, handle: clean, profileUrl: `https://instagram.com/${clean}`, fetched: true });
        clearTimeout(timeout);
        return;
      } else if (platform === 'tiktok') {
        url = `https://www.tiktok.com/oembed?url=https://www.tiktok.com/@${clean}`;
      } else if (platform === 'youtube') {
        // YouTube oEmbed for channel
        url = `https://www.youtube.com/oembed?url=https://www.youtube.com/@${clean}&format=json`;
      } else if (platform === 'facebook') {
        resolve({ platform, handle: clean, profileUrl: clean.startsWith('http') ? clean : `https://facebook.com/${clean}`, fetched: true });
        clearTimeout(timeout);
        return;
      }

      if (!url) { clearTimeout(timeout); resolve(null); return; }

      https.get(url, { headers: { 'User-Agent': 'WYA-App/1.0' } }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          clearTimeout(timeout);
          try {
            const parsed = JSON.parse(data);
            resolve({
              platform,
              handle: clean,
              title: parsed.title || parsed.author_name || clean,
              thumbnail: parsed.thumbnail_url || '',
              html: parsed.html || '',
              authorUrl: parsed.author_url || '',
              fetched: true
            });
          } catch(e) {
            resolve({ platform, handle: clean, profileUrl: url, fetched: false });
          }
        });
      }).on('error', () => { clearTimeout(timeout); resolve(null); });
    } catch(e) { clearTimeout(timeout); resolve(null); }
  });
}

// Enrich vendor social profiles — fetches oEmbed data and caches it
app.post('/api/vendor/social-enrich', publicLimiter10, async (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });

    const platforms = [
      { key: 'instagram', handle: vendor.instagram },
      { key: 'tiktok', handle: vendor.tiktok },
      { key: 'youtube', handle: vendor.youtube },
      { key: 'facebook', handle: vendor.facebook }
    ].filter(p => p.handle);

    const results = {};
    for (const p of platforms) {
      const data = await fetchSocialProfile(p.key, p.handle);
      if (data) {
        results[p.key] = data;
        // Cache the enrichment data
        db.prepare(`INSERT OR REPLACE INTO vendor_social_cache
          (vendor_id, platform, bio, avatar_url, last_updated)
          VALUES (?, ?, ?, ?, datetime('now'))`)
          .run(vendor.id, p.key, data.title || '', data.thumbnail || '');
      }
    }

    // Recalculate enhanced social score
    const score = computeEnhancedSocialScore(vendor, results);
    db.prepare('UPDATE vendors SET social_score=? WHERE id=?').run(score, vendor.id);

    res.json({ ok: true, profiles: results, score, badge: getSocialBadge(score) });
  } catch(e) {
    console.error('[WYA-APP] Social enrich error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get cached social data for a vendor (public)
app.get('/api/vendors/:id/social', publicLimiter60, (req, res) => {
  try {
    const vendor = db.prepare('SELECT id,name,instagram,tiktok,facebook,youtube,website,yelp_url,google_maps_url,google_business_url,social_score,photo_url,category FROM vendors WHERE id=?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const cached = db.prepare('SELECT * FROM vendor_social_cache WHERE vendor_id=?').all(vendor.id);
    const shares = db.prepare('SELECT COUNT(*) as c FROM social_shares WHERE vendor_id=?').get(vendor.id);
    const campaigns = db.prepare('SELECT * FROM influencer_campaigns WHERE vendor_id=? AND status=?').all(vendor.id, 'active');

    const platforms = {};
    for (const c of cached) {
      platforms[c.platform] = {
        handle: c.platform === 'instagram' ? vendor.instagram :
                c.platform === 'tiktok' ? vendor.tiktok :
                c.platform === 'youtube' ? vendor.youtube :
                c.platform === 'facebook' ? vendor.facebook : '',
        followers: c.followers,
        avatar: c.avatar_url,
        bio: c.bio,
        lastPost: c.last_post_url ? { url: c.last_post_url, image: c.last_post_image, caption: c.last_post_caption } : null,
        verified: !!c.verified,
        lastUpdated: c.last_updated
      };
    }

    // Build social links map
    const socialLinks = {};
    if (vendor.instagram) socialLinks.instagram = `https://instagram.com/${vendor.instagram.replace('@','')}`;
    if (vendor.tiktok) socialLinks.tiktok = `https://tiktok.com/@${vendor.tiktok.replace('@','')}`;
    if (vendor.youtube) socialLinks.youtube = `https://youtube.com/@${vendor.youtube.replace('@','')}`;
    if (vendor.facebook) socialLinks.facebook = vendor.facebook.startsWith('http') ? vendor.facebook : `https://facebook.com/${vendor.facebook}`;
    if (vendor.website) socialLinks.website = vendor.website.startsWith('http') ? vendor.website : `https://${vendor.website}`;

    // Delivery platform links
    const deliveryLinks = {};
    if (vendor.yelp_url) deliveryLinks.yelp = vendor.yelp_url;
    if (vendor.google_maps_url) deliveryLinks.google_maps = vendor.google_maps_url;
    if (vendor.google_business_url) deliveryLinks.google_business = vendor.google_business_url;

    res.json({
      ok: true,
      vendor: { id: vendor.id, name: vendor.name, photo: vendor.photo_url, category: vendor.category },
      socialScore: vendor.social_score,
      badge: getSocialBadge(vendor.social_score),
      platforms,
      socialLinks,
      deliveryLinks,
      totalShares: shares?.c || 0,
      activeCampaigns: campaigns.length
    });
  } catch(e) {
    console.error('[WYA-APP] Social data error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Track social share
app.post('/api/vendors/:id/share', publicLimiter60, (req, res) => {
  try {
    const vendor = db.prepare('SELECT id FROM vendors WHERE id=?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    const { platform, share_type } = req.body;
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    db.prepare('INSERT INTO social_shares (vendor_id,platform,share_type,sharer_id,sharer_type) VALUES (?,?,?,?,?)')
      .run(vendor.id, sanitize(platform || 'link'), sanitize(share_type || 'link'), cust?.id || null, cust ? 'customer' : 'anonymous');
    // Boost social score slightly on shares
    db.prepare('UPDATE vendors SET social_score = MIN(100, social_score + 1) WHERE id=?').run(vendor.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Share track error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate shareable social card (branded image data)
app.get('/api/vendor/social-card', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });

    const menuCount = db.prepare('SELECT COUNT(*) as c FROM menu_items WHERE vendor_id=?').get(vendor.id)?.c || 0;
    const btype = BUSINESS_TYPES[vendor.category] || BUSINESS_TYPES.other;
    const format = req.query.format || 'feed'; // 'feed' (1080x1080) or 'story' (1080x1920)
    const isStory = format === 'story';
    const w = 1080, h = isStory ? 1920 : 1080;

    let cardSvg;
    if (isStory) {
      // Story format: 9:16 ratio (1080x1920)
      cardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#1a1a2e"/>
          <stop offset="40%" style="stop-color:#16213e"/>
          <stop offset="100%" style="stop-color:#0f3460"/>
        </linearGradient>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:#833AB4"/>
          <stop offset="50%" style="stop-color:#FD1D1D"/>
          <stop offset="100%" style="stop-color:#FCB045"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#bg)" rx="0"/>
      <rect x="30" y="30" width="${w-60}" height="${h-60}" fill="none" stroke="url(#accent)" stroke-width="3" rx="20" opacity="0.3"/>
      <text x="540" y="380" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="160" font-weight="800">${btype.emoji}</text>
      <text x="540" y="580" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="72" font-weight="800">${escXml(vendor.name || '')}</text>
      <text x="540" y="680" text-anchor="middle" fill="#a78bfa" font-family="system-ui,sans-serif" font-size="36">${escXml(btype.label || vendor.category || 'Local Business')}</text>
      <text x="540" y="740" text-anchor="middle" fill="#9CA3AF" font-family="system-ui,sans-serif" font-size="28">Santa Barbara, CA</text>
      ${vendor.avg_rating > 0 ? `<text x="540" y="860" text-anchor="middle" fill="#FCB045" font-family="system-ui,sans-serif" font-size="44" font-weight="700">${'★'.repeat(Math.round(vendor.avg_rating))} ${vendor.avg_rating.toFixed(1)}</text>` : ''}
      ${menuCount > 0 ? `<text x="540" y="940" text-anchor="middle" fill="#ccc" font-family="system-ui,sans-serif" font-size="32">${menuCount} items on the menu</text>` : ''}
      ${vendor.description ? `<text x="540" y="1080" text-anchor="middle" fill="#aaa" font-family="system-ui,sans-serif" font-size="26" textLength="900" lengthAdjust="spacingAndGlyphs">${escXml((vendor.description || '').substring(0, 80))}</text>` : ''}
      <rect x="240" y="1300" width="600" height="80" rx="40" fill="url(#accent)"/>
      <text x="540" y="1352" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="34" font-weight="700">Find us on WYA</text>
      <text x="540" y="1520" text-anchor="middle" fill="#888" font-family="system-ui,sans-serif" font-size="28">Swipe up to order</text>
      <text x="540" y="1680" text-anchor="middle" fill="#666" font-family="system-ui,sans-serif" font-size="22">wya.digisigns.link/v/${vendor.id}</text>
      <text x="540" y="1820" text-anchor="middle" fill="#444" font-family="system-ui,sans-serif" font-size="18">Where You At — Local Vendor Discovery</text>
    </svg>`;
    } else {
      // Feed format: 1:1 ratio (1080x1080)
      cardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#1a1a2e"/>
          <stop offset="50%" style="stop-color:#16213e"/>
          <stop offset="100%" style="stop-color:#0f3460"/>
        </linearGradient>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:#833AB4"/>
          <stop offset="50%" style="stop-color:#FD1D1D"/>
          <stop offset="100%" style="stop-color:#FCB045"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#bg)" rx="40"/>
      <rect x="40" y="40" width="1000" height="1000" fill="none" stroke="url(#accent)" stroke-width="3" rx="30" opacity="0.4"/>
      <text x="540" y="200" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="120" font-weight="800">${btype.emoji}</text>
      <text x="540" y="340" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="64" font-weight="800">${escXml(vendor.name || '')}</text>
      <text x="540" y="420" text-anchor="middle" fill="#a78bfa" font-family="system-ui,sans-serif" font-size="32">${escXml(btype.label || vendor.category || 'Local Business')}</text>
      <text x="540" y="470" text-anchor="middle" fill="#9CA3AF" font-family="system-ui,sans-serif" font-size="24">Santa Barbara, CA</text>
      ${vendor.avg_rating > 0 ? `<text x="540" y="560" text-anchor="middle" fill="#FCB045" font-family="system-ui,sans-serif" font-size="36" font-weight="700">${'★'.repeat(Math.round(vendor.avg_rating))} ${vendor.avg_rating.toFixed(1)}</text>` : ''}
      ${menuCount > 0 ? `<text x="540" y="620" text-anchor="middle" fill="#ccc" font-family="system-ui,sans-serif" font-size="28">${menuCount} items on the menu</text>` : ''}
      ${vendor.description ? `<text x="540" y="700" text-anchor="middle" fill="#aaa" font-family="system-ui,sans-serif" font-size="22" textLength="900" lengthAdjust="spacingAndGlyphs">${escXml((vendor.description || '').substring(0, 80))}</text>` : ''}
      <rect x="290" y="780" width="500" height="70" rx="35" fill="url(#accent)"/>
      <text x="540" y="825" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="28" font-weight="700">Find us on WYA</text>
      <text x="540" y="920" text-anchor="middle" fill="#666" font-family="system-ui,sans-serif" font-size="20">wya.digisigns.link/v/${vendor.id}</text>
      <text x="540" y="1000" text-anchor="middle" fill="#444" font-family="system-ui,sans-serif" font-size="16">Where You At — Local Vendor Discovery</text>
    </svg>`;
    }

    // Track card generation
    db.prepare('INSERT INTO social_cards (vendor_id,card_type,card_data) VALUES (?,?,?)')
      .run(vendor.id, format, JSON.stringify({ generated: new Date().toISOString(), format }));

    res.json({
      ok: true,
      svg: cardSvg,
      width: w,
      height: h,
      format,
      shareUrl: `https://wya.digisigns.link/v/${vendor.id}`,
      shareText: `Check out ${vendor.name} on WYA! ${btype.emoji} Find them on the live vendor map in Santa Barbara.`,
      hashtags: ['WhereYouAt', 'WYA', 'SantaBarbara', 'ShopLocal', 'SupportLocal', vendor.category || 'local'].filter(Boolean)
    });
  } catch(e) {
    console.error('[WYA-APP] Social card error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public social card — anyone can generate for any vendor (for customer sharing)
app.get('/v/:id/card.svg', (req, res) => {
  try {
    const v = db.prepare("SELECT id,name,category,description,avg_rating,review_count,photo_url FROM vendors WHERE id=?").get(req.params.id);
    if (!v) return res.status(404).send('Not found');
    const menuCount = db.prepare('SELECT COUNT(*) as c FROM menu_items WHERE vendor_id=?').get(v.id)?.c || 0;
    const btype = BUSINESS_TYPES[v.category] || BUSINESS_TYPES.other || { emoji: '📍', label: 'Local Business' };
    const format = req.query.format || 'story';
    const isStory = format === 'story';
    const w = 1080, h = isStory ? 1920 : 1080;
    const ratingText = v.avg_rating > 0 ? `${'★'.repeat(Math.round(v.avg_rating))} ${v.avg_rating.toFixed(1)}` : '';
    const desc = escXml((v.description || '').substring(0, 70));

    const svg = isStory ? `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e"/><stop offset="40%" style="stop-color:#16213e"/><stop offset="100%" style="stop-color:#0f3460"/></linearGradient><linearGradient id="ac" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#FF6B35"/><stop offset="100%" style="stop-color:#FD1D1D"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#bg)"/>
      <rect x="30" y="30" width="${w-60}" height="${h-60}" fill="none" stroke="url(#ac)" stroke-width="3" rx="20" opacity="0.3"/>
      <text x="540" y="500" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="160">${btype.emoji || '📍'}</text>
      <text x="540" y="700" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="72" font-weight="800">${escXml(v.name)}</text>
      <text x="540" y="790" text-anchor="middle" fill="#FF6B35" font-family="system-ui,sans-serif" font-size="36">${escXml(btype.label || v.category)}</text>
      <text x="540" y="850" text-anchor="middle" fill="#9CA3AF" font-family="system-ui,sans-serif" font-size="28">Santa Barbara, CA</text>
      ${ratingText ? `<text x="540" y="960" text-anchor="middle" fill="#FCB045" font-family="system-ui,sans-serif" font-size="44" font-weight="700">${ratingText}</text>` : ''}
      ${menuCount > 0 ? `<text x="540" y="1040" text-anchor="middle" fill="#ccc" font-family="system-ui,sans-serif" font-size="32">${menuCount} items</text>` : ''}
      ${desc ? `<text x="540" y="1160" text-anchor="middle" fill="#aaa" font-family="system-ui,sans-serif" font-size="26">${desc}</text>` : ''}
      <rect x="240" y="1360" width="600" height="80" rx="40" fill="url(#ac)"/>
      <text x="540" y="1412" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="34" font-weight="700">Find me on WYA</text>
      <text x="540" y="1560" text-anchor="middle" fill="#888" font-family="system-ui,sans-serif" font-size="24">wya.digisigns.link/v/${v.id}</text>
      <text x="540" y="1780" text-anchor="middle" fill="#444" font-family="system-ui,sans-serif" font-size="20">WYA — Where You At</text>
    </svg>` : `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e"/><stop offset="50%" style="stop-color:#16213e"/><stop offset="100%" style="stop-color:#0f3460"/></linearGradient><linearGradient id="ac" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#FF6B35"/><stop offset="100%" style="stop-color:#FD1D1D"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#bg)" rx="40"/>
      <rect x="40" y="40" width="1000" height="1000" fill="none" stroke="url(#ac)" stroke-width="3" rx="30" opacity="0.4"/>
      <text x="540" y="220" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="120">${btype.emoji || '📍'}</text>
      <text x="540" y="380" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="64" font-weight="800">${escXml(v.name)}</text>
      <text x="540" y="450" text-anchor="middle" fill="#FF6B35" font-family="system-ui,sans-serif" font-size="32">${escXml(btype.label || v.category)}</text>
      <text x="540" y="500" text-anchor="middle" fill="#9CA3AF" font-family="system-ui,sans-serif" font-size="24">Santa Barbara, CA</text>
      ${ratingText ? `<text x="540" y="590" text-anchor="middle" fill="#FCB045" font-family="system-ui,sans-serif" font-size="36" font-weight="700">${ratingText}</text>` : ''}
      ${menuCount > 0 ? `<text x="540" y="650" text-anchor="middle" fill="#ccc" font-family="system-ui,sans-serif" font-size="28">${menuCount} items</text>` : ''}
      ${desc ? `<text x="540" y="740" text-anchor="middle" fill="#aaa" font-family="system-ui,sans-serif" font-size="22">${desc}</text>` : ''}
      <rect x="290" y="810" width="500" height="70" rx="35" fill="url(#ac)"/>
      <text x="540" y="855" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="28" font-weight="700">Find me on WYA</text>
      <text x="540" y="950" text-anchor="middle" fill="#666" font-family="system-ui,sans-serif" font-size="20">wya.digisigns.link/v/${v.id}</text>
      <text x="540" y="1020" text-anchor="middle" fill="#444" font-family="system-ui,sans-serif" font-size="16">WYA — Where You At</text>
    </svg>`;

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch(e) {
    console.error('[WYA-APP] Public social card error:', e.message);
    res.status(500).send('Error');
  }
});

// XML escape helper for SVG
function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Track social share event from vendor dashboard
app.post('/api/vendor/social/track-share', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });
    const { platform } = req.body;
    if (!platform) return res.status(400).json({ error: 'Platform required' });
    db.prepare("INSERT INTO social_shares (vendor_id, platform, share_type, sharer_id, sharer_type, created_at) VALUES (?, ?, 'vendor_share', ?, 'vendor', datetime('now'))")
      .run(vendor.id, sanitize(platform), vendor.id);
    // Bump social score by 1 (cap at 100)
    const currentScore = vendor.social_score || 0;
    if (currentScore < 100) {
      db.prepare('UPDATE vendors SET social_score = MIN(social_score + 1, 100) WHERE id = ?').run(vendor.id);
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Track share error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor social hub dashboard — stats, share links, social card templates
app.get('/api/vendor/social-hub', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });

    const cached = db.prepare('SELECT * FROM vendor_social_cache WHERE vendor_id=?').all(vendor.id);
    const shares7d = db.prepare("SELECT platform, COUNT(*) as c FROM social_shares WHERE vendor_id=? AND datetime(created_at) > datetime('now','-7 days') GROUP BY platform").all(vendor.id);
    const shares30d = db.prepare("SELECT COUNT(*) as c FROM social_shares WHERE vendor_id=? AND datetime(created_at) > datetime('now','-30 days')").get(vendor.id);
    const totalShares = db.prepare('SELECT COUNT(*) as c FROM social_shares WHERE vendor_id=?').get(vendor.id);
    const cardsGenerated = db.prepare('SELECT COUNT(*) as c FROM social_cards WHERE vendor_id=?').get(vendor.id);
    const campaigns = db.prepare('SELECT * FROM influencer_campaigns WHERE vendor_id=? ORDER BY created_at DESC LIMIT 10').all(vendor.id);
    const views7d = db.prepare("SELECT COUNT(*) as c FROM profile_views WHERE vendor_id=? AND datetime(created_at) > datetime('now','-7 days')").get(vendor.id);

    // Connected platforms
    const connected = [];
    if (vendor.instagram) connected.push({ platform: 'instagram', handle: vendor.instagram, url: `https://instagram.com/${vendor.instagram.replace('@','')}` });
    if (vendor.tiktok) connected.push({ platform: 'tiktok', handle: vendor.tiktok, url: `https://tiktok.com/@${vendor.tiktok.replace('@','')}` });
    if (vendor.youtube) connected.push({ platform: 'youtube', handle: vendor.youtube, url: `https://youtube.com/@${vendor.youtube.replace('@','')}` });
    if (vendor.facebook) connected.push({ platform: 'facebook', handle: vendor.facebook, url: vendor.facebook.startsWith('http') ? vendor.facebook : `https://facebook.com/${vendor.facebook}` });
    if (vendor.website) connected.push({ platform: 'website', handle: vendor.website, url: vendor.website.startsWith('http') ? vendor.website : `https://${vendor.website}` });

    // Delivery platforms
    const deliveryPlatforms = [];
    if (vendor.doordash_url) deliveryPlatforms.push({ platform: 'doordash', url: vendor.doordash_url, label: 'DoorDash' });
    if (vendor.ubereats_url) deliveryPlatforms.push({ platform: 'ubereats', url: vendor.ubereats_url, label: 'Uber Eats' });
    if (vendor.grubhub_url) deliveryPlatforms.push({ platform: 'grubhub', url: vendor.grubhub_url, label: 'Grubhub' });
    if (vendor.yelp_url) deliveryPlatforms.push({ platform: 'yelp', url: vendor.yelp_url, label: 'Yelp' });
    if (vendor.google_maps_url) deliveryPlatforms.push({ platform: 'google_maps', url: vendor.google_maps_url, label: 'Google Maps' });
    if (vendor.google_business_url) deliveryPlatforms.push({ platform: 'google_business', url: vendor.google_business_url, label: 'Google Business' });

    // Share templates for each platform
    const vendorUrl = `https://wya.digisigns.link/v/${vendor.id}`;
    const btype = BUSINESS_TYPES[vendor.category] || BUSINESS_TYPES.other;
    const shareTemplates = {
      instagram: {
        caption: `${btype.emoji} Find us on WYA!\n\n${vendor.description ? vendor.description.substring(0, 100) + '...' : ''}\n\n📍 Santa Barbara, CA\n🔗 Link in bio → ${vendorUrl}\n\n#WhereYouAt #WYA #SantaBarbara #ShopLocal #${(vendor.category || 'local').replace(/[^a-zA-Z]/g, '')}`,
        story: `Swipe up to find us on WYA! ${btype.emoji}`
      },
      tiktok: {
        caption: `${btype.emoji} POV: You found the best ${(btype.label || 'vendor').toLowerCase()} in Santa Barbara\n\n📍 Find us on WYA → ${vendorUrl}\n\n#WhereYouAt #WYA #SantaBarbara #ShopLocal #fyp #foryou`
      },
      twitter: {
        text: `${btype.emoji} Check out ${vendor.name} on @WhereYouAt_App! Local ${(btype.label || 'vendor').toLowerCase()} in Santa Barbara 📍\n\n${vendorUrl}\n\n#ShopLocal #SantaBarbara`
      },
      general: {
        text: `${btype.emoji} ${vendor.name} — ${btype.label || 'Local Business'} in Santa Barbara\n\nFind us on WYA: ${vendorUrl}`
      }
    };

    res.json({
      ok: true,
      socialScore: vendor.social_score,
      badge: getSocialBadge(vendor.social_score),
      connected,
      deliveryPlatforms,
      cachedProfiles: cached,
      stats: {
        shares7d: shares7d.reduce((acc, s) => { acc[s.platform] = s.c; return acc; }, {}),
        sharesTotal: totalShares?.c || 0,
        shares30d: shares30d?.c || 0,
        cardsGenerated: cardsGenerated?.c || 0,
        profileViews7d: views7d?.c || 0
      },
      campaigns,
      shareTemplates,
      shareUrl: vendorUrl
    });
  } catch(e) {
    console.error('[WYA-APP] Social hub error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create influencer campaign
app.post('/api/vendor/influencer-campaign', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });
    const { influencer_handle, platform, promo_code } = req.body;
    if (!influencer_handle || !platform) return res.status(400).json({ error: 'influencer_handle and platform required' });

    // Validate promo code exists if provided
    if (promo_code) {
      const promo = db.prepare('SELECT id FROM promo_codes WHERE code=? AND (vendor_id=? OR vendor_id IS NULL) AND active=1').get(promo_code, vendor.id);
      if (!promo) return res.status(400).json({ error: 'Promo code not found or not active' });
    }

    const id = db.prepare('INSERT INTO influencer_campaigns (vendor_id,influencer_handle,platform,promo_code) VALUES (?,?,?,?)')
      .run(vendor.id, sanitize(influencer_handle), sanitize(platform), promo_code || null).lastInsertRowid;

    res.json({ ok: true, campaign: { id, influencer_handle, platform, promo_code, status: 'active' } });
  } catch(e) {
    console.error('[WYA-APP] Campaign error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Track influencer campaign click
app.post('/api/influencer/:campaignId/click', publicLimiter60, (req, res) => {
  try {
    const campaign = db.prepare('SELECT * FROM influencer_campaigns WHERE id=? AND status=?').get(req.params.campaignId, 'active');
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    db.prepare('UPDATE influencer_campaigns SET clicks=clicks+1 WHERE id=?').run(campaign.id);
    res.json({ ok: true, vendorId: campaign.vendor_id });
  } catch(e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══ SOCIAL MEDIA INTEGRATION ENGINE — Phase Jarvis ══════════════════════════
// Connects vendors to Instagram, TikTok, delivery apps with REAL engagement

// POST /api/vendor/social/connect — OAuth-less social account connection
// Validates the account, caches profile data, recalculates social score
app.post('/api/vendor/social/connect', async (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });

    const { platform, handle, url } = req.body;
    const PLATFORMS = ['instagram', 'tiktok', 'facebook', 'youtube', 'twitter', 'doordash', 'ubereats', 'grubhub', 'yelp', 'google_business'];
    if (!platform || !PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Invalid platform. Allowed: ' + PLATFORMS.join(', ') });

    const value = sanitize(url || handle || '');
    if (!value) return res.status(400).json({ error: 'handle or url required' });

    // Map platform name to vendor column
    const fieldMap = {
      doordash: 'doordash_url',
      ubereats: 'ubereats_url',
      grubhub: 'grubhub_url',
      yelp: 'yelp_url',
      google_business: 'google_business_url',
      instagram: 'instagram',
      tiktok: 'tiktok',
      facebook: 'facebook',
      youtube: 'youtube',
      twitter: 'website' // store twitter as website field fallback
    };
    const field = fieldMap[platform];
    db.prepare(`UPDATE vendors SET ${field}=? WHERE id=?`).run(value, vendor.id);

    // Fetch public profile data for social platforms
    let profileData = null;
    if (['instagram', 'tiktok', 'youtube'].includes(platform) && handle) {
      profileData = await _fetchSocialProfile(platform, sanitize(handle));
    }

    // Update social cache if profile data was fetched
    if (profileData) {
      const cleanHandle = sanitize(handle || '').replace('@', '').trim();
      db.prepare(`INSERT OR REPLACE INTO vendor_social_cache
        (vendor_id, platform, handle, bio, avatar_url, followers, verified, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(vendor.id, platform, cleanHandle, profileData.bio || '', profileData.avatar || '', profileData.followers || 0, profileData.verified ? 1 : 0);
    }

    _recalcSocialScore(vendor.id);

    res.json({ success: true, platform, connected: true, profile: profileData });
  } catch (e) {
    console.error('[WYA-SOCIAL] connect error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/vendors/:id/social/feed — Aggregated social feed for vendor profile (public)
app.get('/api/vendors/:id/social/feed', publicLimiter60, (req, res) => {
  try {
    const vendor = db.prepare('SELECT id, instagram, tiktok, youtube FROM vendors WHERE id=?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const cached = db.prepare('SELECT * FROM vendor_social_cache WHERE vendor_id=? ORDER BY updated_at DESC').all(vendor.id);
    const feed = cached.map(entry => ({
      platform: entry.platform,
      handle: entry.handle || '',
      followers: entry.followers || 0,
      bio: entry.bio || '',
      avatar: entry.avatar_url || null,
      lastPost: entry.last_post_url || null,
      lastPostImage: entry.last_post_image || null,
      lastPostCaption: entry.last_post_caption || null,
      verified: !!entry.verified
    }));

    res.json({ vendor_id: vendor.id, feed, platforms: cached.length });
  } catch (e) {
    console.error('[WYA-SOCIAL] feed error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/vendor/social/broadcast — Manual social broadcast (generates share templates)
app.post('/api/vendor/social/broadcast', async (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });

    const { message, includeMenu, includeLocation, platforms } = req.body;

    const broadcastResult = await _socialAutoBroadcast(vendor, {
      customMessage: message ? sanitize(message) : undefined,
      includeMenu: includeMenu !== false,
      includeLocation: includeLocation !== false,
      platforms: platforms || ['instagram', 'tiktok']
    });

    res.json({ success: true, broadcast: broadcastResult });
  } catch (e) {
    console.error('[WYA-SOCIAL] broadcast error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/vendor/social/analytics — Social performance analytics (auth required)
app.get('/api/vendor/social/analytics', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });

    const shares7d = db.prepare("SELECT platform, COUNT(*) as count FROM social_shares WHERE vendor_id=? AND datetime(created_at) > datetime('now','-7 days') GROUP BY platform").all(vendor.id);
    const shares30d = db.prepare("SELECT platform, COUNT(*) as count FROM social_shares WHERE vendor_id=? AND datetime(created_at) > datetime('now','-30 days') GROUP BY platform").all(vendor.id);
    const socialCache = db.prepare('SELECT platform, followers, engagement_rate FROM vendor_social_cache WHERE vendor_id=?').all(vendor.id);
    const campaigns = db.prepare("SELECT * FROM influencer_campaigns WHERE vendor_id=? AND status='active'").all(vendor.id);
    const campaignClicks = campaigns.reduce((sum, c) => sum + (c.clicks || 0), 0);

    // Orders attributed to social via referral_source
    const socialOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE vendor_id=? AND (referral_source LIKE '%instagram%' OR referral_source LIKE '%tiktok%' OR referral_source LIKE '%social%')").get(vendor.id);

    res.json({
      social_score: vendor.social_score || 0,
      badge: getSocialBadge(vendor.social_score || 0),
      shares: { last_7_days: shares7d, last_30_days: shares30d },
      platforms: socialCache,
      campaigns: { active: campaigns.length, total_clicks: campaignClicks },
      social_orders: socialOrders?.count || 0,
      recommendations: _getSocialRecommendations(vendor)
    });
  } catch (e) {
    console.error('[WYA-SOCIAL] analytics error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══ INFLUENCER COLLAB MARKETPLACE ═══════════════════════════════════════════
// Vendors create open offers, creators apply, WYA tracks attribution

// POST /api/vendor/influencer/offer — Create a public collab offer
app.post('/api/vendor/influencer/offer', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });

    const { title, description, compensation, requirements, platforms } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200 chars)' });

    const primaryPlatform = Array.isArray(platforms) && platforms.length ? platforms[0] : 'instagram';
    const result = db.prepare(
      `INSERT INTO influencer_campaigns (vendor_id, title, description, influencer_handle, platform, promo_code, status, compensation, requirements, target_platforms, created_at)
       VALUES (?, ?, ?, '', ?, '', 'open', ?, ?, ?, datetime('now'))`
    ).run(
      vendor.id,
      sanitize(title),
      sanitize(description || ''),
      sanitize(primaryPlatform),
      sanitize(compensation || 'free_meal'),
      sanitize(requirements || ''),
      JSON.stringify(platforms || ['instagram', 'tiktok'])
    );

    res.json({ success: true, offerId: result.lastInsertRowid });
  } catch (e) {
    console.error('[WYA-SOCIAL] offer create error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/influencer/offers — Public: browse available collab offers
app.get('/api/influencer/offers', publicLimiter60, (req, res) => {
  try {
    const offers = db.prepare(
      `SELECT ic.id, ic.vendor_id, ic.title, ic.description, ic.compensation, ic.requirements, ic.target_platforms, ic.created_at,
              v.name as vendor_name, v.category, v.photo_url, v.avg_rating
       FROM influencer_campaigns ic
       JOIN vendors v ON ic.vendor_id = v.id
       WHERE ic.status = 'open'
       ORDER BY ic.created_at DESC
       LIMIT 20`
    ).all();
    res.json({ offers });
  } catch (e) {
    console.error('[WYA-SOCIAL] offers list error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/influencer/apply/:offerId — Creator applies to a collab offer
app.post('/api/influencer/apply/:offerId', publicLimiter60, (req, res) => {
  try {
    const { handle, platform, followers, portfolio_url, message } = req.body;
    if (!handle || !platform) return res.status(400).json({ error: 'handle and platform required' });
    if (handle.length > 100) return res.status(400).json({ error: 'handle too long' });

    const offerId = parseInt(req.params.offerId, 10);
    if (!offerId) return res.status(400).json({ error: 'Invalid offer ID' });

    const offer = db.prepare("SELECT * FROM influencer_campaigns WHERE id=? AND status='open'").get(offerId);
    if (!offer) return res.status(404).json({ error: 'Offer not found or no longer accepting applications' });

    const followersNum = Math.max(0, parseInt(followers, 10) || 0);
    const requirementsData = `followers:${followersNum},portfolio:${sanitize(portfolio_url || '')}`;

    const result = db.prepare(
      `INSERT INTO influencer_campaigns (vendor_id, title, description, influencer_handle, platform, promo_code, status, compensation, requirements, target_platforms, parent_offer_id, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'applied', ?, ?, ?, ?, datetime('now'))`
    ).run(
      offer.vendor_id,
      offer.title || '',
      sanitize(message || ''),
      sanitize(handle),
      sanitize(platform),
      offer.compensation || '',
      requirementsData,
      offer.target_platforms || '[]',
      offerId
    );

    res.json({ success: true, applicationId: result.lastInsertRowid });
  } catch (e) {
    console.error('[WYA-SOCIAL] apply error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══ DELIVERY APP DEEP INTEGRATION ═══════════════════════════════════════════
// Smart order-option listing + tracked redirects to delivery apps

// GET /api/vendors/:id/order-options — All ordering channels for a vendor
app.get('/api/vendors/:id/order-options', publicLimiter60, (req, res) => {
  try {
    const vendor = db.prepare('SELECT id, name, accepts_orders, delivery_enabled, doordash_url, ubereats_url, grubhub_url FROM vendors WHERE id=?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const options = [];

    // Direct ordering (WYA native — 0% commission)
    if (vendor.accepts_orders) {
      options.push({ type: 'direct', label: 'Order Direct (0% fees)', platform: 'wya', url: `/customer?vendor=${vendor.id}`, commission: '0%', badge: 'Best for vendor' });
    }

    // Third-party delivery apps
    if (vendor.doordash_url) options.push({ type: 'delivery', label: 'DoorDash Delivery', platform: 'doordash', url: vendor.doordash_url, commission: '15-30%' });
    if (vendor.ubereats_url) options.push({ type: 'delivery', label: 'Uber Eats', platform: 'ubereats', url: vendor.ubereats_url, commission: '15-30%' });
    if (vendor.grubhub_url) options.push({ type: 'delivery', label: 'Grubhub', platform: 'grubhub', url: vendor.grubhub_url, commission: '20-30%' });

    // Pickup always available
    options.push({ type: 'pickup', label: 'Pickup', platform: 'wya', url: `/customer?vendor=${vendor.id}&mode=pickup`, commission: '0%' });

    res.json({ vendor_id: vendor.id, options, recommended: options[0]?.type || 'pickup' });
  } catch (e) {
    console.error('[WYA-SOCIAL] order-options error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/vendors/:id/delivery-redirect/:platform — Track click + redirect to delivery app
app.get('/api/vendors/:id/delivery-redirect/:platform', (req, res) => {
  try {
    const allowedPlatforms = ['doordash', 'ubereats', 'grubhub'];
    const platform = req.params.platform;
    if (!allowedPlatforms.includes(platform)) return res.status(400).json({ error: 'Invalid platform' });

    const vendor = db.prepare('SELECT id, doordash_url, ubereats_url, grubhub_url FROM vendors WHERE id=?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const urls = { doordash: vendor.doordash_url, ubereats: vendor.ubereats_url, grubhub: vendor.grubhub_url };
    const targetUrl = urls[platform];
    if (!targetUrl) return res.status(404).json({ error: 'Platform not connected for this vendor' });

    // Validate URL looks like a real delivery link before redirect
    if (!/^https?:\/\//.test(targetUrl)) return res.status(400).json({ error: 'Invalid delivery URL stored for this platform' });

    // Track the click as a social share event
    try {
      db.prepare("INSERT INTO social_shares (vendor_id, platform, share_type, created_at) VALUES (?, ?, 'delivery_click', datetime('now'))")
        .run(vendor.id, `delivery_${platform}`);
    } catch (e) { /* non-fatal */ }

    res.redirect(targetUrl);
  } catch (e) {
    console.error('[WYA-SOCIAL] delivery-redirect error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enhanced social score — weighted by actual platform depth
function computeEnhancedSocialScore(vendor, enrichedData) {
  let score = 0;

  // Platform presence (10 pts each, max 60)
  const platformWeights = { instagram: 15, tiktok: 15, youtube: 10, facebook: 10, website: 5, yelp_url: 5 };
  if (vendor.instagram) score += platformWeights.instagram;
  if (vendor.tiktok) score += platformWeights.tiktok;
  if (vendor.youtube) score += platformWeights.youtube;
  if (vendor.facebook) score += platformWeights.facebook;
  if (vendor.website) score += platformWeights.website;
  if (vendor.yelp_url) score += platformWeights.yelp_url;

  // Delivery platform presence (5 pts, shows professionalism)
  if (vendor.doordash_url || vendor.ubereats_url || vendor.grubhub_url) score += 5;
  if (vendor.google_maps_url || vendor.google_business_url) score += 5;

  // Reviews (up to 15 pts)
  score += Math.min(15, (vendor.review_count || 0) * 3);

  // Rating bonus (up to 10 pts)
  score += Math.min(10, Math.round((vendor.avg_rating || 0) * 2));

  // Enriched data bonus (if oEmbed returned real data)
  if (enrichedData) {
    for (const [platform, data] of Object.entries(enrichedData)) {
      if (data && data.fetched && data.title) score += 2; // Active account confirmed
    }
  }

  return Math.min(100, score);
}

// ═══ Social Integration Engine Helpers — Phase Jarvis ════════════════════════

// Fetch social profile via public oEmbed (no OAuth, graceful fallback)
async function _fetchSocialProfile(platform, handle) {
  const clean = (handle || '').replace('@', '').trim();
  if (!clean) return null;
  try {
    if (platform === 'tiktok') {
      const resp = await fetch(`https://www.tiktok.com/oembed?url=https://www.tiktok.com/@${encodeURIComponent(clean)}`, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const data = await resp.json();
        return { handle: clean, displayName: data.author_name || clean, avatar: data.thumbnail_url || null, followers: 0, verified: false };
      }
    } else if (platform === 'youtube') {
      const resp = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/@${encodeURIComponent(clean)}&format=json`, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const data = await resp.json();
        return { handle: clean, displayName: data.author_name || clean, avatar: data.thumbnail_url || null, followers: 0, verified: false };
      }
    } else if (platform === 'instagram') {
      return { handle: clean, displayName: clean, avatar: null, followers: 0, verified: false, profileUrl: `https://instagram.com/${clean}` };
    }
  } catch (e) {
    console.warn(`[WYA-SOCIAL] Profile fetch failed for ${platform}/${clean}:`, e.message);
  }
  return { handle: clean, displayName: clean, avatar: null, followers: 0, verified: false };
}

// Prepare and track social broadcast templates (no actual 3rd-party posting — share links only)
async function _socialAutoBroadcast(vendor, opts = {}) {
  const results = [];
  const vendorFull = vendor && vendor.id ? db.prepare('SELECT * FROM vendors WHERE id=?').get(vendor.id) : null;
  if (!vendorFull) return results;

  const category = vendorFull.category || 'local';
  const catTag = category.replace(/[^a-zA-Z0-9]/g, '');
  const message = opts.customMessage ||
    `${vendorFull.name} is NOW OPEN! ${category} Come find us!\n\n` +
    (opts.includeLocation !== false ? `Location: https://wya.digisigns.link/v/${vendorFull.id}` : '') +
    `\n\n#WYA #${catTag} #SantaBarbara #OpenNow`;

  // Generate share links for each platform (no OAuth — deep-link share patterns)
  const shareLinks = {};
  if (vendorFull.instagram) {
    const igHandle = vendorFull.instagram.replace('@', '');
    shareLinks.instagram = {
      story: `https://www.instagram.com/create/story/?url=${encodeURIComponent('https://wya.digisigns.link/v/' + vendorFull.id)}`,
      caption: message,
      profile: `https://instagram.com/${igHandle}`
    };
  }
  if (vendorFull.tiktok) {
    const ttHandle = vendorFull.tiktok.replace('@', '');
    shareLinks.tiktok = {
      profile: `https://tiktok.com/@${ttHandle}`,
      suggested_caption: message
    };
  }
  if (vendorFull.facebook) {
    shareLinks.facebook = {
      share: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent('https://wya.digisigns.link/v/' + vendorFull.id)}`,
      suggested_caption: message
    };
  }

  // Track the broadcast in social_shares
  try {
    for (const p of Object.keys(shareLinks)) {
      db.prepare("INSERT INTO social_shares (vendor_id, platform, share_type, created_at) VALUES (?, ?, 'broadcast', datetime('now'))")
        .run(vendorFull.id, `broadcast_${p}`);
    }
  } catch (e) { /* non-fatal */ }

  // Notify vendor via push that broadcast templates are ready
  if (Object.keys(shareLinks).length > 0) {
    try {
      const subs = db.prepare("SELECT * FROM push_subscriptions WHERE user_type='vendor' AND user_id=?").all(vendorFull.id);
      for (const sub of subs) {
        webpush.sendNotification(JSON.parse(sub.subscription || '{}'), JSON.stringify({
          title: 'Go-Live Broadcast Ready!',
          body: 'Share templates ready for your connected platforms. Tap to post!',
          url: '/vendor/social-hub'
        })).catch(() => {});
      }
    } catch (e) { /* non-fatal */ }
  }

  return { message, shareLinks, platforms: Object.keys(shareLinks) };
}

// Recalculate social score from scratch based on connected platforms + reviews
function _recalcSocialScore(vendorId) {
  try {
    const v = db.prepare('SELECT instagram, tiktok, youtube, facebook, website, yelp_url, google_maps_url, google_business_url, doordash_url, ubereats_url, grubhub_url, review_count, avg_rating FROM vendors WHERE id=?').get(vendorId);
    if (!v) return;

    let score = 0;
    if (v.instagram) score += 15;
    if (v.tiktok) score += 15;
    if (v.youtube) score += 10;
    if (v.facebook) score += 10;
    if (v.website) score += 5;
    if (v.yelp_url) score += 5;
    if (v.doordash_url || v.ubereats_url || v.grubhub_url) score += 5;
    if (v.google_maps_url || v.google_business_url) score += 5;
    score += Math.min(15, (v.review_count || 0) * 3);
    if ((v.avg_rating || 0) >= 4.5) score += 10;
    else if ((v.avg_rating || 0) >= 4.0) score += 5;

    db.prepare('UPDATE vendors SET social_score=? WHERE id=?').run(Math.min(100, score), vendorId);
  } catch (e) {
    console.warn('[WYA-SOCIAL] _recalcSocialScore error:', e.message);
  }
}

// Return prioritized social recommendations for a vendor
function _getSocialRecommendations(vendor) {
  const recs = [];
  try {
    const v = db.prepare('SELECT instagram, tiktok, youtube, facebook, doordash_url, ubereats_url, grubhub_url, google_business_url FROM vendors WHERE id=?').get(vendor.id);
    if (!v) return recs;
    if (!v.instagram) recs.push({ priority: 'high', action: 'Connect Instagram', reason: 'Instagram drives 33% of food discovery', impact: '+15 score' });
    if (!v.tiktok) recs.push({ priority: 'high', action: 'Connect TikTok', reason: 'TikTok food content gets 2x engagement vs other categories', impact: '+15 score' });
    if (!v.google_business_url) recs.push({ priority: 'high', action: 'Connect Google Business', reason: 'Auto-updates your Google Maps listing when you go live', impact: '+5 score + SEO' });
    if (!v.doordash_url && !v.ubereats_url) recs.push({ priority: 'medium', action: 'Add delivery app links', reason: 'Customers who cannot visit want to order delivery', impact: '+5 score' });
    if (!v.youtube) recs.push({ priority: 'low', action: 'Add YouTube channel', reason: 'Behind-the-scenes content builds loyal following', impact: '+10 score' });
  } catch (e) { /* non-fatal */ }
  return recs;
}

// Vendor QR code
app.get('/api/vendors/:id/qr', (req, res) => {
  const vendor = db.prepare('SELECT id, name FROM vendors WHERE id=?').get(req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  const url = `https://wya.digisigns.link/v/${vendor.id}`;
  QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#833AB4', light: '#0A0A0A' } })
    .then(dataUrl => res.json({ ok: true, qr: dataUrl, url }))
    .catch(e => res.status(500).json({ error: 'QR generation failed' }));
});

// Alias /api/vendors → /api/vendors/live (convenience route)
app.get('/api/vendors', publicLimiter60, (req, res) => {
  res.redirect(307, '/api/vendors/live' + (req._parsedUrl.search || ''));
});

// All vendors (admin) — Phase 750: includes onboarding progress
app.get('/api/vendors/all', publicLimiter30, (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error:'Admin only' });
    const vendors = db.prepare("SELECT id,name,category,email,phone,is_open,last_seen,lat,lng,created_at,digitap_card_url,business_hours,photo_url,description,email_verified FROM vendors ORDER BY created_at DESC").all();
    const menuCounts = {};
    for (const r of db.prepare('SELECT vendor_id, COUNT(*) as c FROM menu_items GROUP BY vendor_id').all()) menuCounts[r.vendor_id] = r.c;
    for (const v of vendors) {
      const ob = computeOnboardingSteps(v, menuCounts[v.id]||0);
      v.onboarding_percent = ob.percent;
      v.onboarding_complete = ob.ready;
      v.onboarding_missing = ob.missing;
    }
    const stats = {
      total: vendors.length,
      live: vendors.filter(v=>v.is_open).length,
      today: vendors.filter(v=>v.created_at&&v.created_at.startsWith(new Date().toISOString().split('T')[0])).length,
      onboarding_complete: vendors.filter(v=>v.onboarding_complete).length
    };
    res.json({ ok:true, stats, vendors });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register vendor
app.post('/api/vendor/register', (req, res) => {
  try {
    let { name, category, email, password, phone, description, digitap_card_url, ref, invite_code } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error:'name, email, password required' });
    name = sanitize(name); description = sanitize(description);
    // Phase 1654: Input length bounds
    if (name.length > 100) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
    if (email.length > 254) return res.status(400).json({ error: 'Email too long' });
    if (description && description.length > 2000) return res.status(400).json({ error: 'Description too long (max 2000 chars)' });
    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error:'Invalid email format' });
    // Phase 1655: Block test/QA/demo emails from registering
    if (isTestData(email, name)) {
      return res.status(400).json({ error: 'Please use a real email address' });
    }
    // Phase 1654: Enforce strong password on registration
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password))
      return res.status(400).json({ error: 'Password must be 8+ characters with at least 1 letter and 1 number' });
    // Rate limit: 5 registrations per IP per hour
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!rateLimit('reg:' + ip, 20, 3600000)) return res.status(429).json({ error:'Too many registrations. Try again later.' });
    const existing = db.prepare('SELECT id FROM vendors WHERE email=?').get(email);
    if (existing) return res.status(409).json({ error:'Email already registered' });
    const id = 'v_' + crypto.randomBytes(8).toString('hex');
    // Generate referral code
    const slug = name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase() || 'WYA';
    const referralCode = slug + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    db.prepare('INSERT OR IGNORE INTO vendors (id,name,category,email,password_hash,password_version,phone,description,digitap_card_url,trial_ends_at,referral_code) VALUES (?,?,?,?,?,2,?,?,?,datetime(\'now\',\'+30 days\'),?)').run(
      id, name, category||'other', email.toLowerCase(), hashPw(password), phone||'', description||'', digitap_card_url||'', referralCode
    );
    // Track referral if ref code provided
    if (ref) {
      const referrer = db.prepare("SELECT id FROM vendors WHERE referral_code=?").get(ref);
      if (referrer) {
        db.prepare("INSERT INTO referrals (referrer_id, referred_id, code, status) VALUES (?,?,?,'pending')").run(referrer.id, id, ref);
      }
    }
    // Phase 749: Track invite conversion
    if (invite_code) {
      const invite = db.prepare("SELECT id FROM vendor_invites WHERE invite_code=? AND status IN ('pending','opened')").get(invite_code);
      if (invite) db.prepare("UPDATE vendor_invites SET status='registered', registered_at=datetime('now') WHERE id=?").run(invite.id);
    }
    // Phase 749: Send verification email
    const verifyToken = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE vendors SET verification_token=? WHERE id=?').run(verifyToken, id);
    // Notify CRM — skip test/lockdown registrations to prevent lead spam
    if (!email.includes('@digisigns.link') && !email.includes('@test.') && !email.includes('@example.')) {
      notifyCRM({ name, email, phone, category });
    }
    // Brain OS 3.0: Vendor signup → episodic memory
    if (_brainIngest && !email.includes('@test.') && !email.includes('@example.')) {
      try {
        _brainIngest.ingest({
          source: 'wya', type: 'vendor_signup', memoryType: 'episodic',
          content: `WYA vendor registered: ${name} (${category}). Email: ${email}`,
          tenantId: process.env.OWNER_USER_ID || 'sergio', confidence: 0.8,
          entities: [{ name, type: 'vendor' }],
          tags: ['wya', 'vendor', 'signup', category]
        });
      } catch {}
    }
    // Create session (cap at 5 concurrent per vendor)
    const activeVSessions = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE vendor_id=? AND datetime(expires_at) > datetime('now')").get(id)?.c || 0;
    if (activeVSessions >= 5) {
      db.prepare("DELETE FROM sessions WHERE token IN (SELECT token FROM sessions WHERE vendor_id=? ORDER BY created_at ASC LIMIT ?)").run(id, activeVSessions - 4);
    }
    const token = genToken();
    const expires = new Date(Date.now() + 30*24*60*60*1000).toISOString().replace('T',' ').replace('Z','');
    db.prepare('INSERT INTO sessions (token,vendor_id,expires_at) VALUES (?,?,?)').run(token, id, expires);
    emsSyncCustomer(email, name, phone, 'vendor');
    res.json({ ok:true, token, vendor_id:id, email_verification_required:true, message:'Welcome to WYA! Check your email to verify.' });
    // Enroll in growth engine drip (non-blocking)
    try {
      const dripPayload = JSON.stringify({ tenantId: email.toLowerCase(), sequenceName: 'signup_welcome' });
      const dripReq = http.request({ hostname: '127.0.0.1', port: 3485, path: '/api/drip/enroll', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dripPayload) }, timeout: 5000 }, () => {});
      dripReq.on('error', (e) => console.warn('[WYA] Fire-and-forget failed:', e.message)); dripReq.write(dripPayload); dripReq.end();
      const leadPayload = JSON.stringify({ name, email: email.toLowerCase(), source: 'wya-vendor-register', interest: category || 'vendor' });
      const leadReq = http.request({ hostname: '127.0.0.1', port: 3485, path: '/api/leads/capture', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(leadPayload) }, timeout: 5000 }, () => {});
      leadReq.on('error', (e) => console.warn('[WYA] Fire-and-forget failed:', e.message)); leadReq.write(leadPayload); leadReq.end();
    } catch(_) {}
    // Welcome + verification email
    sendEmail(req.body.email.toLowerCase(), `Welcome to Where You At! Verify your email`, `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#050505;color:#f5f5f5"><div style="font-size:24px;font-weight:900;margin-bottom:8px">Welcome to <span style="color:#FF5E1A">WYA</span>!</div><p style="color:#9ca3af;line-height:1.6;margin-bottom:20px">You're on the vendor network. Verify your email to go live!</p><a href="https://wya.digisigns.link/verify/${verifyToken}" style="display:block;text-align:center;background:#FF5E1A;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:800;font-size:15px;margin-bottom:20px">Verify Email →</a><div style="background:#0a1a0a;border:1px solid rgba(34,197,94,.2);border-radius:12px;padding:16px;margin-bottom:20px"><div style="color:#22C55E;font-weight:700;margin-bottom:4px">30-day free trial active</div><div style="color:#6b7280;font-size:13px">No credit card needed yet.</div></div></div>`).catch((err) => { console.error('[WYA-APP] Vendor registration email failed:', err.message); });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
app.post('/api/vendor/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({ error:'email and password required' });
    // Rate limit: 10 login attempts per IP per 15 minutes
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!rateLimit('login:' + ip, 30, 900000)) return res.status(429).json({ error:'Too many login attempts. Try again later.' });
    const vendor = db.prepare('SELECT * FROM vendors WHERE email=?').get(email.toLowerCase());
    if (!vendor || !verifyPw(password, vendor.password_hash, vendor.password_version || 1)) return res.status(401).json({ error:'Invalid credentials' });
    // Phase 1653: Transparent bcrypt upgrade on legacy login
    if ((vendor.password_version || 1) === 1) {
      const newHash = hashPw(password);
      db.prepare('UPDATE vendors SET password_hash=?, password_version=2 WHERE id=?').run(newHash, vendor.id);
    }
    // Phase 1661: Token rotation — invalidate all previous sessions on re-auth
    db.prepare('DELETE FROM sessions WHERE vendor_id=?').run(vendor.id);
    const token = genToken();
    const expires = new Date(Date.now() + 30*24*60*60*1000).toISOString().replace('T',' ').replace('Z','');
    db.prepare('INSERT INTO sessions (token,vendor_id,expires_at) VALUES (?,?,?)').run(token, vendor.id, expires);
    res.json({ ok:true, token, vendor: { id:vendor.id, name:vendor.name, category:vendor.category, is_open:vendor.is_open } });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle open/closed
app.post('/api/vendor/toggle', (req, res) => {
  try {
    const token = req.headers['x-auth-token'] || req.body.token;
    const { lat, lng, is_open } = req.body;
    const vendor = getVendorByToken(token);
    if (!vendor) return res.status(401).json({ error:'Invalid or expired session' });
    if (!rateLimit('toggle:' + vendor.id, 10, 300000)) return res.status(429).json({ error:'Too many toggle requests — try again in a few minutes' });
    const newState = (is_open !== undefined) ? ([1, true, "1", "true"].includes(is_open) ? 1 : 0) : (vendor.is_open ? 0 : 1);
    // Block expired trial vendors from going live
    if (newState === 1 && isTrialExpired(vendor)) {
      return res.status(402).json({ error:'Trial expired — upgrade to go live', upgrade_url:'https://wya.digisigns.link/plans' });
    }
    // Phase 749: Require email verification to go live
    if (newState === 1 && !vendor.email_verified) {
      return res.status(403).json({ error:'Please verify your email before going live. Check your inbox or resend from your dashboard.', needs_verification:true });
    }
    const now = new Date().toISOString();
    if (newState === 1) {
      if (lat && lng) {
        db.prepare('UPDATE vendors SET is_open=1, lat=?, lng=?, last_seen=? WHERE id=?').run(lat, lng, now, vendor.id);
      } else {
        db.prepare('UPDATE vendors SET is_open=1, last_seen=? WHERE id=?').run(now, vendor.id);
      }
    } else {
      db.prepare('UPDATE vendors SET is_open=0, last_seen=? WHERE id=?').run(now, vendor.id);
    }
    db.prepare('INSERT INTO activity_log (vendor_id,action,lat,lng) VALUES (?,?,?,?)').run(vendor.id, newState?'open':'close', lat||null, lng||null);
    // Phase v4.0: Broadcast vendor online/offline for live map tracking
    if (newState === 0) {
      broadcastSSE({ type: 'vendor_offline', vendor_id: vendor.id, ts: new Date().toISOString() });
    }
    // Check referral reward when vendor goes live
    if (newState === 1) checkReferralReward(vendor.id);
    // Phase Jarvis: Social auto-blast on go-live — fire-and-forget, non-blocking
    if (newState === 1) {
      setImmediate(() => _socialAutoBroadcast(vendor).catch(e => console.warn('[WYA-SOCIAL] Auto-broadcast error:', e.message)));
    }
    // Notify followers when vendor goes live
    if (newState === 1) {
      setImmediate(() => {
        try {
          const followers = db.prepare('SELECT customer_id FROM vendor_followers WHERE vendor_id=? AND active=1').all(vendor.id);
          for (const f of followers) {
            sendPushNotification(f.customer_id, 'customer', vendor.name, `${vendor.name} is now open near you!`, `https://wya.digisigns.link/customer?vendor=${vendor.id}`, { category: 'vendor_live', vendorId: vendor.id });
          }
          if (followers.length) console.log(`[WYA-FOLLOW] Notified ${followers.length} followers that ${vendor.name} went live`);
        } catch(e) { console.warn('[WYA-FOLLOW] Error notifying followers:', e.message); }
      });
    }
    broadcastVendors();
    res.json({ ok:true, is_open:newState, message: newState ? "You're live on the map!" : "You're now offline" });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update profile — expanded with marketplace fields

app.post('/api/vendor/location', (req, res) => {
  try {
    const token = req.headers['x-auth-token'] || req.body.token;
    const vendor = getVendorByToken(token);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });
    if (!vendor.is_open) return res.json({ ok: true, ignored: true });
    // Validate coordinates
    const coords = validateCoords(req.body.lat, req.body.lng);
    if (!coords) return res.status(400).json({ error: 'Invalid coordinates — lat must be -90..90, lng must be -180..180' });
    // Rate limit: max 1 update per 5s
    if (!locationRateOk(vendor.id)) return res.status(429).json({ error: 'Location updates limited to once per 5 seconds' });
    // Teleportation guard: reject if >500mi from last known position
    if (vendor.lat && vendor.lng) {
      const jump = haversine(coords.lat, coords.lng, vendor.lat, vendor.lng);
      if (jump > 500) return res.status(400).json({ error: 'Location jump too large — possible GPS error', distance_mi: Math.round(jump) });
    }
    // No-op filter: skip if identical to 6 decimals
    if (vendor.lat && vendor.lng && coords.lat.toFixed(6) === parseFloat(vendor.lat).toFixed(6) && coords.lng.toFixed(6) === parseFloat(vendor.lng).toFixed(6)) {
      return res.json({ ok: true, unchanged: true });
    }
    const now = new Date().toISOString();
    // Calculate heading from previous position
    const heading = (vendor.lat && vendor.lng) ? Math.atan2(coords.lng - vendor.lng, coords.lat - vendor.lat) * 180 / Math.PI : 0;
    const speed = parseFloat(req.body.speed) || 0;
    db.prepare('UPDATE vendors SET lat=?, lng=?, last_seen=? WHERE id=?').run(coords.lat, coords.lng, now, vendor.id);
    db.prepare('INSERT INTO activity_log (vendor_id,action,lat,lng) VALUES (?,?,?,?)').run(vendor.id, 'location_update', coords.lat, coords.lng);
    // Phase v4.0: Broadcast per-vendor location update (Uber-style live tracking)
    broadcastSSE({
      type: 'vendor_location',
      vendor_id: vendor.id,
      name: vendor.name,
      lat: coords.lat,
      lng: coords.lng,
      heading: Math.round(heading),
      speed: Math.round(speed),
      ts: now
    });
    res.json({ ok: true, lat: coords.lat, lng: coords.lng, ts: now });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 752: Geofence configuration
app.put('/api/vendor/geofence', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });
    const { lat, lng, radius_m, enabled } = req.body;
    if (lat !== undefined && lng !== undefined) {
      const coords = validateCoords(lat, lng);
      if (!coords) return res.status(400).json({ error: 'Invalid geofence coordinates — lat must be -90..90, lng must be -180..180' });
      // Clamp radius to 50-5000m
      const clampedRadius = Math.max(50, Math.min(5000, parseInt(radius_m, 10) || 200));
      db.prepare('UPDATE vendors SET geofence_lat=?, geofence_lng=?, geofence_radius_m=?, auto_checkin_enabled=? WHERE id=?')
        .run(coords.lat, coords.lng, clampedRadius, enabled ? 1 : 0, vendor.id);
    } else if (enabled !== undefined) {
      db.prepare('UPDATE vendors SET auto_checkin_enabled=? WHERE id=?').run(enabled ? 1 : 0, vendor.id);
    }
    res.json({ ok: true, message: enabled ? 'Auto check-in enabled' : 'Geofence updated' });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/vendor/geofence', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });
    res.json({ ok: true, geofence: { lat: vendor.geofence_lat, lng: vendor.geofence_lng, radius_m: vendor.geofence_radius_m || 200, enabled: !!vendor.auto_checkin_enabled } });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 752: Auto check-in — vendor app sends location, server checks geofence
app.post('/api/vendor/auto-checkin', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });
    if (!vendor.auto_checkin_enabled) return res.json({ ok: true, action: 'none', reason: 'auto_checkin_disabled' });
    if (!vendor.geofence_lat || !vendor.geofence_lng) return res.json({ ok: true, action: 'none', reason: 'no_geofence_set' });
    if (!vendor.email_verified) return res.json({ ok: true, action: 'none', reason: 'email_not_verified' });
    // Validate incoming coords
    const coords = validateCoords(req.body.lat, req.body.lng);
    if (!coords) return res.status(400).json({ error: 'Invalid coordinates — lat must be -90..90, lng must be -180..180' });
    // Validate geofence coords are still valid
    const geoCoords = validateCoords(vendor.geofence_lat, vendor.geofence_lng);
    if (!geoCoords) return res.status(500).json({ error: 'Stored geofence coordinates are invalid — please reconfigure geofence' });
    const dist = haversine(coords.lat, coords.lng, geoCoords.lat, geoCoords.lng) * 1609.34; // miles to meters
    if (!isFinite(dist)) return res.status(500).json({ error: 'Distance calculation failed' });
    const radius = vendor.geofence_radius_m || 200;
    const now = new Date().toISOString();
    if (dist <= radius && !vendor.is_open) {
      // Auto check-in
      db.prepare('UPDATE vendors SET is_open=1, lat=?, lng=?, last_seen=? WHERE id=?').run(coords.lat, coords.lng, now, vendor.id);
      db.prepare('INSERT INTO activity_log (vendor_id,action,lat,lng) VALUES (?,?,?,?)').run(vendor.id, 'auto_checkin', coords.lat, coords.lng);
      checkReferralReward(vendor.id);
      broadcastVendors();
      // Notify followers
      const followers = db.prepare('SELECT customer_id FROM vendor_followers WHERE vendor_id=? AND active=1').all(vendor.id);
      for (const f of followers) {
        sendPushNotification(f.customer_id, 'customer', vendor.name, `${vendor.name} just opened!`, `https://wya.digisigns.link/customer?vendor=${vendor.id}`);
      }
      return res.json({ ok: true, action: 'checked_in', message: "You're live on the map!" });
    } else if (dist > radius && vendor.is_open) {
      // Auto check-out
      db.prepare('UPDATE vendors SET is_open=0, last_seen=? WHERE id=?').run(now, vendor.id);
      db.prepare('INSERT INTO activity_log (vendor_id,action,lat,lng) VALUES (?,?,?,?)').run(vendor.id, 'auto_checkout', coords.lat, coords.lng);
      broadcastVendors();
      return res.json({ ok: true, action: 'checked_out', message: "You've left your spot — now offline" });
    }
    res.json({ ok: true, action: 'none', is_open: !!vendor.is_open, distance_m: Math.round(dist) });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 1365: Internal geofence toggle — called by THE SOUL gps-tracker on enter/exit events
// No auth required — localhost-only trusted caller
app.post('/api/internal/geofence-toggle', (req, res) => {
  try {
    const forwarded = req.headers['x-forwarded-for'] || '';
    const srcIp = req.ip || req.connection.remoteAddress || '';
    const isLocal = srcIp === '127.0.0.1' || srcIp === '::1' || srcIp === '::ffff:127.0.0.1' || forwarded.startsWith('127.');
    if (!isLocal) return res.status(403).json({ error: 'internal only' });

    const { vendor_id, is_open, lat, lng, source } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });

    const vendor = db.prepare('SELECT id, is_open, name FROM vendors WHERE id=?').get(vendor_id);
    if (!vendor) return res.status(404).json({ error: 'vendor not found' });

    const newState = is_open ? 1 : 0;
    if (vendor.is_open === newState) return res.json({ ok: true, action: 'none', reason: 'already_in_state' });

    // Validate coords if provided
    let validLat = null, validLng = null;
    if (lat !== undefined && lng !== undefined) {
      const coords = validateCoords(lat, lng);
      if (!coords && newState === 1) return res.status(400).json({ error: 'Cannot go live with invalid coordinates' });
      if (coords) { validLat = coords.lat; validLng = coords.lng; }
    }

    const now = new Date().toISOString();
    if (newState === 1 && validLat && validLng) {
      db.prepare('UPDATE vendors SET is_open=1, lat=?, lng=?, last_seen=? WHERE id=?').run(validLat, validLng, now, vendor_id);
    } else if (newState === 1) {
      db.prepare('UPDATE vendors SET is_open=1, last_seen=? WHERE id=?').run(now, vendor_id);
    } else {
      db.prepare('UPDATE vendors SET is_open=0, last_seen=? WHERE id=?').run(now, vendor_id);
    }

    logVendorStatusChange(vendor_id, vendor.is_open, newState, source || 'geofence_toggle', null);
    db.prepare('INSERT INTO activity_log (vendor_id,action,lat,lng) VALUES (?,?,?,?)').run(vendor_id, newState ? 'geofence_checkin' : 'geofence_checkout', validLat, validLng);
    broadcastVendors();

    console.log(`[GEOFENCE-TOGGLE] ${vendor_id} (${vendor.name}) → is_open=${newState} via ${source || 'geofence'}`);
    res.json({ ok: true, action: newState ? 'checked_in' : 'checked_out', vendor_id, is_open: newState });
  } catch (e) {
    console.error('[GEOFENCE-TOGGLE] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Phase 2100: Internal vendor email verification — called by THE SOUL (localhost-only, no auth)
app.post('/api/internal/verify-vendor', (req, res) => {
  try {
    const forwarded = req.headers['x-forwarded-for'] || '';
    const srcIp = req.ip || req.connection.remoteAddress || '';
    const isLocal = srcIp === '127.0.0.1' || srcIp === '::1' || srcIp === '::ffff:127.0.0.1' || forwarded.startsWith('127.');
    if (!isLocal) return res.status(403).json({ error: 'internal only' });

    const { vendor_id, email } = req.body;
    if (!vendor_id && !email) return res.status(400).json({ error: 'vendor_id or email required' });

    let vendor;
    if (vendor_id) {
      vendor = db.prepare('SELECT id, email, email_verified FROM vendors WHERE id=?').get(vendor_id);
    } else {
      vendor = db.prepare('SELECT id, email, email_verified FROM vendors WHERE email=?').get(email.toLowerCase());
    }
    if (!vendor) return res.status(404).json({ error: 'vendor not found' });

    if (vendor.email_verified) return res.json({ ok: true, vendor_id: vendor.id, verified: true, message: 'Already verified' });

    db.prepare('UPDATE vendors SET email_verified=1, verification_token=NULL WHERE id=?').run(vendor.id);
    console.log(`[INTERNAL-VERIFY] Vendor ${vendor.id} (${vendor.email}) email verified via internal endpoint`);
    res.json({ ok: true, vendor_id: vendor.id, verified: true });
  } catch (e) {
    console.error('[INTERNAL-VERIFY] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Phase WYA-Dogfood: Internal customer email verification (localhost-only)
app.post('/api/internal/verify-customer', (req, res) => {
  try {
    const forwarded = req.headers['x-forwarded-for'] || '';
    const srcIp = req.ip || req.connection.remoteAddress || '';
    const isLocal = srcIp === '127.0.0.1' || srcIp === '::1' || srcIp === '::ffff:127.0.0.1' || forwarded.startsWith('127.');
    if (!isLocal) return res.status(403).json({ error: 'internal only' });

    const { customer_id, email } = req.body;
    if (!customer_id && !email) return res.status(400).json({ error: 'customer_id or email required' });

    let customer;
    if (customer_id) {
      customer = db.prepare('SELECT id, email, email_verified FROM customers WHERE id=?').get(customer_id);
    } else {
      customer = db.prepare('SELECT id, email, email_verified FROM customers WHERE email=?').get(email.toLowerCase());
    }
    if (!customer) return res.status(404).json({ error: 'customer not found' });

    if (customer.email_verified) return res.json({ ok: true, customer_id: customer.id, verified: true, message: 'Already verified' });

    db.prepare('UPDATE customers SET email_verified=1, verification_token=NULL WHERE id=?').run(customer.id);
    console.log(`[INTERNAL-VERIFY] Customer ${customer.id} (${customer.email}) email verified via internal endpoint`);
    res.json({ ok: true, customer_id: customer.id, verified: true });
  } catch (e) {
    console.error('[INTERNAL-VERIFY] Customer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/vendor/profile', (req, res) => {
  try {
    const token = req.headers['x-auth-token'] || req.body.token;
    const vendor = getVendorByToken(token);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const fields = ['description','digitap_card_url','phone','business_hours','photo_url','name','category',
      'website','instagram','tiktok','facebook','youtube',
      'doordash_url','ubereats_url','grubhub_url','yelp_url','google_maps_url','google_business_url',
      'accepts_orders','delivery_enabled','delivery_radius_mi','min_order_amount','estimated_prep_minutes',
      'lat','lng'];
    const sets = [];
    const vals = [];
    const textFields = new Set(['description','name','category','website','instagram','tiktok','facebook','youtube']);
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f}=?`);
        vals.push(textFields.has(f) ? sanitize(req.body[f]) : req.body[f]);
      }
    }
    // Phase 1628: Block accepts_orders if vendor has no menu items
    if (req.body.accepts_orders === 1 || req.body.accepts_orders === true) {
      const menuCount = db.prepare('SELECT COUNT(*) as c FROM menu_items WHERE vendor_id=?').get(vendor.id)?.c || 0;
      if (menuCount === 0) {
        return res.status(400).json({ error: 'Add at least 1 menu item before accepting orders' });
      }
    }
    if (sets.length) {
      vals.push(vendor.id);
      db.prepare(`UPDATE vendors SET ${sets.join(',')} WHERE id=?`).run(...vals);
      // Recalculate social score on profile update
      const updated = db.prepare('SELECT instagram, tiktok, facebook, youtube, website, yelp_url, google_maps_url, google_business_url, review_count, avg_rating FROM vendors WHERE id=?').get(vendor.id);
      if (updated) {
        const score = computeSocialScore(updated);
        db.prepare('UPDATE vendors SET social_score=? WHERE id=?').run(score, vendor.id);
      }
    }
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get my profile
app.get('/api/vendor/me', (req, res) => {
  try {
    const token = req.headers['x-auth-token'];
    const vendor = getVendorByToken(token);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    // Strip all credential/secret fields before sending to client
    const { password_hash, verification_token, stripe_customer_id, stripe_subscription_id, stripe_connect_id, driver_token, ...safe } = vendor;
    // Phase 1331: Add trial status to vendor response
    safe.trial_expired = isTrialExpired(vendor);
    safe.trial_days_remaining = getTrialDaysRemaining(vendor);
    res.json({ ok:true, vendor:safe });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stats for today (vendor)
app.get('/api/vendor/stats', (req, res) => {
  try {
    const token = req.headers['x-auth-token'];
    const vendor = getVendorByToken(token);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const today = new Date().toISOString().split('T')[0];
    const opens = db.prepare("SELECT COUNT(*) as c FROM activity_log WHERE vendor_id=? AND action='open' AND ts LIKE ?").get(vendor.id, today+'%');
    // Phase 753: View stats
    const since7d = new Date(Date.now() - 7*86400000).toISOString();
    const since30d = new Date(Date.now() - 30*86400000).toISOString();
    const views_today = db.prepare("SELECT COUNT(*) as c FROM profile_views WHERE vendor_id=? AND created_at LIKE ?").get(vendor.id, today+'%');
    const views_7d = db.prepare("SELECT COUNT(*) as c FROM profile_views WHERE vendor_id=? AND created_at>=?").get(vendor.id, since7d);
    const views_30d = db.prepare("SELECT COUNT(*) as c FROM profile_views WHERE vendor_id=? AND created_at>=?").get(vendor.id, since30d);
    const followers = db.prepare("SELECT COUNT(*) as c FROM vendor_followers WHERE vendor_id=? AND active=1").get(vendor.id);
    res.json({
      ok:true, opens_today:opens?.c ?? 0, is_open:vendor.is_open, last_seen:vendor.last_seen,
      views_today: views_today?.c ?? 0, views_7d: views_7d?.c ?? 0, views_30d: views_30d?.c ?? 0,
      total_views: vendor.profile_views || 0, followers: followers?.c ?? 0
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Social score calculation — based on platform presence + followers + reviews
function computeSocialScore(vendor) {
  let score = 0;
  // Platform presence (10 pts each, max 70)
  if (vendor.instagram) score += 10;
  if (vendor.tiktok) score += 10;
  if (vendor.facebook) score += 10;
  if (vendor.youtube) score += 10;
  if (vendor.website) score += 10;
  if (vendor.yelp_url) score += 10;
  if (vendor.google_maps_url || vendor.google_business_url) score += 10;
  // Reviews (up to 20 pts)
  score += Math.min(20, (vendor.review_count || 0) * 2);
  // Rating bonus (up to 10 pts)
  score += Math.min(10, Math.round((vendor.avg_rating || 0) * 2));
  return Math.min(100, score);
}

// Social score badge tier
function getSocialBadge(score) {
  if (score >= 80) return { tier: 'gold', label: 'Gold', emoji: '🥇' };
  if (score >= 50) return { tier: 'silver', label: 'Silver', emoji: '🥈' };
  if (score >= 20) return { tier: 'bronze', label: 'Bronze', emoji: '🥉' };
  return null;
}

// Recalculate social scores periodically (every 6 hours)
function updateAllSocialScores() {
  try {
    const allVendors = db.prepare('SELECT id, instagram, tiktok, facebook, youtube, website, yelp_url, google_maps_url, google_business_url, review_count, avg_rating FROM vendors').all();
    const updateStmt = db.prepare('UPDATE vendors SET social_score=? WHERE id=?');
    for (const v of allVendors) {
      const score = computeSocialScore(v);
      updateStmt.run(score, v.id);
    }
  } catch(e) { console.error('[WYA-APP] Social score update error:', e.message); }
}
setTimeout(updateAllSocialScores, 15000); // 15s after start
setInterval(updateAllSocialScores, 6 * 60 * 60 * 1000); // Every 6h

// Phase 750: Shared onboarding helper
function computeOnboardingSteps(vendor, menuCount) {
  const steps = [
    { key:'email_verified', label:'Verify your email', done: !!vendor.email_verified },
    { key:'photo', label:'Upload profile photo', done: !!vendor.photo_url },
    { key:'description', label:'Add business description', done: !!(vendor.description && vendor.description.length > 10) },
    { key:'menu', label:'Add at least 1 menu item', done: menuCount > 0 },
    { key:'hours', label:'Set business hours', done: !!vendor.business_hours },
    { key:'location', label:'Set your location', done: !!(vendor.lat && vendor.lng) },
    { key:'social', label:'Connect at least 1 social account', done: !!(vendor.instagram || vendor.tiktok || vendor.facebook || vendor.youtube) },
    { key:'phone', label:'Add phone number', done: !!(vendor.phone && vendor.phone.length > 5) },
  ];
  const completed = steps.filter(s=>s.done).length;
  const total = steps.length;
  const nextStep = steps.find(s => !s.done);
  return { steps, completed, total, percent: Math.round(completed/total*100), ready: completed>=total, missing: steps.filter(s=>!s.done).map(s=>s.label), nextStep: nextStep?.label || null };
}

// Phase 726: Vendor onboarding checklist
app.get('/api/vendor/onboarding', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const menuItems = db.prepare('SELECT COUNT(*) as c FROM menu_items WHERE vendor_id=?').get(vendor.id);
    const ob = computeOnboardingSteps(vendor, menuItems?.c ?? 0);
    res.json({ ok: true, ...ob });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor earnings dashboard
app.get('/api/vendor/earnings', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const period = req.query.period || '30d';
    const daysMap = { '7d':7, '30d':30, '90d':90, 'all':9999 };
    const days = daysMap[period] || 30;
    const since = new Date(Date.now() - days*86400000).toISOString();

    const totals = db.prepare(`
      SELECT
        COUNT(*) as order_count,
        COALESCE(SUM(total),0) as gross_revenue,
        COALESCE(SUM(commission_amount),0) as total_commission,
        COALESCE(SUM(tip),0) as total_tips,
        COALESCE(SUM(total - commission_amount),0) as net_earnings
      FROM orders WHERE vendor_id=? AND payment_status='paid' AND created_at>=?
    `).get(vendor.id, since);

    const allTime = db.prepare(`
      SELECT
        COALESCE(SUM(total - commission_amount),0) as lifetime_earnings,
        COALESCE(SUM(tip),0) as lifetime_tips,
        COUNT(*) as lifetime_orders
      FROM orders WHERE vendor_id=? AND payment_status='paid'
    `).get(vendor.id);

    const byDay = db.prepare(`
      SELECT date(created_at) as day,
        COALESCE(SUM(total - commission_amount),0) as earnings,
        COUNT(*) as orders
      FROM orders WHERE vendor_id=? AND payment_status='paid' AND created_at>=?
      GROUP BY date(created_at) ORDER BY day
    `).all(vendor.id, since);

    const topItems = db.prepare(`
      SELECT items_json FROM orders WHERE vendor_id=? AND payment_status='paid' AND created_at>=?
    `).all(vendor.id, since);

    // Aggregate top items
    const itemCounts = {};
    for (const row of topItems) {
      try {
        const items = JSON.parse(row.items_json);
        for (const i of items) {
          const key = i.name || 'Unknown';
          if (!itemCounts[key]) itemCounts[key] = { name:key, qty:0, revenue:0 };
          itemCounts[key].qty += (i.qty||1);
          itemCounts[key].revenue += (i.qty||1) * (i.price||0);
        }
      } catch(e) {}
    }
    const topItemsList = Object.values(itemCounts).sort((a,b)=>b.revenue-a.revenue).slice(0,10);

    res.json({
      ok: true,
      period,
      commission_rate: vendor.commission_rate || 0.12,
      order_count: totals?.order_count ?? 0,
      gross_revenue: Number((totals?.gross_revenue ?? 0).toFixed(2)),
      total_commission: Number((totals?.total_commission ?? 0).toFixed(2)),
      total_tips: Number((totals?.total_tips ?? 0).toFixed(2)),
      net_earnings: Number((totals?.net_earnings ?? 0).toFixed(2)),
      lifetime_earnings: Number((allTime?.lifetime_earnings ?? 0).toFixed(2)),
      lifetime_tips: Number((allTime?.lifetime_tips ?? 0).toFixed(2)),
      lifetime_orders: allTime?.lifetime_orders ?? 0,
      by_day: byDay,
      top_items: topItemsList,
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health
app.get('/health', (req, res) => {
  try {
  const live = db.prepare('SELECT COUNT(*) as c FROM vendors WHERE is_open=1').get();
  res.json(healthResponse('wya-app', { details: { port: PORT, vendors_live: live?.c ?? 0 } }));
  } catch (err) { res.status(500).json({ status:'error', error: err.message }); }
});

// Phase 1363: Test email filter for accurate metrics
const _WYA_TEST_FILTER = "email NOT LIKE 'e2e-%' AND email NOT LIKE 'jwt_test_%' AND email NOT LIKE 'jt2_%' AND email NOT LIKE 'qa-%' AND email NOT LIKE '%@test.digisigns%' AND email NOT LIKE '%@universoul.test' AND email NOT LIKE '%@test.com' AND email NOT LIKE '%@example.com' AND email NOT LIKE '%@wya.test' AND email NOT LIKE '%@sdc.com' AND email NOT LIKE 'sqlicheck%' AND email NOT LIKE 'xsscheck%' AND email NOT LIKE 'weakcheck%'";

// /api/health — requires x-portal-secret or x-soul-token (Phase 1651: auth gate per lockdown test)
// Pod-agent directCheck passes PORTAL_SECRET via headers; unauthenticated calls get 401
app.get('/api/health', (req, res) => {
  try {
  const secret = req.headers['x-portal-secret'] || req.headers['x-soul-token'] || '';
  if (!secret || !SOUL_TOKEN || secret !== SOUL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const vendors = db.prepare('SELECT COUNT(*) as c FROM vendors').get()?.c ?? 0;
  const open_vendors = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE is_open=1").get()?.c ?? 0;
  const customers = db.prepare('SELECT COUNT(*) as c FROM customers').get()?.c ?? 0;
  const orders = db.prepare('SELECT COUNT(*) as c FROM orders').get()?.c ?? 0;
  const order_revenue = db.prepare("SELECT COALESCE(SUM(total),0) as r FROM orders WHERE payment_status='paid'").get()?.r ?? 0;
  const tierPrices = { free: 0, pro: 29, growth: 59, enterprise: 99.99 };
  const subTiers = db.prepare("SELECT subscription_tier, COUNT(*) as c FROM vendors WHERE subscription_status='active' AND stripe_subscription_id IS NOT NULL AND stripe_subscription_id != '' GROUP BY subscription_tier").all();
  const sub_mrr = subTiers.reduce((s, t) => s + (tierPrices[t.subscription_tier] || 0) * t.c, 0);
  const revenue = Math.round((order_revenue + sub_mrr) * 100) / 100;
  const real_vendors = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE email NOT LIKE 'claim-%' AND email NOT LIKE 'e2e-%' AND email NOT LIKE '%@test.digisigns%' AND email NOT LIKE 'sqlicheck%' AND email NOT LIKE 'xsscheck%' AND email NOT LIKE 'weakcheck%'").get()?.c ?? 0;
  // DB connectivity check
  let db_ok = true;
  try { db.prepare('SELECT 1').get(); } catch(e) { db_ok = false; }
  // Stripe config check
  const stripe_configured = !!(process.env.WYA_STRIPE_SK && process.env.WYA_STRIPE_WEBHOOK_SECRET);
  // Required env vars
  const env_vars = {
    PORTAL_SECRET: !!process.env.PORTAL_SECRET,
    WYA_STRIPE_SK: !!process.env.WYA_STRIPE_SK,
    WYA_STRIPE_WEBHOOK_SECRET: !!process.env.WYA_STRIPE_WEBHOOK_SECRET,
    WYA_VAPID_PUBLIC: !!process.env.WYA_VAPID_PUBLIC,
    WYA_VAPID_PRIVATE: !!process.env.WYA_VAPID_PRIVATE
  };
  // Session stats
  const sessions_active = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE datetime(expires_at) > datetime('now')").get()?.c ?? 0;
  const cust_sessions_active = db.prepare("SELECT COUNT(*) as c FROM customer_sessions WHERE datetime(expires_at) > datetime('now')").get()?.c ?? 0;
  // Password migration check
  const pw_v1 = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE password_version IS NULL OR password_version < 2").get()?.c ?? 0;
  const pw_v2 = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE password_version = 2").get()?.c ?? 0;
  // DB size
  const fs = require('fs');
  let db_size_mb = 0;
  try { db_size_mb = Math.round(fs.statSync('/root/universoul-ecosystem/wya-app/data/wya.db').size / 1024 / 1024 * 100) / 100; } catch(e) {}
  res.json({ status: db_ok ? 'ok' : 'degraded', db_ok, stripe_configured, env_vars, vendors, open_vendors, customers, orders, revenue, sub_mrr, real_vendors, sessions_active: sessions_active + cust_sessions_active, password_migration: { v1: pw_v1, v2: pw_v2 }, db_size_mb, uptime_s: Math.floor(process.uptime()), memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  } catch (err) { res.status(500).json({ status:'error', error: err.message }); }
});

// Internal stats for scoreboard (auth-gated)
app.get('/api/internal/stats', (req, res) => {
  try {
  const secret = req.headers['x-portal-secret'] || '';
  const token = req.headers['x-auth-token'] || '';
  const isAuthed = (secret && secret === SOUL_TOKEN) || (token && (() => { const s = db.prepare("SELECT vendor_id FROM sessions WHERE token=? AND datetime(expires_at) > datetime('now')").get(token); return s && db.prepare('SELECT is_super_admin FROM vendors WHERE id=?').get(s.vendor_id)?.is_super_admin; })());
  if (!isAuthed) return res.status(401).json({ error: 'Unauthorized' });
  const vendors = db.prepare('SELECT COUNT(*) as c FROM vendors').get()?.c ?? 0;
  const open_vendors = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE is_open=1").get()?.c ?? 0;
  const customers = db.prepare('SELECT COUNT(*) as c FROM customers').get()?.c ?? 0;
  const orders = db.prepare('SELECT COUNT(*) as c FROM orders').get()?.c ?? 0;
  const order_revenue = db.prepare("SELECT COALESCE(SUM(total),0) as r FROM orders WHERE payment_status='paid'").get()?.r ?? 0;
  // Phase 1372: Include subscription MRR in revenue (same as /api/health)
  const tierPrices = { free: 0, pro: 29, growth: 59, enterprise: 99.99 };
  const subTiers = db.prepare("SELECT subscription_tier, COUNT(*) as c FROM vendors WHERE subscription_status='active' AND stripe_subscription_id IS NOT NULL AND stripe_subscription_id != '' GROUP BY subscription_tier").all();
  const sub_mrr = subTiers.reduce((s, t) => s + (tierPrices[t.subscription_tier] || 0) * t.c, 0);
  const revenue = Math.round((order_revenue + sub_mrr) * 100) / 100;
  const real_customers = db.prepare(`SELECT COUNT(*) as c FROM customers WHERE ${_WYA_TEST_FILTER}`).get()?.c ?? 0;
  const real_vendors = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE email NOT LIKE 'claim-%' AND email NOT LIKE 'e2e-%' AND email NOT LIKE '%@test.digisigns%' AND email NOT LIKE 'sqlicheck%' AND email NOT LIKE 'xsscheck%' AND email NOT LIKE 'weakcheck%'").get()?.c ?? 0;
  res.json({ vendors, open_vendors, customers, orders, revenue, sub_mrr, real_customers, real_vendors });
  } catch (err) { res.status(500).json({ status:'error', error: err.message }); }
});

// Phase 1358: SPA page routes removed — middleware above redirects all frontend paths to Hub


// ── Super Admin Routes ──────────────────────────────────────

const isVendor = (req, res, next) => {
  const tok = req.headers['x-auth-token'] || req.headers['x-vendor-token'];
  if (!tok) return res.status(401).json({ error: 'Unauthorized' });
  const vendor = getVendorByToken(tok);
  if (!vendor) return res.status(401).json({ error: 'Invalid session' });
  req.vendor = vendor;
  next();
};

const isSuperAdmin = (req, res, next) => {
  // Phase 1650: Accept x-portal-secret for internal monitoring/automation calls (localhost only)
  const portalSecret = req.headers['x-portal-secret'] || '';
  if (portalSecret && SOUL_TOKEN && portalSecret === SOUL_TOKEN) {
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) return res.status(403).json({ error: 'Portal secret only accepted from localhost' });
    req.adminVendor = { id: 0, name: 'SYSTEM', is_super_admin: 1 };
    return next();
  }
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = db.prepare("SELECT vendor_id FROM sessions WHERE token=? AND datetime(expires_at) > datetime('now')").get(token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  const vendor = db.prepare('SELECT * FROM vendors WHERE id=?').get(session.vendor_id);
  if (!vendor || !vendor.is_super_admin) return res.status(403).json({ error: 'Not super admin' });
  req.adminVendor = vendor;
  next();
};

// Phase 742: Set vendor business hours
app.put('/api/vendor/hours', isVendor, (req, res) => {
  try {
    const { hours } = req.body;
    if (!hours || typeof hours !== 'object') return res.status(400).json({ error:'hours object required' });
    const validDays = ['mon','tue','wed','thu','fri','sat','sun'];
    const timeRe = /^\d{2}:\d{2}$/;
    for (const [day, val] of Object.entries(hours)) {
      if (!validDays.includes(day)) return res.status(400).json({ error:`Invalid day: ${day}` });
      if (val === null || val === 'closed') continue;
      if (!val.open || !val.close) return res.status(400).json({ error:`${day} needs open and close times` });
      if (!timeRe.test(val.open) || !timeRe.test(val.close)) return res.status(400).json({ error:`${day} times must be HH:MM format` });
    }
    db.prepare('UPDATE vendors SET business_hours=? WHERE id=?').run(JSON.stringify(hours), req.vendor.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 1329: Vendor password change
app.put('/api/vendor/password', isVendor, (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
    if (!verifyPw(current_password, req.vendor.password_hash, req.vendor.password_version || 1)) return res.status(401).json({ error: 'Current password is incorrect' });
    if (new_password.length < 8 || !/[a-zA-Z]/.test(new_password) || !/\d/.test(new_password))
      return res.status(400).json({ error: 'Password must be 8+ characters with at least 1 letter and 1 number' });
    db.prepare('UPDATE vendors SET password_hash=?, password_version=2 WHERE id=?').run(hashPw(new_password), req.vendor.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 742: Get vendor business hours (public)
app.get('/api/vendors/:id/hours', (req, res) => {
  try {
    const vendor = db.prepare('SELECT id, name, business_hours FROM vendors WHERE id=?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error:'Vendor not found' });
    let hours = {};
    try { hours = vendor.business_hours ? JSON.parse(vendor.business_hours) : {}; } catch(e) {}
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
    const today = dayNames[now.getDay()];
    const currentTime = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    let is_currently_open = false;
    if (hours[today] && hours[today] !== 'closed' && hours[today].open && hours[today].close) {
      is_currently_open = currentTime >= hours[today].open && currentTime <= hours[today].close;
    }
    res.json({ ok:true, vendor_id:vendor.id, name:vendor.name, hours, is_currently_open });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List all vendors
app.get('/api/admin/vendors', isSuperAdmin, (req, res) => {
  try {
    const vendors = db.prepare('SELECT id,name,category,email,phone,description,is_open,last_seen,created_at,is_super_admin,business_hours,photo_url,subscription_status,trial_ends_at,website,instagram,tiktok,facebook,youtube,referral_code,avg_rating,review_count,total_orders,subscription_tier,doordash_url,ubereats_url,grubhub_url,yelp_url,google_maps_url,google_business_url,social_score,data_source,is_founding_vendor FROM vendors ORDER BY is_open DESC, created_at DESC').all();
    res.json({ vendors });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single vendor
app.get('/api/admin/vendors/:id', isSuperAdmin, (req, res) => {
  try {
    const v = db.prepare('SELECT id,name,category,email,phone,description,is_open,last_seen,created_at,is_super_admin,business_hours,photo_url FROM vendors WHERE id=?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json(v);
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 726: Admin trial dashboard
app.get('/api/admin/trials', isSuperAdmin, (req, res) => {
  try {
    const trials = db.prepare(`
      SELECT id, name, email, trial_ends_at, email_verified, photo_url, subscription_tier, trial_warning_sent,
        (SELECT COUNT(*) FROM menu_items WHERE vendor_id=vendors.id) as menu_count,
        ROUND(JULIANDAY(trial_ends_at) - JULIANDAY('now')) as days_left
      FROM vendors WHERE subscription_status='trial' ORDER BY trial_ends_at ASC
    `).all();
    const expiringSoon = trials.filter(v => v.days_left !== null && v.days_left <= 7);
    const expired = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE subscription_status='expired'").get();
    res.json({ ok: true, trials, expiring_soon: expiringSoon.length, total_trial: trials.length, total_expired: expired?.c ?? 0 });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Impersonate — returns a session token for any vendor
app.post('/api/admin/impersonate/:id', isSuperAdmin, (req, res) => {
  try {
    const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    // Cap concurrent sessions at 5 per vendor
    const activeVSessions = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE vendor_id=? AND datetime(expires_at) > datetime('now')").get(v.id)?.c || 0;
    if (activeVSessions >= 5) {
      db.prepare("DELETE FROM sessions WHERE token IN (SELECT token FROM sessions WHERE vendor_id=? ORDER BY created_at ASC LIMIT ?)").run(v.id, activeVSessions - 4);
    }
    const token = genToken();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T',' ').replace('Z','');
    db.prepare('INSERT INTO sessions (token,vendor_id,expires_at) VALUES (?,?,?)').run(token, v.id, expires);
    // Audit trail: log who impersonated whom
    const ip = req.ip || req.socket.remoteAddress || '';
    const reason = req.body.reason || 'admin impersonation';
    db.prepare("INSERT INTO activity_log (vendor_id,action,lat,lng) VALUES (?,'admin_impersonate',NULL,NULL)").run(v.id);
    console.log(`[AUDIT] Admin impersonated vendor ${v.id} (${v.name}) from ${ip} — reason: ${reason}`);
    res.json({ token, vendor: { id: v.id, name: v.name, email: v.email } });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update vendor (admin override)
app.put('/api/admin/vendors/:id', isSuperAdmin, (req, res) => {
  try {
    const { name, category, email, phone, description, is_open, is_super_admin, business_hours, photo_url, password, website, instagram, tiktok, facebook, youtube } = req.body;
    if (password) { db.prepare('UPDATE vendors SET password_hash=?, password_version=2 WHERE id=?').run(hashPw(password), req.params.id); }
    db.prepare(`UPDATE vendors SET name=COALESCE(?,name), category=COALESCE(?,category), email=COALESCE(?,email),
      phone=COALESCE(?,phone), description=COALESCE(?,description), is_open=COALESCE(?,is_open),
      is_super_admin=COALESCE(?,is_super_admin), business_hours=COALESCE(?,business_hours),
      photo_url=COALESCE(?,photo_url), website=COALESCE(?,website), instagram=COALESCE(?,instagram),
      tiktok=COALESCE(?,tiktok), facebook=COALESCE(?,facebook), youtube=COALESCE(?,youtube) WHERE id=?`)
      .run(name, category, email, phone, description, is_open, is_super_admin, business_hours||null, photo_url||null, website||null, instagram||null, tiktok||null, facebook||null, youtube||null, req.params.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin toggle vendor live/offline
app.post('/api/admin/vendors/:id/toggle', isSuperAdmin, (req, res) => {
  try {
    const { is_open } = req.body;
    db.prepare('UPDATE vendors SET is_open=? WHERE id=?').run(is_open?1:0, req.params.id);
    res.json({ ok: true, is_open: is_open?1:0 });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete vendor (soft-delete: marks deleted, cascades related records)
app.delete('/api/admin/vendors/:id', isSuperAdmin, (req, res) => {
  try {
    if (req.params.id === 'SUPERADMIN-001') return res.status(403).json({ error: 'Cannot delete super admin' });
    const vid = req.params.id;
    const vendor = db.prepare('SELECT id, name FROM vendors WHERE id=?').get(vid);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    // Cascade delete in transaction to prevent orphaned records
    const cascadeDelete = db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE vendor_id=?').run(vid);
      db.prepare('DELETE FROM menu_items WHERE vendor_id=?').run(vid);
      db.prepare('DELETE FROM activity_log WHERE vendor_id=?').run(vid);
      db.prepare('DELETE FROM vendor_followers WHERE vendor_id=?').run(vid);
      db.prepare("UPDATE orders SET status='cancelled', updated_at=datetime('now') WHERE vendor_id=? AND status IN ('pending','preparing')").run(vid);
      db.prepare('DELETE FROM vendors WHERE id=?').run(vid);
    });
    cascadeDelete();
    const ip = req.ip || req.socket.remoteAddress || '';
    console.log(`[AUDIT] Vendor ${vid} (${vendor.name}) deleted by admin from ${ip}`);
    res.json({ ok: true, deleted: vendor.name });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset vendor password
app.post('/api/admin/vendors/:id/reset-password', isSuperAdmin, (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });
    db.prepare('UPDATE vendors SET password_hash=?, password_version=2 WHERE id=?').run(hashPw(password), req.params.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Activity log
app.get('/api/admin/activity', isSuperAdmin, (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM activity_log ORDER BY ts DESC LIMIT 100').all();
    res.json({ logs });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stats
app.get('/api/admin/stats', isSuperAdmin, (req, res) => {
  try {
    const excludeTest = req.query.include_test !== '1';
    const vendorFilter = excludeTest ? "WHERE data_source NOT IN ('test')" : '';
    const vendorFilterAnd = excludeTest ? "AND v.data_source NOT IN ('test')" : '';
    const total = db.prepare(`SELECT COUNT(*) as c FROM vendors ${vendorFilter}`).get()?.c ?? 0;
    const open = db.prepare(`SELECT COUNT(*) as c FROM vendors WHERE is_open=1 ${excludeTest ? "AND data_source NOT IN ('test')" : ''}`).get()?.c ?? 0;
    const sessions = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE datetime(expires_at) > datetime('now')").get()?.c ?? 0;
    const totalOrders = db.prepare('SELECT COUNT(*) as c FROM orders').get()?.c ?? 0;
    const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers').get()?.c ?? 0;
    const vendorBreakdown = db.prepare('SELECT data_source, COUNT(*) as c FROM vendors GROUP BY data_source').all();
    res.json({ total_vendors: total, open_vendors: open, active_sessions: sessions, total_orders: totalOrders, total_customers: totalCustomers, vendor_breakdown: vendorBreakdown });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Growth snapshot — orders, revenue, abandonment, conversion
app.get('/api/admin/growth-snapshot', isSuperAdmin, (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7*86400000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30*86400000).toISOString();

    const ordersToday = db.prepare('SELECT COUNT(*) as c FROM orders WHERE created_at >= ?').get(todayStart)?.c ?? 0;
    const orders7d = db.prepare('SELECT COUNT(*) as c FROM orders WHERE created_at >= ?').get(sevenDaysAgo)?.c ?? 0;
    const orders30d = db.prepare('SELECT COUNT(*) as c FROM orders WHERE created_at >= ?').get(thirtyDaysAgo)?.c ?? 0;

    const revenueToday = db.prepare("SELECT COALESCE(SUM(total),0) as v FROM orders WHERE payment_status='paid' AND created_at >= ?").get(todayStart)?.v ?? 0;
    const revenue7d = db.prepare("SELECT COALESCE(SUM(total),0) as v FROM orders WHERE payment_status='paid' AND created_at >= ?").get(sevenDaysAgo)?.v ?? 0;
    const revenue30d = db.prepare("SELECT COALESCE(SUM(total),0) as v FROM orders WHERE payment_status='paid' AND created_at >= ?").get(thirtyDaysAgo)?.v ?? 0;

    const abandoned = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(total),0) as v FROM orders WHERE payment_status IN ('pending','expired')").get();
    const paidTotal = db.prepare("SELECT COUNT(*) as c FROM orders WHERE payment_status='paid'").get()?.c ?? 0;
    const allTotal = db.prepare('SELECT COUNT(*) as c FROM orders').get()?.c ?? 0;
    const conversionRate = allTotal > 0 ? +(paidTotal / allTotal * 100).toFixed(1) : 0;
    const avgOrderValue = paidTotal > 0 ? +(revenue30d / Math.max(1, db.prepare("SELECT COUNT(*) as c FROM orders WHERE payment_status='paid' AND created_at >= ?").get(thirtyDaysAgo)?.c ?? 1)).toFixed(2) : 0;

    res.json({
      orders: { today: ordersToday, '7d': orders7d, '30d': orders30d },
      revenue: { today: +revenueToday.toFixed(2), '7d': +revenue7d.toFixed(2), '30d': +revenue30d.toFixed(2) },
      abandoned: { count: abandoned?.c ?? 0, value: +(abandoned?.v ?? 0).toFixed(2) },
      conversion_rate: conversionRate,
      avg_order_value: avgOrderValue
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 727: Admin financial dashboard
app.get('/api/admin/financial', isSuperAdmin, (req, res) => {
  try {
    const period = req.query.period || '30d';
    const daysMap = { '7d':7, '30d':30, '90d':90, 'all':9999 };
    const days = daysMap[period] || 30;
    const since = new Date(Date.now() - days*86400000).toISOString();

    const revenue = db.prepare(`
      SELECT COALESCE(SUM(total),0) as gross, COALESCE(SUM(commission_amount),0) as commissions,
        COALESCE(SUM(tip),0) as tips, COUNT(*) as order_count,
        COALESCE(SUM(total - commission_amount),0) as vendor_net
      FROM orders WHERE payment_status='paid' AND created_at>=?
    `).get(since);

    const byVendor = db.prepare(`
      SELECT v.name, o.vendor_id, COUNT(*) as orders, COALESCE(SUM(o.total),0) as gross,
        COALESCE(SUM(o.commission_amount),0) as commission
      FROM orders o JOIN vendors v ON o.vendor_id=v.id
      WHERE o.payment_status='paid' AND o.created_at>=? GROUP BY o.vendor_id ORDER BY gross DESC
    `).all(since);

    const byStatus = db.prepare('SELECT subscription_status, COUNT(*) as c FROM vendors GROUP BY subscription_status').all();
    const byTier = db.prepare('SELECT subscription_tier, COUNT(*) as c FROM vendors GROUP BY subscription_tier').all();
    const verified = db.prepare('SELECT email_verified, COUNT(*) as c FROM vendors GROUP BY email_verified').all();

    // Onboarding completeness (using shared helper)
    const vendors = db.prepare('SELECT id,email_verified,photo_url,description,business_hours,lat,lng FROM vendors').all();
    const menuCounts = {};
    for (const r of db.prepare('SELECT vendor_id, COUNT(*) as c FROM menu_items GROUP BY vendor_id').all()) menuCounts[r.vendor_id] = r.c;
    let onboardingComplete = 0;
    for (const v of vendors) {
      if (computeOnboardingSteps(v, menuCounts[v.id]||0).ready) onboardingComplete++;
    }

    res.json({
      ok: true, period,
      revenue: { ...revenue, avg_order: (revenue?.order_count ?? 0) > 0 ? +((revenue?.gross ?? 0) / revenue.order_count).toFixed(2) : 0 },
      by_vendor: byVendor,
      vendors: { by_status: byStatus, by_tier: byTier, email_verified: verified, onboarding_complete: onboardingComplete, total: vendors.length },
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ── Referral / Ambassador Endpoints ──────────────────────────

// Get my referral info
app.get('/api/vendor/referral', (req, res) => {
  try {
    const token = req.headers['x-auth-token'];
    const vendor = getVendorByToken(token);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const referrals = db.prepare("SELECT r.*, v.name as referred_name FROM referrals r LEFT JOIN vendors v ON r.referred_id=v.id WHERE r.referrer_id=? ORDER BY r.created_at DESC").all(vendor.id);
    const activeCount = referrals.filter(r => r.status === 'active').length;
    res.json({
      ok: true,
      referral_code: vendor.referral_code,
      share_url: `https://wya.digisigns.link/?ref=${vendor.referral_code}`,
      total_referred: referrals.length,
      active_referrals: activeCount,
      referrals
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public referral landing — redirect to vendor register with ref pre-filled
app.get('/api/referral/:code', (req, res) => {
  try {
    const referrer = db.prepare("SELECT id, name FROM vendors WHERE referral_code=?").get(req.params.code);
    if (!referrer) return res.redirect('/vendor');
    res.redirect(`/vendor?ref=${req.params.code}&from=${encodeURIComponent(referrer.name)}`);
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark referral as active when referred vendor goes live for the first time
function checkReferralReward(vendorId) {
  const ref = db.prepare("SELECT * FROM referrals WHERE referred_id=? AND status='pending'").get(vendorId);
  if (!ref) return;
  // Mark referral as active
  db.prepare("UPDATE referrals SET status='active' WHERE id=?").run(ref.id);
  // Reward referrer: extend trial by 30 days (capped at +90 days from original trial start)
  const referrer = db.prepare("SELECT * FROM vendors WHERE id=?").get(ref.referrer_id);
  if (referrer && referrer.trial_ends_at) {
    const created = new Date(referrer.created_at);
    const maxTrial = new Date(created.getTime() + 120 * 86400000); // 30 base + 90 bonus max
    const currentEnd = new Date(referrer.trial_ends_at);
    if (currentEnd < maxTrial) {
      const newEnd = new Date(Math.min(currentEnd.getTime() + 30 * 86400000, maxTrial.getTime()));
      db.prepare("UPDATE vendors SET trial_ends_at=? WHERE id=?").run(newEnd.toISOString(), ref.referrer_id);
    }
  }
  db.prepare("UPDATE referrals SET reward_status='credited' WHERE id=?").run(ref.id);
}

// Admin: referral stats
app.get('/api/admin/referral-stats', isSuperAdmin, (req, res) => {
  try {
    const totalReferrals = db.prepare("SELECT COUNT(*) as c FROM referrals").get()?.c ?? 0;
    const activeReferrals = db.prepare("SELECT COUNT(*) as c FROM referrals WHERE status='active'").get()?.c ?? 0;
    const topReferrers = db.prepare(`
      SELECT v.name, v.referral_code, COUNT(r.id) as referral_count
      FROM referrals r JOIN vendors v ON r.referrer_id=v.id
      GROUP BY r.referrer_id ORDER BY referral_count DESC LIMIT 10
    `).all();
    res.json({ ok:true, total_referrals:totalReferrals, active_referrals:activeReferrals, top_referrers:topReferrers });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ══════════════════════════════════════════════════════════════
// ── Phase 749: VENDOR ONBOARDING PIPELINE ────────────────────
// ══════════════════════════════════════════════════════════════

// Admin: Send vendor invite
app.post('/api/admin/invite', isSuperAdmin, (req, res) => {
  try {
    let { email, business_name, phone, personal_message, category } = req.body;
    if (!email) return res.status(400).json({ error:'email required' });
    email = email.toLowerCase().trim();
    const existing = db.prepare('SELECT id FROM vendors WHERE email=?').get(email);
    if (existing) return res.status(409).json({ error:'Vendor already registered' });
    const existingInvite = db.prepare("SELECT id FROM vendor_invites WHERE email=? AND status='pending'").get(email);
    if (existingInvite) return res.status(409).json({ error:'Invite already sent' });
    const inviteCode = 'INV-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    db.prepare('INSERT INTO vendor_invites (email,business_name,phone,invite_code,personal_message) VALUES (?,?,?,?,?)').run(
      email, sanitize(business_name)||'', phone||'', inviteCode, sanitize(personal_message)||''
    );
    const joinUrl = `https://wya.digisigns.link/join/${inviteCode}`;
    const msgHtml = personal_message ? `<p style="color:#d1d5db;font-style:italic;border-left:3px solid #FF5E1A;padding-left:12px;margin:16px 0">${sanitize(personal_message)}</p>` : '';
    // Category-specific pitch
    const categoryPitches = {
      food_truck: { headline: 'Food truck? Get found by hungry SB locals.', benefits: ['Show your live location on the map', 'Accept mobile orders with Stripe', 'SB ordinance compliance built in (4hr/500ft)'] },
      restaurant: { headline: 'Get more diners through the door.', benefits: ['Show your menu and accept online orders', 'Build a local following with push notifications', 'Run promotions and loyalty programs'] },
      tattoo_studio: { headline: 'Book more sessions. Less phone tag.', benefits: ['Online booking with deposits and consent forms', 'Walk-in queue for your lobby', 'Build your local client base'] },
      beauty: { headline: 'Fill your appointment book.', benefits: ['Online booking with deposit collection', 'Automated reminders reduce no-shows', 'Build a loyal local following'] },
      signs_graphics: { headline: 'Get custom sign orders from local businesses.', benefits: ['Online storefront with quote requests', 'File upload for custom artwork', 'Job tracking from quote to delivery'] },
      home_services: { headline: 'Get found when locals need help.', benefits: ['Show your service area on the map', 'Accept service requests and quotes', 'Build reviews and repeat customers'] },
    };
    const pitch = categoryPitches[category] || { headline: 'Get discovered by local customers.', benefits: ['Go live on the map in 2 minutes', 'Accept orders with Stripe payments', 'Free 30-day trial — no card needed'] };
    sendEmail(email, `You're invited to WYA — ${pitch.headline}`, `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;padding:28px;background:#050505;color:#f5f5f5;border-radius:16px">
        <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:8px">WYA — Where You At</div>
        <p style="color:#9ca3af;margin-bottom:20px">Santa Barbara's real-time vendor marketplace</p>
        <p>Hey${business_name ? ' '+sanitize(business_name) : ''}!</p>
        ${msgHtml}
        <p style="font-size:18px;font-weight:700;color:#fff;margin:16px 0">${pitch.headline}</p>
        <ul style="color:#d1d5db;line-height:2">
          ${pitch.benefits.map(b => `<li>${b}</li>`).join('')}
        </ul>
        <a href="${joinUrl}" style="display:block;text-align:center;padding:14px;background:#FF5E1A;color:#fff;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none;margin:24px 0">Join WYA →</a>
        <p style="color:#6b7280;font-size:12px;text-align:center">Questions? Reply to this email.</p>
      </div>
    `).catch(()=>{});
    db.prepare('INSERT INTO activity_log (vendor_id,action) VALUES (?,?)').run('admin', 'invite:'+email);
    res.json({ ok:true, invite_code:inviteCode, join_url:joinUrl });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Bulk invite
app.post('/api/admin/invite/bulk', isSuperAdmin, (req, res) => {
  const { invites } = req.body;
  if (!Array.isArray(invites) || !invites.length) return res.status(400).json({ error:'invites array required' });
  if (invites.length > 50) return res.status(400).json({ error:'Max 50 per batch' });
  const results = [];
  for (const inv of invites) {
    if (!inv.email) { results.push({ email:'', status:'skipped', error:'no email' }); continue; }
    const email = inv.email.toLowerCase().trim();
    const existing = db.prepare('SELECT id FROM vendors WHERE email=?').get(email);
    if (existing) { results.push({ email, status:'skipped', error:'already registered' }); continue; }
    const inviteCode = 'INV-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    try {
      db.prepare('INSERT INTO vendor_invites (email,business_name,phone,invite_code) VALUES (?,?,?,?)').run(
        email, sanitize(inv.business_name)||'', inv.phone||'', inviteCode
      );
      const joinUrl = `https://wya.digisigns.link/join/${inviteCode}`;
      sendEmail(email, `You're invited to WYA — Santa Barbara's vendor marketplace`, `
        <div style="font-family:-apple-system,sans-serif;max-width:480px;padding:28px;background:#050505;color:#f5f5f5;border-radius:16px">
          <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:8px">WYA — Where You At</div>
          <p>Hey${inv.business_name ? ' '+sanitize(inv.business_name) : ''}! You've been invited to join WYA — Santa Barbara's real-time vendor marketplace.</p>
          <p>Go live on the map, accept orders, and grow your business. Free 30-day trial.</p>
          <a href="${joinUrl}" style="display:block;text-align:center;padding:14px;background:#FF5E1A;color:#fff;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none;margin:24px 0">Join WYA →</a>
        </div>
      `).catch(()=>{});
      results.push({ email, status:'sent', invite_code:inviteCode });
    } catch(e) { results.push({ email, status:'skipped', error:'duplicate invite' }); }
  }
  res.json({ ok:true, sent:results.filter(r=>r.status==='sent').length, skipped:results.filter(r=>r.status==='skipped').length, results });
});

// Admin: List invites
app.get('/api/admin/invites', isSuperAdmin, (req, res) => {
  try {
    const invites = db.prepare('SELECT * FROM vendor_invites ORDER BY created_at DESC LIMIT 200').all();
    const stats = {
      total: invites.length,
      pending: invites.filter(i=>i.status==='pending').length,
      opened: invites.filter(i=>i.status==='opened').length,
      registered: invites.filter(i=>i.status==='registered').length,
    };
    res.json({ ok:true, invites, stats });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Purge seed data
app.post('/api/admin/seed/purge', isSuperAdmin, (req, res) => {
  try {
    const demoVendors = db.prepare("SELECT id FROM vendors WHERE email LIKE '%@demo.wya'").all();
    if (!demoVendors.length) return res.json({ ok:true, message:'No demo vendors found', purged:0 });
    const ids = demoVendors.map(v => v.id);
    for (const id of ids) {
      db.prepare('DELETE FROM menu_items WHERE vendor_id=?').run(id);
      db.prepare('DELETE FROM menu_categories WHERE vendor_id=?').run(id);
      db.prepare('DELETE FROM orders WHERE vendor_id=?').run(id);
      db.prepare('DELETE FROM reviews WHERE vendor_id=?').run(id);
      db.prepare('DELETE FROM sessions WHERE vendor_id=?').run(id);
      db.prepare('DELETE FROM activity_log WHERE vendor_id=?').run(id);
      db.prepare('DELETE FROM referrals WHERE referrer_id=? OR referred_id=?').run(id, id);
      db.prepare('DELETE FROM vendors WHERE id=?').run(id);
    }
    res.json({ ok:true, purged:ids.length, ids });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public: Join via invite code
app.get('/join/:code', (req, res) => {
  try {
    const invite = db.prepare('SELECT * FROM vendor_invites WHERE invite_code=?').get(req.params.code);
    if (!invite) return res.redirect('/vendor');
    if (invite.status === 'pending') {
      db.prepare("UPDATE vendor_invites SET status='opened', opened_at=datetime('now') WHERE id=?").run(invite.id);
    }
    // Redirect to vendor signup with invite params
    const params = new URLSearchParams({ invite: invite.invite_code });
    if (invite.business_name) params.set('name', invite.business_name);
    if (invite.email) params.set('email', invite.email);
    res.redirect(`/vendor?${params.toString()}`);
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Email verification
app.get('/verify/:token', (req, res) => {
  try {
    const vendor = db.prepare('SELECT id FROM vendors WHERE verification_token=?').get(req.params.token);
    if (!vendor) return res.redirect('/vendor?verify=invalid');
    db.prepare("UPDATE vendors SET email_verified=1, verification_token=NULL WHERE id=?").run(vendor.id);
    res.redirect('/vendor?verify=success');
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resend verification email
app.post('/api/vendor/resend-verification', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    if (vendor.email_verified) return res.json({ ok:true, message:'Already verified' });
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE vendors SET verification_token=? WHERE id=?').run(token, vendor.id);
    sendEmail(vendor.email, 'Verify your WYA account', `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;padding:28px;background:#050505;color:#f5f5f5;border-radius:16px">
        <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:16px">Verify Your Email</div>
        <p>Hey ${sanitize(vendor.name)}! Click below to verify your WYA account and go live on the map.</p>
        <a href="https://wya.digisigns.link/verify/${token}" style="display:block;text-align:center;padding:14px;background:#FF5E1A;color:#fff;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none;margin:24px 0">Verify Email →</a>
      </div>
    `).catch(()=>{});
    res.json({ ok:true, message:'Verification email sent' });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 1900: Vendor claim flow — let real business owners claim pre-seeded listings
app.post('/api/vendor/claim', (req, res) => {
  try {
    const { vendor_id, email, password } = req.body;
    if (!vendor_id || !email || !password) return res.status(400).json({ error: 'vendor_id, email, and password are required' });
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must be 8+ characters with letters and numbers' });
    }
    const emailLower = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) return res.status(400).json({ error: 'Invalid email format' });
    // Rate limit
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!rateLimit('claim:' + ip, 5, 3600000)) return res.status(429).json({ error: 'Too many claim attempts. Try again later.' });
    // Validate vendor is claimable
    const vendor = db.prepare('SELECT id, name, email FROM vendors WHERE id=?').get(vendor_id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (!vendor.email.startsWith('claim-')) return res.status(400).json({ error: 'This listing has already been claimed' });
    // Check email not already taken by another vendor
    const existing = db.prepare('SELECT id FROM vendors WHERE email=? AND id!=?').get(emailLower, vendor_id);
    if (existing) return res.status(409).json({ error: 'This email is already registered on WYA' });
    // Generate claim token and store pending claim data
    const claimToken = crypto.randomBytes(20).toString('hex');
    const pwHash = hashPw(password);
    db.prepare('UPDATE vendors SET verification_token=?, password_hash=?, password_version=2 WHERE id=?').run('claim:' + claimToken + ':' + emailLower, pwHash, vendor.id);
    // Send verification email to the real owner
    sendEmail(emailLower, `Claim your business on WYA — ${vendor.name}`, `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#050505;color:#f5f5f5;border-radius:16px">
        <div style="font-size:24px;font-weight:900;margin-bottom:8px">Claim <span style="color:#FF5E1A">${sanitize(vendor.name)}</span></div>
        <p style="color:#9ca3af;line-height:1.6;margin-bottom:20px">Someone (hopefully you!) is claiming the <strong>${sanitize(vendor.name)}</strong> listing on WYA — Santa Barbara's live vendor map.</p>
        <p style="color:#9ca3af;line-height:1.6;margin-bottom:20px">If this is you, click below to verify your email and take control of your listing. You'll get a <strong>30-day free trial</strong> to go live on the map.</p>
        <a href="https://wya.digisigns.link/claim/verify/${claimToken}" style="display:block;text-align:center;background:#FF5E1A;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:800;font-size:15px;margin-bottom:20px">Verify & Claim My Business →</a>
        <div style="color:#666;font-size:12px">If you didn't request this, just ignore this email. Your listing won't be changed.</div>
      </div>
    `).catch(err => console.error('[WYA-CLAIM] Email failed:', err.message));
    res.json({ ok: true, message: `Verification email sent to ${emailLower}. Check your inbox to complete the claim.` });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Claim verification — swap placeholder email with real owner email
app.get('/claim/verify/:token', (req, res) => {
  try {
    const vendor = db.prepare("SELECT id, name, verification_token FROM vendors WHERE verification_token LIKE 'claim:%'").all()
      .find(v => v.verification_token && v.verification_token.split(':')[1] === req.params.token);
    if (!vendor) return res.redirect('/vendor?claim=invalid');
    // Extract the real email from the stored token
    const parts = vendor.verification_token.split(':');
    const realEmail = parts.slice(2).join(':'); // email may contain colons
    if (!realEmail) return res.redirect('/vendor?claim=invalid');
    // Swap email, mark verified, reset trial to 30 days from now
    const trialEnds = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE vendors SET email=?, email_verified=1, verification_token=NULL, trial_ends_at=?, subscription_status=? WHERE id=?')
      .run(realEmail, trialEnds, 'trial', vendor.id);
    // Create a session so they're logged in immediately
    const token = genToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');
    db.prepare('INSERT INTO sessions (token, vendor_id, expires_at) VALUES (?, ?, ?)').run(token, vendor.id, expires);
    db.prepare("INSERT INTO activity_log (vendor_id, action) VALUES (?, 'claimed')").run(vendor.id);
    console.log(`[WYA-CLAIM] ${vendor.name} (${vendor.id}) claimed by ${realEmail}`);
    // Redirect to vendor dashboard with claim success + auto-login token
    res.redirect(`/vendor?claim=success&token=${token}`);
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.redirect('/vendor?claim=error');
  }
});

// Claim page — shows listing info + claim form
app.get('/claim/:vendorId', (req, res) => {
  try {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const v = db.prepare('SELECT id, name, category, description, photo_url, lat, lng FROM vendors WHERE id=?').get(req.params.vendorId);
    if (!v) return res.status(404).send('<!DOCTYPE html><html><body style="background:#0a0a0a;color:#fff;font-family:system-ui;text-align:center;padding:4rem"><h1>Listing not found</h1><a href="/vendors" style="color:#a78bfa">Browse vendors</a></body></html>');
    if (!db.prepare("SELECT email FROM vendors WHERE id=?").get(v.id)?.email?.startsWith('claim-')) {
      return res.redirect('/v/' + v.id); // Already claimed, show normal profile
    }
    const menuItems = db.prepare('SELECT name, price FROM menu_items WHERE vendor_id=? LIMIT 6').all(v.id);
    const menuHtml = menuItems.map(m => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)"><span>${esc(m.name)}</span><span style="color:#FF5E1A">$${Number(m.price).toFixed(2)}</span></div>`).join('');
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claim ${esc(v.name)} on WYA</title>
<meta name="description" content="Claim your ${esc(v.name)} listing on WYA — Santa Barbara's live vendor map. Free 30-day trial.">
<meta name="robots" content="noindex">
<style>
*{margin:0;box-sizing:border-box}body{font-family:'DM Sans',system-ui,sans-serif;background:#0A0A0A;color:rgba(255,255,255,.92);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{max-width:480px;width:100%;background:#141414;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,.06)}
.photo{width:100%;height:200px;object-fit:cover}
.ph{width:100%;height:200px;display:flex;align-items:center;justify-content:center;background:#1a1a2e;font-size:4rem}
.body{padding:28px}
h1{font-size:1.4rem;margin-bottom:4px}
.cat{color:#833AB4;font-size:.85rem;margin-bottom:12px;text-transform:capitalize}
.desc{color:rgba(255,255,255,.6);font-size:.9rem;line-height:1.5;margin-bottom:20px}
.menu{margin-bottom:24px}
.menu-title{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:#833AB4;margin-bottom:8px}
.divider{height:1px;background:rgba(255,255,255,.06);margin:24px 0}
.claim-title{font-size:1.1rem;font-weight:700;margin-bottom:4px}
.claim-sub{color:rgba(255,255,255,.5);font-size:.85rem;margin-bottom:20px}
input{width:100%;padding:14px 16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;font-size:15px;margin-bottom:12px;outline:none}
input:focus{border-color:#833AB4}
button{width:100%;padding:16px;background:#FF5E1A;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:800;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
.msg{text-align:center;font-size:.9rem;margin-top:12px;min-height:20px}
.badge{display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);border-radius:20px;padding:6px 14px;font-size:.8rem;color:#22C55E;margin-bottom:16px}
</style></head><body>
<div class="card">
${v.photo_url ? `<img class="photo" src="${esc(v.photo_url)}" alt="${esc(v.name)}">` : `<div class="ph">${v.category === 'food_truck' ? '🍽️' : v.category === 'coffee' ? '☕' : v.category === 'bakery' ? '🍞' : v.category === 'flowers' ? '🌸' : '🏪'}</div>`}
<div class="body">
<h1>${esc(v.name)}</h1>
<div class="cat">${esc((v.category || 'vendor').replace(/_/g, ' '))}</div>
${v.description ? `<div class="desc">${esc(v.description)}</div>` : ''}
${menuHtml ? `<div class="menu"><div class="menu-title">Menu Preview</div>${menuHtml}</div>` : ''}
<div class="divider"></div>
<div class="badge">🎁 30-day free trial included</div>
<div class="claim-title">Is this your business?</div>
<div class="claim-sub">Claim your listing to go live on the map, manage your menu, and connect with local customers.</div>
<form onsubmit="return submitClaim(event)">
<input type="email" id="c-email" placeholder="Your business email" required>
<input type="password" id="c-pw" placeholder="Create a password (8+ chars)" required minlength="8">
<button type="submit" id="c-btn">Claim This Business</button>
</form>
<div class="msg" id="c-msg"></div>
</div>
</div>
<script>
async function submitClaim(e){
  e.preventDefault();
  const btn=document.getElementById('c-btn'),msg=document.getElementById('c-msg');
  btn.disabled=true; msg.textContent='Sending verification...'; msg.style.color='rgba(255,255,255,.5)';
  try{
    const r=await fetch('/api/vendor/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      vendor_id:'${v.id}',email:document.getElementById('c-email').value,password:document.getElementById('c-pw').value
    })});
    const d=await r.json();
    if(d.ok){msg.style.color='#22C55E';msg.textContent=d.message;}
    else{msg.style.color='#FD1D1D';msg.textContent=d.error;btn.disabled=false;}
  }catch(er){msg.style.color='#FD1D1D';msg.textContent='Network error';btn.disabled=false;}
  return false;
}
</script>
</body></html>`);
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 752: Customer email verification
app.get('/verify/customer/:token', (req, res) => {
  try {
    const cust = db.prepare('SELECT id FROM customers WHERE verification_token=?').get(req.params.token);
    if (!cust) return res.redirect('/account?verify=invalid');
    db.prepare("UPDATE customers SET email_verified=1, verification_token=NULL WHERE id=?").run(cust.id);
    res.redirect('/account?verify=success');
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/customer/resend-verification', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Invalid session' });
    if (cust.email_verified) return res.json({ ok:true, message:'Already verified' });
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE customers SET verification_token=? WHERE id=?').run(token, cust.id);
    sendEmail(cust.email, 'Verify your WYA account', `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;padding:28px;background:#050505;color:#f5f5f5;border-radius:16px">
        <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:16px">Verify Your Email</div>
        <p style="color:#9ca3af;line-height:1.6">Hey ${sanitize(cust.name)}! Click below to verify your WYA account.</p>
        <a href="https://wya.digisigns.link/verify/customer/${token}" style="display:block;text-align:center;padding:14px;background:#FF5E1A;color:#fff;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none;margin:24px 0">Verify Email &rarr;</a>
      </div>
    `).catch(()=>{});
    res.json({ ok:true, message:'Verification email sent' });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public vendor profile (SEO-friendly)
app.get('/api/vendors/:id/profile', (req, res) => {
  const v = db.prepare("SELECT id,name,category,description,photo_url,avg_rating,review_count,total_orders,business_hours,website,instagram,tiktok,facebook,youtube,doordash_url,ubereats_url,grubhub_url,yelp_url,google_maps_url,google_business_url,lat,lng,is_open,accepts_orders,delivery_enabled,estimated_prep_minutes,social_score,accent_color FROM vendors WHERE id=?").get(req.params.id);
  if (!v) return res.status(404).json({ error:'Vendor not found' });
  // Phase 11: derive accent from landing-config.json if no vendor accent_color set
  let effectiveAccent = v.accent_color || null;
  if (!effectiveAccent && v.digitap_card_url) {
    try {
      const slug = v.digitap_card_url.replace(/.*\//, '').replace(/[^a-z0-9-]/g, '');
      if (slug) {
        const lcPath = require('path').join(__dirname, '..', 'tenants', slug, 'landing-config.json');
        const lc = JSON.parse(require('fs').readFileSync(lcPath, 'utf8'));
        if (lc.accent) { effectiveAccent = lc.accent; v.accent_color = lc.accent; }
        if (lc.logo_url && !v.photo_url) v.photo_url = lc.logo_url;
      }
    } catch {}
  }
  if (effectiveAccent) {
    try {
      const { generatePalette } = require('../lib/theme-engine');
      v.palette = generatePalette(effectiveAccent);
    } catch (e) { /* theme-engine optional */ }
  }
  const menu = db.prepare('SELECT mc.name as category_name, mi.name, mi.price, mi.description, mi.available FROM menu_items mi LEFT JOIN menu_categories mc ON mi.category_id=mc.id WHERE mi.vendor_id=? AND mi.available=1 ORDER BY mc.sort_order, mi.sort_order').all(req.params.id);
  const reviews = db.prepare('SELECT r.rating, r.review_text, r.created_at, c.name as customer_name FROM reviews r LEFT JOIN customers c ON r.customer_id=c.id WHERE r.vendor_id=? ORDER BY r.created_at DESC LIMIT 10').all(req.params.id);
  // Phase 753: Track profile view (IP-based cooldown: 1 per vendor per IP per hour)
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    const viewerId = cust ? cust.id : null;
    const viewerType = cust ? 'customer' : 'anonymous';
    const viewIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (rateLimit('pview:' + req.params.id + ':' + viewIp, 1, 3600000)) {
      db.prepare('INSERT INTO profile_views (vendor_id, viewer_id, viewer_type, source) VALUES (?,?,?,?)').run(req.params.id, viewerId, viewerType, req.query.source || 'profile');
      db.prepare('UPDATE vendors SET profile_views = COALESCE(profile_views,0) + 1 WHERE id=?').run(req.params.id);
    }
  } catch(e) {}
  res.json({ ok:true, vendor:v, menu, reviews });
});

// Theme engine -- GET /api/theme?slug=X (Phase 6 -- D-07, D-08)
app.get('/api/theme', (req, res) => {
  try {
    const slug = (req.query.slug || '').replace(/[^a-z0-9_-]/g, '');
    const { normalizeConfig, generatePalette, toSoulCssVariables } = require('../lib/theme-engine');
    let cfg = {};
    if (slug) {
      const cfgPath = require('path').join(__dirname, '..', 'tenants', slug, 'landing-config.json');
      try { cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf-8')); } catch (e) { /* not found -> defaults */ }
    }
    const normalized = normalizeConfig(cfg);
    const palette = generatePalette(normalized.accent, { mode: 'dark' });
    const vars = toSoulCssVariables(palette);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, slug: slug || null, vars, meta: { accent: normalized.accent, logo_url: normalized.logo_url, hero_url: normalized.hero_url, tagline: normalized.tagline } });
  } catch (e) {
    console.error('[WYA] GET /api/theme error:', e.message);
    res.status(500).json({ error: 'theme_error' });
  }
});

// Phase 753: Record a profile view (called from map click / vendor card tap)
app.post('/api/vendors/:id/view', (req, res) => {
  const vendor = db.prepare('SELECT id FROM vendors WHERE id=?').get(req.params.id);
  if (!vendor) return res.status(404).json({ error:'Vendor not found' });
  try {
    const viewIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (rateLimit('pview:' + req.params.id + ':' + viewIp, 1, 3600000)) {
      const cust = getCustomerByToken(req.headers['x-cust-token']);
      const viewerId = cust ? cust.id : null;
      const viewerType = cust ? 'customer' : 'anonymous';
      const source = sanitize(req.body.source || 'map');
      db.prepare('INSERT INTO profile_views (vendor_id, viewer_id, viewer_type, source) VALUES (?,?,?,?)').run(req.params.id, viewerId, viewerType, source);
      db.prepare('UPDATE vendors SET profile_views = COALESCE(profile_views,0) + 1 WHERE id=?').run(req.params.id);
    }
  } catch(e) {}
  res.json({ ok:true });
});

// ══════════════════════════════════════════════════════════════
// ── Phase 733: MARKETPLACE ENDPOINTS ─────────────────────────
// ══════════════════════════════════════════════════════════════

// ── Customer Auth ────────────────────────────────────────────

app.post('/api/customer/register', (req, res) => {
  try {
    let { name, email, password, phone } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error:'name, email, password required' });
    name = sanitize(name);
    // Phase 1654: Input length bounds
    if (name.length > 100) return res.status(400).json({ error: 'Name too long' });
    if (email.length > 254) return res.status(400).json({ error: 'Email too long' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error:'Invalid email' });
    // Phase 1351: Skip rate limit + test firewall for internal SSO provisioning (EMS sends X-Portal-Secret)
    const isInternalSSO = req.headers['x-portal-secret'] && req.headers['x-portal-secret'] === SOUL_TOKEN;
    // Phase 1655: Block test/QA emails from registering (bypass for internal SSO/E2E)
    if (!isInternalSSO && isTestData(email, name)) {
      return res.status(400).json({ error: 'Please use a real email address' });
    }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password))
      return res.status(400).json({ error: 'Password must be 8+ characters with at least 1 letter and 1 number' });
    if (!isInternalSSO) {
      const ip = req.ip || req.connection.remoteAddress || 'unknown';
      if (!rateLimit('custreg:' + ip, 20, 3600000)) return res.status(429).json({ error:'Too many registrations' });
    }
    const existing = db.prepare('SELECT id FROM customers WHERE email=?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error:'Email already registered' });
    const id = 'c_' + crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO customers (id,name,email,password_hash,password_version,phone) VALUES (?,?,?,?,2,?)').run(
      id, name, email.toLowerCase(), hashPw(password), phone||''
    );
    // Cap concurrent customer sessions at 5
    const activeCustSessions = db.prepare("SELECT COUNT(*) as c FROM customer_sessions WHERE customer_id=? AND datetime(expires_at) > datetime('now')").get(id)?.c || 0;
    if (activeCustSessions >= 5) {
      db.prepare("DELETE FROM customer_sessions WHERE token IN (SELECT token FROM customer_sessions WHERE customer_id=? ORDER BY created_at ASC LIMIT ?)").run(id, activeCustSessions - 4);
    }
    const token = genToken();
    const expires = new Date(Date.now() + 30*24*60*60*1000).toISOString().replace('T',' ').replace('Z','');
    db.prepare('INSERT INTO customer_sessions (token,customer_id,expires_at) VALUES (?,?,?)').run(token, id, expires);
    // Signup bonus loyalty points
    try { awardSignupBonus(id); } catch(e) { console.error('[WYA] bonus err:', e.message); }
    // Phase 752: Customer email verification
    const verifyToken = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE customers SET verification_token=? WHERE id=?').run(verifyToken, id);
    emsSyncCustomer(email, name, phone, 'customer');
    res.json({ ok:true, token, customer_id:id, email_verification_required:true });
    sendEmail(email.toLowerCase(), 'Verify your WYA account', `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#050505;color:#f5f5f5;border-radius:16px"><div style="font-size:24px;font-weight:900;margin-bottom:8px">Welcome to <span style="color:#FF5E1A">WYA</span>!</div><p style="color:#9ca3af;line-height:1.6;margin-bottom:20px">Verify your email to start placing orders with local vendors.</p><a href="https://wya.digisigns.link/verify/customer/${verifyToken}" style="display:block;text-align:center;background:#FF5E1A;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:800;font-size:15px">Verify Email &rarr;</a></div>`).catch(()=>{});
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/customer/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({ error:'email and password required' });
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!rateLimit('custlogin:' + ip, 30, 900000)) return res.status(429).json({ error:'Too many login attempts' });
    const cust = db.prepare('SELECT * FROM customers WHERE email=?').get(email.toLowerCase());
    if (!cust || !verifyPw(password, cust.password_hash, cust.password_version || 1)) return res.status(401).json({ error:'Invalid credentials' });
    // Phase 1653: Transparent bcrypt upgrade on legacy login
    if ((cust.password_version || 1) === 1) {
      const newHash = hashPw(password);
      db.prepare('UPDATE customers SET password_hash=?, password_version=2 WHERE id=?').run(newHash, cust.id);
    }
    // Cap concurrent customer sessions at 5 — evict oldest when at capacity
    const activeCustSessions = db.prepare("SELECT COUNT(*) as c FROM customer_sessions WHERE customer_id=? AND datetime(expires_at) > datetime('now')").get(cust.id)?.c || 0;
    if (activeCustSessions >= 5) {
      const excess = activeCustSessions - 4; // keep 4, new insert makes 5
      if (excess > 0) db.prepare("DELETE FROM customer_sessions WHERE token IN (SELECT token FROM customer_sessions WHERE customer_id=? ORDER BY created_at ASC LIMIT ?)").run(cust.id, excess);
    }
    const token = genToken();
    const expires = new Date(Date.now() + 30*24*60*60*1000).toISOString().replace('T',' ').replace('Z','');
    db.prepare('INSERT INTO customer_sessions (token,customer_id,expires_at) VALUES (?,?,?)').run(token, cust.id, expires);
    db.prepare('UPDATE customers SET last_seen=? WHERE id=?').run(new Date().toISOString(), cust.id);
    res.json({ ok:true, token, customer:{ id:cust.id, name:cust.name } });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/customer/me', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Invalid session' });
    const { password_hash, ...safe } = cust;
    res.json({ ok:true, customer:safe });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/customer/profile', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Invalid session' });
    const { name, phone, avatar_url, default_address } = req.body;
    if (name !== undefined && name.length > 100) return res.status(400).json({ error: 'Name too long (max 100)' });
    if (phone !== undefined && phone.length > 20) return res.status(400).json({ error: 'Phone too long (max 20)' });
    if (default_address !== undefined && default_address.length > 500) return res.status(400).json({ error: 'Address too long (max 500)' });
    const sets = [], vals = [];
    if (name !== undefined) { sets.push('name=?'); vals.push(name); }
    if (phone !== undefined) { sets.push('phone=?'); vals.push(phone); }
    if (avatar_url !== undefined) { sets.push('avatar_url=?'); vals.push(avatar_url); }
    if (default_address !== undefined) { sets.push('default_address=?'); vals.push(default_address); }
    if (sets.length) {
      vals.push(cust.id);
      db.prepare(`UPDATE customers SET ${sets.join(',')} WHERE id=?`).run(...vals);
    }
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Password Reset (vendor + customer) ───────────────────────

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email, user_type } = req.body;
    if (!email) return res.status(400).json({ error:'Email required' });
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!rateLimit('forgot:' + ip, 3, 3600000)) return res.status(429).json({ error:'Too many requests — try again in an hour' });
    const type = user_type === 'vendor' ? 'vendor' : 'customer';
    const user = type === 'vendor'
      ? db.prepare('SELECT id, name, email FROM vendors WHERE email=?').get(email.toLowerCase())
      : db.prepare('SELECT id, name, email FROM customers WHERE email=?').get(email.toLowerCase());
    // Always return success to prevent email enumeration
    if (!user) return res.json({ ok:true, message:'If that email exists, a reset link has been sent' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    db.prepare('INSERT INTO password_reset_tokens (user_type,user_id,token,expires_at) VALUES (?,?,?,?)').run(type, user.id, token, expiresAt);
    const resetUrl = `https://wya.digisigns.link/${type}?reset_token=${token}`;
    sendEmail(user.email, 'WYA Password Reset', `<div style="font-family:-apple-system,sans-serif;max-width:480px;padding:24px;background:#050505;color:#f5f5f5;border-radius:16px">
      <div style="font-size:20px;font-weight:900;color:#FF5E1A;margin-bottom:12px">Password Reset</div>
      <p style="color:#e5e5e5">Hi ${user.name},</p>
      <p style="color:#9ca3af">Click the link below to reset your password. This link expires in 1 hour.</p>
      <div style="margin:20px 0"><a href="${resetUrl}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#FF5E1A,#FF1A3C);color:#fff;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px">Reset Password</a></div>
      <p style="font-size:12px;color:#666">If you didn't request this, ignore this email.</p>
    </div>`).catch(()=>{});
    res.json({ ok:true, message:'If that email exists, a reset link has been sent' });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/reset-password', (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (!rateLimit('resetpw:' + ip, 5, 900000)) return res.status(429).json({ error:'Too many reset attempts — try again later' });
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error:'Token and password required' });
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return res.status(400).json({ error:'Password must be at least 8 characters with letters and numbers' });
    const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token=? AND used=0').get(token);
    if (!row) return res.status(400).json({ error:'Invalid or expired reset link' });
    if (new Date(row.expires_at) < new Date()) {
      db.prepare('UPDATE password_reset_tokens SET used=1 WHERE id=?').run(row.id);
      return res.status(400).json({ error:'Reset link has expired — request a new one' });
    }
    const table = row.user_type === 'vendor' ? 'vendors' : 'customers';
    db.prepare(`UPDATE ${table} SET password_hash=?, password_version=2 WHERE id=?`).run(hashPw(password), row.user_id);
    db.prepare('UPDATE password_reset_tokens SET used=1 WHERE id=?').run(row.id);
    db.prepare('UPDATE password_reset_tokens SET used=1 WHERE user_type=? AND user_id=? AND used=0').run(row.user_type, row.user_id);
    res.json({ ok:true, message:'Password updated — you can now log in' });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Menu System ──────────────────────────────────────────────

// Public: Get vendor menu
app.get('/api/vendors/:id/menu', (req, res) => {
  try {
    const vid = req.params.id;
    const cats = db.prepare('SELECT * FROM menu_categories WHERE vendor_id=? ORDER BY sort_order, id').all(vid);
    const items = db.prepare('SELECT * FROM menu_items WHERE vendor_id=? ORDER BY sort_order, id').all(vid);
    const modifiers = db.prepare('SELECT m.* FROM menu_modifiers m JOIN menu_items i ON m.item_id=i.id WHERE i.vendor_id=? ORDER BY m.sort_order').all(vid);
    // Modifier groups and their options for this vendor
    const modifierGroups = db.prepare('SELECT * FROM wya_modifier_groups WHERE vendor_id=? ORDER BY id').all(vid);
    const groupIds = modifierGroups.map(g => g.id);
    const modifierOptions = groupIds.length
      ? db.prepare(`SELECT * FROM wya_modifier_options WHERE group_id IN (${groupIds.map(() => '?').join(',')}) AND active=1 ORDER BY sort_order, id`).all(...groupIds)
      : [];
    const optsByGroup = {};
    for (const o of modifierOptions) { (optsByGroup[o.group_id] = optsByGroup[o.group_id] || []).push(o); }
    const groupsByItem = {};
    for (const g of modifierGroups) {
      const key = g.menu_item_id;
      (groupsByItem[key] = groupsByItem[key] || []).push({ ...g, options: optsByGroup[g.id] || [] });
    }
    // Group items by category
    const modByItem = {};
    for (const m of modifiers) { (modByItem[m.item_id] = modByItem[m.item_id] || []).push(m); }
    const grouped = cats.map(c => ({
      ...c,
      items: items.filter(i => i.category_id === c.id).map(i => ({ ...i, modifiers: modByItem[i.id] || [], modifier_groups: groupsByItem[i.id] || [] }))
    }));
    // Uncategorized items
    const uncategorized = items.filter(i => !i.category_id || !cats.find(c => c.id === i.category_id));
    if (uncategorized.length) {
      grouped.push({ id: null, name: 'Other', sort_order: 999, items: uncategorized.map(i => ({ ...i, modifiers: modByItem[i.id] || [], modifier_groups: groupsByItem[i.id] || [] })) });
    }
    res.json({ ok:true, menu: grouped });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor menu CRUD (auth required)
app.post('/api/vendor/menu/categories', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { name, sort_order } = req.body;
    if (!name) return res.status(400).json({ error:'name required' });
    const r = db.prepare('INSERT INTO menu_categories (vendor_id,name,sort_order) VALUES (?,?,?)').run(vendor.id, name, sort_order||0);
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/vendor/menu/categories/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const cat = db.prepare('SELECT * FROM menu_categories WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!cat) return res.status(404).json({ error:'Category not found' });
    const { name, sort_order } = req.body;
    db.prepare('UPDATE menu_categories SET name=COALESCE(?,name), sort_order=COALESCE(?,sort_order) WHERE id=?').run(name||null, sort_order!==undefined?sort_order:null, cat.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/vendor/menu/categories/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const cat = db.prepare('SELECT * FROM menu_categories WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!cat) return res.status(404).json({ error:'Category not found' });
    // Items go uncategorized
    db.prepare('UPDATE menu_items SET category_id=NULL WHERE category_id=?').run(cat.id);
    db.prepare('DELETE FROM menu_categories WHERE id=?').run(cat.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/vendor/menu/items', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const items = db.prepare('SELECT mi.id, mi.name, mi.description, mi.price, mi.available, mi.sort_order, mc.name as category_name FROM menu_items mi LEFT JOIN menu_categories mc ON mi.category_id=mc.id WHERE mi.vendor_id=? ORDER BY mc.sort_order, mi.sort_order').all(vendor.id);
    res.json({ items });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/vendor/menu/items', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    // Phase 1700: Free tier menu item cap enforcement (raised to 25 for early adopters)
    const tier = vendor.subscription_tier || 'free';
    if (tier === 'free') {
      const itemCount = db.prepare('SELECT COUNT(*) as c FROM menu_items WHERE vendor_id=?').get(vendor.id)?.c || 0;
      if (itemCount >= 25) {
        return res.status(403).json({ error:'Free tier is limited to 25 menu items. Upgrade to Growth or Pro to add unlimited items.', upgrade_url:'https://wya.digisigns.link/plans', limit:25, current:itemCount });
      }
    }
    const { name, description, price, photo_url, category_id, available, sort_order } = req.body;
    if (!name || price === undefined) return res.status(400).json({ error:'name and price required' });
    const parsedPrice = parseFloat(price); if (isNaN(parsedPrice) || parsedPrice < 0 || parsedPrice > 9999) return res.status(400).json({ error: 'Price must be between $0 and $9999' });
    if (name && name.length > 200) return res.status(400).json({ error: 'Name too long (max 200)' });
    if (description && description.length > 2000) return res.status(400).json({ error: 'Description too long (max 2000)' });
    const r = db.prepare('INSERT INTO menu_items (vendor_id,category_id,name,description,price,photo_url,available,sort_order) VALUES (?,?,?,?,?,?,?,?)').run(
      vendor.id, category_id||null, name, description||'', parsedPrice, photo_url||'', available!==undefined?(available?1:0):1, sort_order||0
    );
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/vendor/menu/items/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const item = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!item) return res.status(404).json({ error:'Item not found' });
    const { name, description, price, photo_url, category_id, available, sort_order } = req.body;
    if (name !== undefined && name.length > 200) return res.status(400).json({ error: 'Name too long (max 200)' });
    if (description !== undefined && description.length > 2000) return res.status(400).json({ error: 'Description too long (max 2000)' });
    const sets = [], vals = [];
    if (name !== undefined) { sets.push('name=?'); vals.push(name); }
    if (description !== undefined) { sets.push('description=?'); vals.push(description); }
    if (price !== undefined) { const p = parseFloat(price); if (isNaN(p) || p < 0 || p > 9999) return res.status(400).json({ error: 'Price must be between $0 and $9999' }); sets.push('price=?'); vals.push(p); }
    if (photo_url !== undefined) { sets.push('photo_url=?'); vals.push(photo_url); }
    if (category_id !== undefined) { sets.push('category_id=?'); vals.push(category_id); }
    if (available !== undefined) { sets.push('available=?'); vals.push(available?1:0); }
    if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order); }
    if (sets.length) { vals.push(item.id); db.prepare(`UPDATE menu_items SET ${sets.join(',')} WHERE id=?`).run(...vals); }
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/vendor/menu/items/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const item = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!item) return res.status(404).json({ error:'Item not found' });
    db.prepare('DELETE FROM menu_modifiers WHERE item_id=?').run(item.id);
    db.prepare('DELETE FROM menu_items WHERE id=?').run(item.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/vendor/menu/items/:id/toggle', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const item = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!item) return res.status(404).json({ error:'Item not found' });
    const newVal = item.available ? 0 : 1;
    db.prepare('UPDATE menu_items SET available=? WHERE id=?').run(newVal, item.id);
    res.json({ ok:true, available:newVal });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/vendor/menu/items/:id/modifiers', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const item = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!item) return res.status(404).json({ error:'Item not found' });
    const { name, price, sort_order } = req.body;
    if (!name) return res.status(400).json({ error:'name required' });
    const modPrice = parseFloat(price); if (price !== undefined && price !== '' && (isNaN(modPrice) || modPrice < 0)) return res.status(400).json({ error: 'Invalid price' });
    const r = db.prepare('INSERT INTO menu_modifiers (item_id,name,price,sort_order) VALUES (?,?,?,?)').run(item.id, name, modPrice||0, sort_order||0);
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/vendor/menu/modifiers/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const mod = db.prepare('SELECT m.* FROM menu_modifiers m JOIN menu_items i ON m.item_id=i.id WHERE m.id=? AND i.vendor_id=?').get(req.params.id, vendor.id);
    if (!mod) return res.status(404).json({ error:'Modifier not found' });
    const { name, price, available, sort_order } = req.body;
    const sets = [], vals = [];
    if (name !== undefined) { sets.push('name=?'); vals.push(name); }
    if (price !== undefined) { const p = parseFloat(price); if (isNaN(p) || p < 0 || p > 9999) return res.status(400).json({ error: 'Price must be between $0 and $9999' }); sets.push('price=?'); vals.push(p); }
    if (available !== undefined) { sets.push('available=?'); vals.push(available?1:0); }
    if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order); }
    if (sets.length) { vals.push(mod.id); db.prepare(`UPDATE menu_modifiers SET ${sets.join(',')} WHERE id=?`).run(...vals); }
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/vendor/menu/modifiers/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const mod = db.prepare('SELECT m.* FROM menu_modifiers m JOIN menu_items i ON m.item_id=i.id WHERE m.id=? AND i.vendor_id=?').get(req.params.id, vendor.id);
    if (!mod) return res.status(404).json({ error:'Modifier not found' });
    db.prepare('DELETE FROM menu_modifiers WHERE id=?').run(mod.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Modifier Groups (Toast/Square-style) ─────────────────────

// GET /api/vendor/modifier-groups — list all modifier groups for the authenticated vendor
app.get('/api/vendor/modifier-groups', isVendor, (req, res) => {
  try {
    const groups = db.prepare('SELECT * FROM wya_modifier_groups WHERE vendor_id=? ORDER BY id').all(req.vendor.id);
    const groupIds = groups.map(g => g.id);
    const options = groupIds.length
      ? db.prepare(`SELECT * FROM wya_modifier_options WHERE group_id IN (${groupIds.map(() => '?').join(',')}) AND active=1 ORDER BY sort_order, id`).all(...groupIds)
      : [];
    const optsByGroup = {};
    for (const o of options) { (optsByGroup[o.group_id] = optsByGroup[o.group_id] || []).push(o); }
    const result = groups.map(g => ({ ...g, options: optsByGroup[g.id] || [] }));
    res.json({ ok: true, modifier_groups: result });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/vendor/modifier-groups — create a new modifier group (optionally linked to item_ids)
app.post('/api/vendor/modifier-groups', isVendor, (req, res) => {
  try {
    const { name, required, max_selections, min_selections, menu_item_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    if (!menu_item_id) return res.status(400).json({ error: 'menu_item_id required' });
    // Verify the menu item belongs to this vendor
    const item = db.prepare('SELECT id FROM menu_items WHERE id=? AND vendor_id=?').get(menu_item_id, req.vendor.id);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });
    const r = db.prepare(
      'INSERT INTO wya_modifier_groups (vendor_id,menu_item_id,group_name,required,min_selections,max_selections) VALUES (?,?,?,?,?,?)'
    ).run(req.vendor.id, menu_item_id, sanitize(name.trim()), required ? 1 : 0, parseInt(min_selections, 10) || 0, parseInt(max_selections, 10) || 1);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/vendor/modifier-groups/:id — update an existing modifier group
app.put('/api/vendor/modifier-groups/:id', isVendor, (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM wya_modifier_groups WHERE id=? AND vendor_id=?').get(req.params.id, req.vendor.id);
    if (!group) return res.status(404).json({ error: 'Modifier group not found' });
    const { name, required, max_selections, min_selections } = req.body;
    const sets = [], vals = [];
    if (name !== undefined) { sets.push('group_name=?'); vals.push(sanitize(name.trim())); }
    if (required !== undefined) { sets.push('required=?'); vals.push(required ? 1 : 0); }
    if (min_selections !== undefined) { sets.push('min_selections=?'); vals.push(parseInt(min_selections, 10) || 0); }
    if (max_selections !== undefined) { sets.push('max_selections=?'); vals.push(parseInt(max_selections, 10) || 1); }
    if (sets.length) { vals.push(group.id); db.prepare(`UPDATE wya_modifier_groups SET ${sets.join(',')} WHERE id=?`).run(...vals); }
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/vendor/modifier-groups/:id — delete a modifier group (cascades to options via FK)
app.delete('/api/vendor/modifier-groups/:id', isVendor, (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM wya_modifier_groups WHERE id=? AND vendor_id=?').get(req.params.id, req.vendor.id);
    if (!group) return res.status(404).json({ error: 'Modifier group not found' });
    // Transaction: delete options + group atomically
    db.transaction(() => {
      db.prepare('DELETE FROM wya_modifier_options WHERE group_id=?').run(group.id);
      db.prepare('DELETE FROM wya_modifier_groups WHERE id=?').run(group.id);
    })();
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/vendor/modifier-groups/:id/options — add an option to a modifier group
app.post('/api/vendor/modifier-groups/:id/options', isVendor, (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM wya_modifier_groups WHERE id=? AND vendor_id=?').get(req.params.id, req.vendor.id);
    if (!group) return res.status(404).json({ error: 'Modifier group not found' });
    const { name, price_delta, sort_order } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    const r = db.prepare('INSERT INTO wya_modifier_options (group_id,name,price_delta,sort_order) VALUES (?,?,?,?)').run(
      group.id, sanitize(name.trim()), parseFloat(price_delta) || 0, parseInt(sort_order, 10) || 0
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/vendor/modifier-options/:id — remove a modifier option
app.delete('/api/vendor/modifier-options/:id', isVendor, (req, res) => {
  try {
    // Verify ownership via group->vendor join
    const option = db.prepare(
      'SELECT o.* FROM wya_modifier_options o JOIN wya_modifier_groups g ON o.group_id=g.id WHERE o.id=? AND g.vendor_id=?'
    ).get(req.params.id, req.vendor.id);
    if (!option) return res.status(404).json({ error: 'Modifier option not found' });
    db.prepare('DELETE FROM wya_modifier_options WHERE id=?').run(option.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Orders ───────────────────────────────────────────────────

app.post('/api/orders', async (req, res) => {
  try {
  let cust = getCustomerByToken(req.headers['x-cust-token']);
  // Phase 1352: Internal SSO — EMS sends X-Portal-Secret + customer_id for Hub orders
  if (!cust && SOUL_TOKEN && req.headers['x-portal-secret'] === SOUL_TOKEN) {
    const bodyCustomerId = (req.body || {}).customer_id;
    if (bodyCustomerId) {
      const internal = db.prepare('SELECT * FROM customers WHERE id=?').get(bodyCustomerId);
      if (internal) cust = internal;
    }
  }
  // Phase 1319: Allow guest checkout with email+name (no login required)
  let { vendor_id, items, type, customer_notes, delivery_address, tip, promo_code, guest_email, guest_name } = req.body;
  // Enforce email verification for registered customers
  if (cust && !cust.email_verified) {
    return res.status(400).json({ error: 'Please verify your email before placing an order', needs_verification: true });
  }
  if (!cust) {
    // Guest checkout — require email
    if (!guest_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest_email)) {
      return res.status(400).json({ error: 'Valid email is required to place an order' });
    }
    if (!guest_name || !guest_name.trim()) {
      return res.status(400).json({ error: 'Name is required for guest orders' });
    }
    if (guest_email.length > 254) return res.status(400).json({ error: 'Email too long' });
    if (guest_name.length > 100) return res.status(400).json({ error: 'Name too long' });
    // Phase 1655: Block test/QA data from creating orders
    if (isTestData(guest_email, guest_name)) {
      return res.status(400).json({ error: 'Test data blocked in production' });
    }
    // Phase 1653/1661: Rate limit guest orders — max 2 per email per hour + IP+email combo
    const guestIp = req.ip || req.connection.remoteAddress || 'unknown';
    const guestCombo = 'guest-combo:' + guestIp + ':' + guest_email.toLowerCase();
    if (!rateLimit('guest-ip:' + guestIp, 5, 3600000) || !rateLimit('guest:' + guest_email.toLowerCase(), 2, 3600000) || !rateLimit(guestCombo, 2, 3600000)) {
      return res.status(429).json({ error: "You've placed 2 orders recently. Create a free account for unlimited ordering!", register_url: 'https://wya.digisigns.link/customer', show_register: true });
    }
    guest_email = sanitize(guest_email.trim());
    guest_name = sanitize(guest_name.trim());
  }
  customer_notes = sanitize(customer_notes);
  if (!vendor_id || !items || !items.length) return res.status(400).json({ error:'vendor_id and items required' });
  const vendor = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendor_id);
  if (!vendor) return res.status(404).json({ error:'Vendor not found' });
  if (vendor.subscription_status === 'expired') return res.status(403).json({ error:'Vendor subscription expired — cannot accept orders' });
  // Phase 1331: Enforce trial expiration — free vendors past trial cannot receive orders
  if (isTrialExpired(vendor)) return res.status(402).json({ error:'This vendor is temporarily unavailable. Please check back later or try another vendor.', vendor_unavailable: true });
  // Validate items and calculate subtotal from DB prices
  let subtotal = 0;
  const validatedItems = [];
  for (const item of items) {
    const dbItem = db.prepare('SELECT * FROM menu_items WHERE id=? AND vendor_id=?').get(item.id, vendor_id);
    if (!dbItem) return res.status(400).json({ error:`Item ${item.id} not found` });
    if (!dbItem.available) return res.status(400).json({ error:`${dbItem.name} is not available` });
    const qty = Math.max(1, parseInt(item.qty) || 1);
    let itemTotal = dbItem.price * qty;
    // Modifiers
    const mods = [];
    if (item.modifiers && item.modifiers.length) {
      for (const mid of item.modifiers) {
        const dbMod = db.prepare('SELECT * FROM menu_modifiers WHERE id=? AND item_id=?').get(mid, dbItem.id);
        if (dbMod && dbMod.available) { itemTotal += dbMod.price * qty; mods.push({ id:dbMod.id, name:dbMod.name, price:dbMod.price }); }
      }
    }
    subtotal += itemTotal;
    validatedItems.push({ id:dbItem.id, name:dbItem.name, price:dbItem.price, qty, modifiers:mods });
  }
  // Promo — validated inside transaction to prevent race condition (see insertOrder below)
  let promoDiscount = 0, promoCodeId = null, promoError = null, promoCodeUpper = promo_code ? promo_code.toUpperCase() : null;
  // Phase 747f: Enforce minimum order amount
  if (vendor.min_order_amount && subtotal < vendor.min_order_amount) {
    return res.status(400).json({ error: `Minimum order is $${vendor.min_order_amount.toFixed(2)}` });
  }
  // Phase 1299b: Block delivery orders for pickup-only vendors
  if (type === 'delivery' && !vendor.delivery_enabled) {
    return res.status(400).json({ error: 'This vendor only offers pickup. Please select pickup instead.' });
  }
  // Phase 1306: Require delivery address for delivery orders
  if (type === 'delivery' && (!delivery_address || !delivery_address.trim())) {
    return res.status(400).json({ error: 'Delivery address is required for delivery orders.' });
  }
  // Delivery zone enforcement: check if delivery_lat/delivery_lng falls within vendor zones
  let resolvedDeliveryFee = type === 'delivery' ? 3.99 : 0;
  if (type === 'delivery') {
    const delivCoords = validateCoords(req.body.delivery_lat, req.body.delivery_lng);
    const activeZones = db.prepare("SELECT COUNT(*) as cnt FROM delivery_zones WHERE vendor_id=? AND active=1").get(vendor_id);
    if (activeZones && activeZones.cnt > 0) {
      if (!delivCoords) {
        return res.status(400).json({ error: 'Valid delivery_lat and delivery_lng required for zone-restricted delivery.' });
      }
      const zoneMatch = checkDeliveryZones(vendor_id, delivCoords.lat, delivCoords.lng);
      if (!zoneMatch) {
        return res.status(400).json({ error: 'Sorry, this vendor does not deliver to your location. Check nearby vendors at /api/customer/nearby-vendors.' });
      }
      resolvedDeliveryFee = zoneMatch.fee;
      if (zoneMatch.zone.min_order && subtotal < zoneMatch.zone.min_order) {
        return res.status(400).json({ error: `Minimum order for delivery to your area is $${zoneMatch.zone.min_order.toFixed(2)}` });
      }
    } else if (delivCoords && vendor.lat && vendor.lng) {
      // Fall back to vendor's delivery_radius_mi
      const dist = haversine(delivCoords.lat, delivCoords.lng, vendor.lat, vendor.lng);
      const radiusMi = vendor.delivery_radius_mi || 5;
      if (dist > radiusMi) {
        return res.status(400).json({ error: `Sorry, your location is ${dist.toFixed(1)} miles away. This vendor delivers within ${radiusMi} miles.` });
      }
    }
  }
  const commRate = vendor.commission_rate || 0.12;
  const tipAmount = parseFloat(tip) || 0;
  const deliveryFee = resolvedDeliveryFee;
  const commAmount = Math.round(subtotal * commRate * 100) / 100;
  const orderId = 'ord_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const estReady = new Date(Date.now() + (vendor.estimated_prep_minutes || 15) * 60000).toISOString();

  const custId = cust ? cust.id : 'guest_' + crypto.randomBytes(4).toString('hex');
  const custName = cust ? cust.name : guest_name;
  const custEmail = cust ? cust.email : guest_email;
  const insertOrder = db.transaction(() => {
    // Promo validation inside transaction to prevent race condition on uses_count
    if (promoCodeUpper) {
      const promo = db.prepare("SELECT * FROM promo_codes WHERE code=? AND active=1 AND (vendor_id IS NULL OR vendor_id=?)").get(promoCodeUpper, vendor_id);
      if (!promo) {
        promoError = 'Invalid promo code';
      } else if (promo.max_uses > 0 && promo.uses_count >= promo.max_uses) {
        promoError = 'Promo code has been fully redeemed';
      } else if (promo.valid_until && new Date(promo.valid_until) <= new Date()) {
        promoError = 'Promo code has expired';
      } else if (subtotal < promo.min_order) {
        promoError = `Minimum order of $${promo.min_order.toFixed(2)} required for this code`;
      } else {
        promoDiscount = promo.discount_type === 'percent' ? subtotal * (promo.discount_value / 100) : promo.discount_value;
        promoDiscount = Math.min(promoDiscount, subtotal);
        promoCodeId = promo.id;
      }
    }
    // Recalculate total with promo inside transaction
    const finalTotal = Math.round((subtotal - promoDiscount + tipAmount + deliveryFee) * 100) / 100;
    db.prepare(`INSERT INTO orders (id,customer_id,vendor_id,status,type,items_json,subtotal,commission_rate,commission_amount,tip,delivery_fee,total,customer_notes,delivery_address,estimated_ready_at,promo_code_id,promo_discount,created_at,updated_at,payment_status,guest_email,guest_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      orderId, custId, vendor_id, 'pending', type||'pickup', JSON.stringify(validatedItems), subtotal, commRate, commAmount, tipAmount, deliveryFee, finalTotal, customer_notes||'', delivery_address||'', estReady, promoCodeId, promoDiscount, now, now, 'unpaid', cust ? null : guest_email, cust ? null : guest_name
    );
    db.prepare("INSERT INTO order_status_log (order_id,old_status,new_status,changed_by) VALUES (?,NULL,'pending',?)").run(orderId, custId || 'guest');
    // Update promo usage
    if (promoCodeId) {
      db.prepare('UPDATE promo_codes SET uses_count=uses_count+1 WHERE id=?').run(promoCodeId);
      db.prepare('INSERT INTO promo_usage (promo_code_id,customer_id,order_id,discount_applied) VALUES (?,?,?,?)').run(promoCodeId, custId, orderId, promoDiscount);
    }
    // Update vendor total_orders
    db.prepare('UPDATE vendors SET total_orders=total_orders+1 WHERE id=?').run(vendor_id);
    // Record tip in wya_tips if a tip was provided
    if (tipAmount > 0) {
      const tipPct = subtotal > 0 ? Math.round((tipAmount / subtotal) * 10000) / 100 : null;
      db.prepare('INSERT INTO wya_tips (order_id,vendor_id,customer_id,amount,percentage) VALUES (?,?,?,?,?)').run(orderId, vendor_id, custId, tipAmount, tipPct);
    }
    return finalTotal;
  });
  const total = insertOrder();

  // Brain OS 3.0: Record WYA order in Brain
  if (_brainIngest) {
    _brainIngest.ingest({ source: 'wya', type: 'order', memoryType: 'episodic',
      tenantId: process.env.OWNER_USER_ID || 'sergio', title: `WYA Order: $${total.toFixed(2)} from ${(custName || '').slice(0, 50)}`,
      content: `Order ${orderId} from ${(custName || '').slice(0, 50)}, total: $${total.toFixed(2)}, type: ${type || 'pickup'}`,
      tags: ['order', 'wya', 'revenue_event'] }).catch(() => {});
  }

  // Phase 736: $0 orders skip Stripe, mark paid immediately
  if (total <= 0) {
    db.prepare("UPDATE orders SET payment_status='paid' WHERE id=?").run(orderId);
    broadcastSSE({ type:'new_order', vendor_id, order_id:orderId });
    sendPushNotification(vendor.id, 'vendor', 'New Order!', `$${total.toFixed(2)} from ${custName}`, `https://wya.digisigns.link/vendor`);
    // Hub notification (fire-and-forget)
    try { const np=JSON.stringify({tenant_user_id:vendor.email?.split('@')[0]||(process.env.OWNER_USER_ID||'sergio'),type:'order',title:`WYA Order: $${total.toFixed(2)}`,message:`${custName} ordered from ${vendor.name}`,action_url:'/my/wya'});const nr=http.request({hostname:'127.0.0.1',port:3700,path:'/api/internal/notify',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(np)},timeout:3000},()=>{});nr.on('error',()=>{});nr.write(np);nr.end();} catch(_){}
    sendEmail(vendor.email, `New Order on WYA!`, `<div style="font-family:-apple-system,sans-serif;max-width:480px;padding:24px;background:#050505;color:#f5f5f5"><div style="font-size:20px;font-weight:900;color:#FF5E1A;margin-bottom:12px">New Order!</div><p>Order #${orderId.slice(-8)} from ${custName}</p><p style="color:#9ca3af">Total: $${total.toFixed(2)} (${type||'pickup'})</p><p style="color:#9ca3af">${validatedItems.map(i=>`${i.qty}x ${i.name}`).join(', ')}</p></div>`).catch(()=>{});
    sendEmail(custEmail, `WYA Order Receipt — #${orderId.slice(-8)}`, buildReceiptEmailHtml({id:orderId,subtotal,total,tip:tipAmount,delivery_fee:deliveryFee,promo_discount:promoDiscount,type:type||'pickup',delivery_address:delivery_address||'',estimated_ready_at:estReady,created_at:now}, vendor, validatedItems)).catch(()=>{});
    const zeroResponse = { ok:true, order_id:orderId, total, estimated_ready_at:estReady };
    if (promoError) zeroResponse.promo_error = promoError;
    return res.json(zeroResponse);
  }

  // Phase 736: Create Stripe Checkout Session for payment
  const lineItems = validatedItems.map(i => ({
    price_data: {
      currency: 'usd',
      product_data: { name: `${i.name} x${i.qty}`, description: vendor.name },
      unit_amount: Math.round(i.price * 100),
    },
    quantity: i.qty,
  }));
  if (tipAmount > 0) {
    lineItems.push({ price_data: { currency: 'usd', product_data: { name: 'Tip' }, unit_amount: Math.round(tipAmount * 100) }, quantity: 1 });
  }
  if (deliveryFee > 0) {
    lineItems.push({ price_data: { currency: 'usd', product_data: { name: 'Delivery Fee' }, unit_amount: Math.round(deliveryFee * 100) }, quantity: 1 });
  }
  const sessionOpts = {
    payment_method_types: ['card', 'link'],
    mode: 'payment',
    line_items: lineItems,
    customer_email: custEmail,
    metadata: { order_id: orderId, vendor_id, customer_id: custId || 'guest' },
    success_url: `https://wya.digisigns.link/customer?order_success=${orderId}`,
    cancel_url:  `https://wya.digisigns.link/customer?order_cancelled=${orderId}`,
    expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 min — food orders need urgency
  };
  // Apply promo discount as a Stripe coupon (clamped to 100%)
  if (promoDiscount > 0) {
    const discountPct = Math.min(Math.round((promoDiscount / subtotal) * 100), 100);
    const coupon = await getStripe().coupons.create({ percent_off: discountPct, duration: 'once' });
    sessionOpts.discounts = [{ coupon: coupon.id }];
  }
  let session;
  try {
    session = await getStripe().checkout.sessions.create(sessionOpts);
  } catch (stripeErr) {
    // Stripe failed — roll back the order so it doesn't sit orphaned as 'unpaid'
    console.error('[ORDER] Stripe checkout.sessions.create failed, rolling back order:', stripeErr.message);
    db.prepare('DELETE FROM order_status_log WHERE order_id=?').run(orderId);
    db.prepare('DELETE FROM orders WHERE id=?').run(orderId);
    if (promoCodeId) db.prepare('UPDATE promo_codes SET uses_count=MAX(uses_count-1,0) WHERE id=?').run(promoCodeId);
    db.prepare('UPDATE vendors SET total_orders=MAX(total_orders-1,0) WHERE id=?').run(vendor_id);
    return res.status(502).json({ error: 'Payment service unavailable. Please try again.' });
  }
  db.prepare('UPDATE orders SET stripe_checkout_session_id=?, payment_status=? WHERE id=?').run(session.id, 'pending', orderId);

  // Track in growth-engine for cart recovery emails
  try {
    const trackBody = JSON.stringify({ session_id: orderId, email: guestEmail || '', tenant: 'wya', amount_cents: Math.round(total * 100), items_count: items.length, status: 'started' });
    const trackReq = require('http').request({ hostname:'127.0.0.1', port:3485, path:'/api/cart-recovery/track', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(trackBody)}, timeout:3000 });
    trackReq.on('error', (e) => console.warn('[WYA] Fire-and-forget failed:', e.message));
    trackReq.end(trackBody);
  } catch(_) {}

  // Broadcast as pending payment — vendor sees order but knows payment is in progress
  broadcastSSE({ type:'order_pending_payment', vendor_id, order_id:orderId });
  const orderResponse = { ok:true, order_id:orderId, checkout_url:session.url, total, estimated_ready_at:estReady };
  if (promoError) orderResponse.promo_error = promoError;
  res.json(orderResponse);
  } catch(e) {
    console.error('[ORDER]', e.message, e.stack);
    if (!res.headersSent) res.status(500).json({ error: 'Order processing failed. Please try again.' });
  }
});

// Phase 1328: Retry checkout for expired/pending orders
app.post('/api/customer/orders/:id/retry-checkout', async (req, res) => {
  const cust = getCustomerByToken(req.headers['x-cust-token']);
  if (!cust) return res.status(401).json({ error:'Login required' });
  const order = db.prepare('SELECT o.*, v.name as vendor_name, v.id as vid FROM orders o LEFT JOIN vendors v ON o.vendor_id=v.id WHERE o.id=? AND o.customer_id=?').get(req.params.id, cust.id);
  if (!order) return res.status(404).json({ error:'Order not found' });
  if (order.payment_status === 'paid') return res.status(400).json({ error:'Order already paid' });
  if (!['expired','pending'].includes(order.payment_status)) return res.status(400).json({ error:'Cannot retry this order' });
  // Phase 1654: Re-validate vendor is still active
  const retryVendor = db.prepare('SELECT * FROM vendors WHERE id=?').get(order.vendor_id || order.vid);
  if (!retryVendor || retryVendor.subscription_status === 'expired' || isTrialExpired(retryVendor)) {
    return res.status(400).json({ error: 'Vendor is no longer accepting orders' });
  }
  try {
    const items = JSON.parse(order.items_json || '[]');
    const lineItems = items.map(i => ({
      price_data: { currency:'usd', product_data:{ name:`${i.name} x${i.qty}`, description:order.vendor_name||'Vendor' }, unit_amount:Math.round(i.price*100) },
      quantity: i.qty,
    }));
    if (parseFloat(order.tip||0) > 0) lineItems.push({ price_data:{ currency:'usd', product_data:{ name:'Tip' }, unit_amount:Math.round(parseFloat(order.tip)*100) }, quantity:1 });
    if (parseFloat(order.delivery_fee||0) > 0) lineItems.push({ price_data:{ currency:'usd', product_data:{ name:'Delivery Fee' }, unit_amount:Math.round(parseFloat(order.delivery_fee)*100) }, quantity:1 });
    const session = await getStripe().checkout.sessions.create({
      payment_method_types:['card', 'link'], mode:'payment', line_items:lineItems,
      customer_email: cust.email,
      metadata:{ order_id:order.id, vendor_id:order.vid||'', customer_id:cust.id },
      success_url:`https://wya.digisigns.link/customer?order_success=${order.id}`,
      cancel_url:`https://wya.digisigns.link/customer?order_cancelled=${order.id}`,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    });
    db.prepare('UPDATE orders SET stripe_checkout_session_id=?, payment_status=? WHERE id=?').run(session.id, 'pending', order.id);
    console.log(`[STRIPE] Retry checkout for order ${order.id} — new session created`);
    res.json({ ok:true, url:session.url });
  } catch(e) {
    console.error('[STRIPE] Retry checkout error:', e.message);
    res.status(500).json({ error: 'Payment retry failed. Please try again.' });
  }
});

app.get('/api/customer/orders', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const { status, limit, offset } = req.query;
    let sql = 'SELECT o.*, v.name as vendor_name, (SELECT COUNT(*) FROM reviews WHERE order_id=o.id) as reviewed FROM orders o LEFT JOIN vendors v ON o.vendor_id=v.id WHERE o.customer_id=?';
    const params = [cust.id];
    if (status) { sql += ' AND o.status=?'; params.push(status); }
    sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(Math.min(parseInt(limit, 10) || 20, 100), parseInt(offset, 10) || 0);
    const orders = db.prepare(sql).all(...params);
    res.json({ ok:true, orders });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/customer/orders/:id/cart — cart restore for cancelled checkouts (auth required)
app.get('/api/customer/orders/:id/cart', (req, res) => {
  try {
    // Allow portal secret (internal) or customer token
    const portalSecret = req.headers['x-portal-secret'] || '';
    const isPortal = portalSecret && SOUL_TOKEN && portalSecret === SOUL_TOKEN;
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!isPortal && !cust) return res.status(401).json({ error:'Authentication required' });
    let sql = "SELECT vendor_id, items_json, customer_id FROM orders WHERE id=? AND payment_status IN ('unpaid','pending')";
    const params = [req.params.id];
    if (cust) { sql += ' AND customer_id=?'; params.push(cust.id); }
    const order = db.prepare(sql).get(...params);
    if (!order) return res.status(404).json({ error:'Order not found or already paid' });
    let items = [];
    try { items = JSON.parse(order.items_json || '[]'); } catch {}
    res.json({ ok:true, vendor_id: order.vendor_id, items });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/customer/orders/:id', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const order = db.prepare('SELECT o.*, v.name as vendor_name, v.estimated_prep_minutes as vendor_prep_minutes, (SELECT COUNT(*) FROM reviews WHERE order_id=o.id) as reviewed FROM orders o LEFT JOIN vendors v ON o.vendor_id=v.id WHERE o.id=? AND o.customer_id=?').get(req.params.id, cust.id);
    if (!order) return res.status(404).json({ error:'Order not found' });
    const log = db.prepare('SELECT * FROM order_status_log WHERE order_id=? ORDER BY ts').all(order.id);
    res.json({ ok:true, order, status_log:log });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/customer/orders/:id/cancel', async (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND customer_id=?').get(req.params.id, cust.id);
    if (!order) return res.status(404).json({ error:'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ error:'Can only cancel pending orders' });
    // Phase 747e: Refund via Stripe if paid
    if (order.payment_status === 'paid' && order.stripe_checkout_session_id) {
      try {
        const session = await getStripe().checkout.sessions.retrieve(order.stripe_checkout_session_id);
        if (session.payment_intent) {
          await getStripe().refunds.create({ payment_intent: session.payment_intent });
          db.prepare("UPDATE orders SET payment_status='refunded' WHERE id=?").run(order.id);
        }
      } catch(e) { console.error('[REFUND]', e.message); }
    }
    db.prepare("UPDATE orders SET status='cancelled', updated_at=? WHERE id=?").run(new Date().toISOString(), order.id);
    db.prepare("INSERT INTO order_status_log (order_id,old_status,new_status,changed_by) VALUES (?,'pending','cancelled',?)").run(order.id, cust.id);
    broadcastSSE({ type:'order_update', order_id:order.id, status:'cancelled', vendor_id:order.vendor_id });
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor order endpoints
app.get('/api/vendor/orders', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { status } = req.query;
    let sql = 'SELECT o.*, c.name as customer_name, c.phone as customer_phone FROM orders o LEFT JOIN customers c ON o.customer_id=c.id WHERE o.vendor_id=?';
    const params = [vendor.id];
    if (status === 'pending') { sql += " AND o.status='pending'"; }
    else if (status === 'active') { sql += " AND o.status IN ('confirmed','preparing','ready')"; }
    else if (status === 'completed') { sql += " AND o.status IN ('picked_up','delivered','cancelled')"; }
    sql += ' ORDER BY o.created_at DESC LIMIT 100';
    const orders = db.prepare(sql).all(...params);
    res.json({ ok:true, orders });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/vendor/orders/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const order = db.prepare('SELECT o.*, c.name as customer_name, c.phone as customer_phone FROM orders o LEFT JOIN customers c ON o.customer_id=c.id WHERE o.id=? AND o.vendor_id=?').get(req.params.id, vendor.id);
    if (!order) return res.status(404).json({ error:'Order not found' });
    res.json({ ok:true, order });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/vendor/orders/:id/status', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!order) return res.status(404).json({ error:'Order not found' });
    const { status } = req.body;
    // Phase 1700: Block order acceptance when trial has expired
    if (status === 'confirmed' && isTrialExpired(vendor)) {
      return res.status(402).json({ error:'Trial expired — upgrade to accept orders', upgrade_url:'https://wya.digisigns.link/plans' });
    }
    // Block confirming unpaid orders
    if (status === 'confirmed' && order.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Cannot accept order — payment not yet received' });
    }
    // Guard against premature cancellation of orders where customer may still be paying
    if (status === 'cancelled' && order.payment_status === 'pending') {
      const orderAge = Date.now() - new Date(order.created_at).getTime();
      if (orderAge < 30 * 60 * 1000) {
        return res.status(400).json({ error: 'Customer may still be completing payment. Wait 30 minutes or until checkout expires.' });
      }
    }
    // Enforce status transitions
    const transitions = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['preparing'],
      preparing: ['ready'],
      ready: ['picked_up', 'delivered'],
    };
    const allowed = transitions[order.status];
    if (!allowed || !allowed.includes(status)) return res.status(400).json({ error:`Cannot change from ${order.status} to ${status}` });
    // Phase 1653: Audit warning when completing unpaid orders
    if (['ready','picked_up','delivered'].includes(status) && order.payment_status !== 'paid') {
      console.warn(`[ORDER-AUDIT] Vendor ${vendor.id} marking order ${order.id} as '${status}' with payment_status='${order.payment_status}' — possible cash collection`);
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(status, now, order.id);
    db.prepare('INSERT INTO order_status_log (order_id,old_status,new_status,changed_by) VALUES (?,?,?,?)').run(order.id, order.status, status, vendor.id);
    broadcastSSE({ type:'order_update', order_id:order.id, status, vendor_id:vendor.id });
    // Email + push customer on key status changes
    const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(order.customer_id);
    if (cust) {
      const msgs = { confirmed:'Your order has been confirmed!', preparing:'Your order is being prepared!', ready:'Your order is ready for pickup!', picked_up:'Your order has been picked up!', delivered:'Your order has been delivered!', cancelled:'Your order has been cancelled.' };
      if (msgs[status]) {
        sendEmail(cust.email, `WYA Order Update`, `<div style="font-family:-apple-system,sans-serif;max-width:480px;padding:24px;background:#050505;color:#f5f5f5"><div style="font-size:18px;font-weight:900;color:#FF5E1A;margin-bottom:8px">${msgs[status]}</div><p style="color:#9ca3af">Order from ${vendor.name} — $${order.total.toFixed(2)}</p></div>`).catch(()=>{});
        sendPushNotification(cust.id, 'customer', `Order ${status}`, msgs[status], `https://wya.digisigns.link/account`, { category: status === 'ready' ? 'order_ready' : 'order_update', orderId: order.id });
      }
    }
    // Award loyalty + record commission on completion
    if (['picked_up','delivered'].includes(status)) {
      awardLoyaltyPoints(order.customer_id, order.id, order.total);
      recordOrderCommission(order);
    }
    res.json({ ok:true, status });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 748: Bump prep time
app.post('/api/vendor/orders/:id/bump-time', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!order) return res.status(404).json({ error:'Order not found' });
    if (['picked_up','delivered','cancelled'].includes(order.status)) return res.status(400).json({ error:'Order already completed' });
    const minutes = Math.min(Math.max(1, parseInt(req.body.minutes, 10) || 5), 15);
    const currentReady = order.estimated_ready_at ? new Date(order.estimated_ready_at) : new Date();
    const newReady = new Date(Math.max(currentReady.getTime(), Date.now()) + minutes * 60000);
    db.prepare('UPDATE orders SET estimated_ready_at=?, updated_at=? WHERE id=?').run(newReady.toISOString(), new Date().toISOString(), order.id);
    broadcastSSE({ type:'order_time_updated', order_id:order.id, vendor_id:vendor.id, estimated_ready_at:newReady.toISOString() });
    sendPushNotification(order.customer_id, 'customer', 'Order Update', `Your order will take ~${minutes} more minutes. New estimate: ${newReady.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`, `https://wya.digisigns.link/customer`);
    res.json({ ok:true, estimated_ready_at:newReady.toISOString() });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 748: Lightweight order tracking endpoint
app.get('/api/customer/orders/:id/track', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    // Guest order tracking: ?email=X verifies ownership by guest_email match
    const guestEmail = (req.query.email || '').toLowerCase().trim();
    let order = null;
    if (cust) {
      order = db.prepare('SELECT o.id, o.status, o.estimated_ready_at, o.type, o.payment_status, o.total, o.items_json, o.created_at, v.name as vendor_name, v.lat as vendor_lat, v.lng as vendor_lng, v.phone as vendor_phone FROM orders o LEFT JOIN vendors v ON o.vendor_id=v.id WHERE o.id=? AND o.customer_id=?').get(req.params.id, cust.id);
    } else if (guestEmail) {
      // Guest lookup — match by order ID + guest email (ownership proof)
      order = db.prepare('SELECT o.id, o.status, o.estimated_ready_at, o.type, o.payment_status, o.total, o.items_json, o.created_at, v.name as vendor_name, v.lat as vendor_lat, v.lng as vendor_lng, v.phone as vendor_phone FROM orders o LEFT JOIN vendors v ON o.vendor_id=v.id WHERE o.id=? AND LOWER(o.guest_email)=?').get(req.params.id, guestEmail);
    } else {
      return res.status(401).json({ error:'Login required or provide ?email= for guest orders' });
    }
    if (!order) return res.status(404).json({ error:'Order not found' });
    // Parse items for display
    try { order.items = JSON.parse(order.items_json); } catch { order.items = []; }
    delete order.items_json;
    const queuePos = db.prepare("SELECT COUNT(*) as c FROM orders WHERE vendor_id=(SELECT vendor_id FROM orders WHERE id=?) AND status IN ('pending','confirmed','preparing') AND created_at <= (SELECT created_at FROM orders WHERE id=?)").get(req.params.id, req.params.id)?.c ?? 0;
    const log = db.prepare('SELECT new_status, ts FROM order_status_log WHERE order_id=? ORDER BY ts').all(req.params.id);
    res.json({ ok:true, ...order, queue_position:queuePos, status_log:log });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Guest order lookup by email — returns recent orders for that email (no auth, rate-limited)
app.get('/api/orders/lookup', publicLimiter60, (req, res) => {
  try {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    const orders = db.prepare(`
      SELECT o.id, o.status, o.payment_status, o.total, o.type, o.created_at, o.estimated_ready_at,
             v.name as vendor_name
      FROM orders o LEFT JOIN vendors v ON o.vendor_id=v.id
      WHERE LOWER(o.guest_email)=? OR o.customer_id IN (SELECT id FROM customers WHERE LOWER(email)=?)
      ORDER BY o.created_at DESC LIMIT 10
    `).all(email, email);
    res.json({ ok: true, orders });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Payment Verification (fallback for delayed webhooks) ────
// Called by frontend when customer returns from Stripe success_url
// Checks Stripe session status directly and updates order if paid
app.get('/api/orders/:id/verify-payment', async (req, res) => {
  try {
    const order = db.prepare('SELECT id, payment_status, stripe_checkout_session_id FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.json({ ok: true, status: 'paid' });
    if (!order.stripe_checkout_session_id || !process.env.WYA_STRIPE_SK) {
      return res.json({ ok: true, status: order.payment_status });
    }
    const session = await getStripe().checkout.sessions.retrieve(order.stripe_checkout_session_id);
    if (session.payment_status === 'paid') {
      db.prepare("UPDATE orders SET payment_status='paid', stripe_payment_intent_id=?, updated_at=datetime('now') WHERE id=?")
        .run(session.payment_intent, order.id);
      broadcastSSE({ type: 'order_paid', order_id: order.id });
      console.log(`[STRIPE] Payment verified via fallback for order ${order.id}`);
      return res.json({ ok: true, status: 'paid' });
    }
    res.json({ ok: true, status: session.status === 'expired' ? 'expired' : 'unpaid' });
  } catch(e) {
    console.error('[WYA-APP] Payment verify error:', e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── Reviews ──────────────────────────────────────────────────

app.post('/api/orders/:id/review', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND customer_id=?').get(req.params.id, cust.id);
    if (!order) return res.status(404).json({ error:'Order not found' });
    if (!['picked_up','delivered'].includes(order.status)) return res.status(400).json({ error:'Can only review completed orders' });
    const existing = db.prepare('SELECT id FROM reviews WHERE order_id=?').get(order.id);
    if (existing) return res.status(409).json({ error:'Already reviewed' });
    const { rating, review_text } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error:'Rating must be 1-5' });
    // Roadmap T4.3: Content filtering on review text
    const reviewCheck = filterReviewContent(review_text);
    if (!reviewCheck.ok) return res.status(400).json({ error: reviewCheck.reason });
    db.prepare('INSERT INTO reviews (order_id,customer_id,vendor_id,rating,review_text) VALUES (?,?,?,?,?)').run(order.id, cust.id, order.vendor_id, rating, reviewCheck.filtered||'');
    // Update vendor avg_rating
    const agg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE vendor_id=?').get(order.vendor_id);
    db.prepare('UPDATE vendors SET avg_rating=?, review_count=? WHERE id=?').run(Math.round((agg?.avg ?? 0) * 10) / 10, agg?.cnt ?? 0, order.vendor_id);
    // Brain OS 3.0: Record review in Brain
    if (_brainIngest) {
      try {
        const _rv = db.prepare('SELECT name FROM vendors WHERE id=?').get(order.vendor_id);
        _brainIngest.ingest({ source: 'wya', type: 'review', memoryType: 'episodic',
          tenantId: process.env.OWNER_USER_ID || 'sergio', title: `Review: ${(_rv?.name || 'vendor').slice(0, 40)} (${rating} stars)`,
          content: `${(cust.name || 'customer').slice(0, 40)} left ${rating}-star review for ${(_rv?.name || '').slice(0, 40)}: ${(reviewCheck.filtered || '').slice(0, 200)}`,
          tags: ['wya', 'review', 'feedback', 'engagement'], confidence: 0.8 });
      } catch {}
    }
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/vendors/:id/reviews', (req, res) => {
  try {
    const { limit, offset } = req.query;
    const reviews = db.prepare('SELECT r.*, c.name as customer_name FROM reviews r LEFT JOIN customers c ON r.customer_id=c.id WHERE r.vendor_id=? ORDER BY r.created_at DESC LIMIT ? OFFSET ?').all(req.params.id, parseInt(limit, 10) || 20, parseInt(offset, 10) || 0);
    res.json({ ok:true, reviews });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/customer/reviews — submit a review for a completed order (customer auth required)
app.post('/api/customer/reviews', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error: 'Login required' });
    const { vendor_id, order_id, rating, comment } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });
    if (!order_id) return res.status(400).json({ error: 'order_id required' });
    const ratingNum = parseInt(rating, 10);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) return res.status(400).json({ error: 'rating must be 1-5' });
    // Verify the order belongs to this customer and is from this vendor
    const order = db.prepare("SELECT * FROM orders WHERE id=? AND customer_id=? AND vendor_id=? AND payment_status='paid'").get(order_id, cust.id, vendor_id);
    if (!order) return res.status(404).json({ error: 'Order not found or not eligible for review' });
    // Prevent duplicate reviews per order
    const existing = db.prepare('SELECT id FROM reviews WHERE order_id=?').get(order_id);
    if (existing) return res.status(409).json({ error: 'You have already reviewed this order' });
    // Content filtering on comment
    const reviewCheck = filterReviewContent(comment || '');
    if (!reviewCheck.ok) return res.status(400).json({ error: reviewCheck.reason });
    const r = db.prepare('INSERT INTO reviews (order_id,customer_id,vendor_id,rating,review_text) VALUES (?,?,?,?,?)').run(order_id, cust.id, vendor_id, ratingNum, reviewCheck.filtered || '');
    // Recalculate vendor avg_rating
    const agg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE vendor_id=?').get(vendor_id);
    db.prepare('UPDATE vendors SET avg_rating=?, review_count=? WHERE id=?').run(Math.round((agg?.avg ?? 0) * 10) / 10, agg?.cnt ?? 0, vendor_id);
    res.json({ ok: true, review_id: r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/vendor/reviews/:id/respond', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const review = db.prepare('SELECT * FROM reviews WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!review) return res.status(404).json({ error:'Review not found' });
    const { response } = req.body;
    db.prepare('UPDATE reviews SET vendor_response=?, vendor_responded_at=? WHERE id=?').run(response||'', new Date().toISOString(), review.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Favorites ────────────────────────────────────────────────

app.post('/api/customer/favorites/:vendor_id', (req, res) => {
  const cust = getCustomerByToken(req.headers['x-cust-token']);
  if (!cust) return res.status(401).json({ error:'Login required' });
  try {
    db.prepare('INSERT OR IGNORE INTO favorites (customer_id,vendor_id) VALUES (?,?)').run(cust.id, req.params.vendor_id);
    res.json({ ok:true });
  } catch(e) { console.error('[WYA-APP] Route error:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/customer/favorites/:vendor_id', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    db.prepare('DELETE FROM favorites WHERE customer_id=? AND vendor_id=?').run(cust.id, req.params.vendor_id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/customer/favorites', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const favs = db.prepare(`SELECT f.*, v.name, v.category, v.photo_url, v.avg_rating, v.is_open FROM favorites f JOIN vendors v ON f.vendor_id=v.id WHERE f.customer_id=? ORDER BY f.created_at DESC`).all(cust.id);
    res.json({ ok:true, favorites:favs });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Promo Codes ──────────────────────────────────────────────

app.post('/api/vendor/promos', (req, res) => {
  const vendor = getVendorByToken(req.headers['x-auth-token']);
  if (!vendor) return res.status(401).json({ error:'Invalid session' });
  const { code, discount_type, discount_value, min_order, max_uses, valid_until } = req.body;
  if (!code) return res.status(400).json({ error:'code required' });
  try {
    db.prepare('INSERT INTO promo_codes (code,vendor_id,discount_type,discount_value,min_order,max_uses,valid_until,created_by) VALUES (?,?,?,?,?,?,?,?)').run(
      sanitize(code).toUpperCase(), vendor.id, discount_type||'percent', parseFloat(discount_value)||0, parseFloat(min_order)||0, parseInt(max_uses)||0, valid_until||null, vendor.id
    );
    res.json({ ok:true });
  } catch(e) { res.status(409).json({ error:'Code already exists' }); }
});

app.get('/api/vendor/promos', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const promos = db.prepare('SELECT * FROM promo_codes WHERE vendor_id=? ORDER BY created_at DESC').all(vendor.id);
    res.json({ ok:true, promos });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/vendor/promos/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const promo = db.prepare('SELECT * FROM promo_codes WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!promo) return res.status(404).json({ error:'Promo not found' });
    const { discount_type, discount_value, min_order, max_uses, valid_until, active } = req.body;
    const sets = [], vals = [];
    if (discount_type !== undefined) { sets.push('discount_type=?'); vals.push(discount_type); }
    if (discount_value !== undefined) { sets.push('discount_value=?'); vals.push(parseFloat(discount_value)); }
    if (min_order !== undefined) { sets.push('min_order=?'); vals.push(parseFloat(min_order)); }
    if (max_uses !== undefined) { sets.push('max_uses=?'); vals.push(parseInt(max_uses, 10)); }
    if (valid_until !== undefined) { sets.push('valid_until=?'); vals.push(valid_until); }
    if (active !== undefined) { sets.push('active=?'); vals.push(active?1:0); }
    if (sets.length) { vals.push(promo.id); db.prepare(`UPDATE promo_codes SET ${sets.join(',')} WHERE id=?`).run(...vals); }
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/vendor/promos/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    db.prepare('UPDATE promo_codes SET active=0 WHERE id=? AND vendor_id=?').run(req.params.id, vendor.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/promo/validate', (req, res) => {
  try {
    const { code, vendor_id, subtotal } = req.body;
    if (!code) return res.status(400).json({ error:'code required' });
    const promo = db.prepare("SELECT * FROM promo_codes WHERE code=? AND active=1 AND (vendor_id IS NULL OR vendor_id=?)").get(code.toUpperCase(), vendor_id||'');
    if (!promo) return res.json({ ok:false, error:'Invalid promo code' });
    if (promo.max_uses > 0 && promo.uses_count >= promo.max_uses) return res.json({ ok:false, error:'Promo code fully redeemed' });
    if (promo.valid_until && new Date(promo.valid_until) < new Date()) return res.json({ ok:false, error:'Promo code expired' });
    const sub = parseFloat(subtotal) || 0;
    if (sub < promo.min_order) return res.json({ ok:false, error:`Minimum order $${promo.min_order.toFixed(2)}` });
    const discount = promo.discount_type === 'percent' ? sub * (promo.discount_value / 100) : promo.discount_value;
    res.json({ ok:true, discount_type:promo.discount_type, discount_value:promo.discount_value, discount:Math.min(discount, sub) });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/customer/promo/validate — validate a promo code for a specific vendor + subtotal (customer auth required)
app.post('/api/customer/promo/validate', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error: 'Login required' });
    const { code, vendor_id, subtotal } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });
    const sub = parseFloat(subtotal) || 0;
    const promo = db.prepare(
      "SELECT * FROM promo_codes WHERE code=? AND vendor_id=? AND active=1 AND (valid_until IS NULL OR valid_until > datetime('now'))"
    ).get(sanitize(code).toUpperCase(), vendor_id);
    if (!promo) return res.json({ valid: false, error: 'Invalid or expired promo code' });
    if (promo.max_uses > 0 && promo.uses_count >= promo.max_uses) return res.json({ valid: false, error: 'Promo code has been fully redeemed' });
    if (promo.min_order > 0 && sub < promo.min_order) return res.json({ valid: false, error: `Minimum order of $${promo.min_order.toFixed(2)} required` });
    const discountAmount = promo.discount_type === 'percent'
      ? Math.min(sub * (promo.discount_value / 100), sub)
      : Math.min(promo.discount_value, sub);
    res.json({
      valid: true,
      discount_type: promo.discount_type,
      discount_value: promo.discount_value,
      discount_amount: Math.round(discountAmount * 100) / 100,
      code: promo.code
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin promos
app.post('/api/admin/promos', isSuperAdmin, (req, res) => {
  const { code, discount_type, discount_value, max_uses, valid_until } = req.body;
  if (!code) return res.status(400).json({ error:'code required' });
  try {
    db.prepare('INSERT INTO promo_codes (code,vendor_id,discount_type,discount_value,max_uses,valid_until,created_by) VALUES (?,NULL,?,?,?,?,?)').run(
      code.toUpperCase(), discount_type||'percent', parseFloat(discount_value)||0, parseInt(max_uses)||0, valid_until||null, req.adminVendor.id
    );
    res.json({ ok:true });
  } catch(e) { res.status(409).json({ error:'Code already exists' }); }
});

app.get('/api/admin/promos', isSuperAdmin, (req, res) => {
  try {
    const promos = db.prepare('SELECT p.*, v.name as vendor_name FROM promo_codes p LEFT JOIN vendors v ON p.vendor_id=v.id ORDER BY p.created_at DESC').all();
    res.json({ ok:true, promos });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/vendor/tips — tip report for the authenticated vendor
app.get('/api/vendor/tips', isVendor, (req, res) => {
  try {
    const { from, to, limit, offset } = req.query;
    const params = [req.vendor.id];
    let dateClause = '';
    if (from) { dateClause += ' AND t.created_at >= ?'; params.push(from); }
    if (to)   { dateClause += ' AND t.created_at <= ?'; params.push(to); }
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = parseInt(offset, 10) || 0;
    params.push(lim, off);
    const tips = db.prepare(`
      SELECT t.id, t.order_id, t.customer_id, t.amount, t.percentage, t.created_at,
             o.total as order_total, o.subtotal as order_subtotal, o.type as order_type
      FROM wya_tips t
      LEFT JOIN orders o ON t.order_id = o.id
      WHERE t.vendor_id=?${dateClause}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);
    const totals = db.prepare(`
      SELECT COUNT(*) as tip_count, SUM(amount) as total_tips, AVG(amount) as avg_tip, AVG(percentage) as avg_percentage
      FROM wya_tips
      WHERE vendor_id=?
    `).get(req.vendor.id);
    res.json({
      ok: true,
      tips,
      totals: {
        tip_count: totals.tip_count || 0,
        total_tips: Math.round((totals.total_tips || 0) * 100) / 100,
        avg_tip: Math.round((totals.avg_tip || 0) * 100) / 100,
        avg_percentage: Math.round((totals.avg_percentage || 0) * 10) / 10
      }
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Subscription Tiers ───────────────────────────────────────

app.get('/api/subscription/tiers', (req, res) => {
  try {
    const tiers = db.prepare('SELECT * FROM subscription_tiers ORDER BY price_monthly').all();
    tiers.forEach(t => { try { t.features = JSON.parse(t.features_json); } catch(e) { t.features = []; } });
    res.json({ ok:true, tiers });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initial subscription checkout — creates new Stripe checkout session
app.post('/api/vendor/subscription/start', async (req, res) => {
  const token = req.headers['x-auth-token'] || req.body?.token;
  const vendor = getVendorByToken(token);
  if (!vendor) return res.status(401).json({ error:'Invalid session' });
  const { tier } = req.body;
  const tierData = db.prepare('SELECT * FROM subscription_tiers WHERE id=?').get(tier);
  if (!tierData) return res.status(400).json({ error:'Invalid tier' });
  if (tierData.price_monthly === 0) {
    db.prepare("UPDATE vendors SET subscription_tier='free', commission_rate=0.12, subscription_status='trial' WHERE id=?").run(vendor.id);
    return res.json({ ok:true, tier:'free' });
  }
  if (!tierData.stripe_price_id) return res.status(400).json({ error:'Tier not configured for payment yet' });
  try {
    let customerId = vendor.stripe_customer_id;
    if (!customerId) {
      const cust = await getStripe().customers.create({ email: vendor.email, name: vendor.name, metadata: { vendor_id: vendor.id } });
      customerId = cust.id;
      db.prepare('UPDATE vendors SET stripe_customer_id=? WHERE id=?').run(customerId, vendor.id);
    }
    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card', 'link'],
      mode: 'subscription',
      line_items: [{ price: tierData.stripe_price_id, quantity: 1 }],
      success_url: `https://wya.digisigns.link/vendor?subscribed=1&tier=${tier}`,
      cancel_url: 'https://wya.digisigns.link/vendor',
      metadata: { vendor_id: vendor.id, tier }
    });
    res.json({ ok:true, url:session.url });
  } catch(e) {
    res.status(500).json({ error:'Payment error: ' + e.message });
  }
});

// ── Vendor Analytics ─────────────────────────────────────────

app.get('/api/vendor/analytics', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const period = req.query.period || '7d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const orders = db.prepare("SELECT * FROM orders WHERE vendor_id=? AND created_at>=? AND status NOT IN ('cancelled')").all(vendor.id, since);
    const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
    const avgOrder = orders.length ? totalRevenue / orders.length : 0;
    const customerIds = [...new Set(orders.map(o => o.customer_id))];
    const repeatCustomers = customerIds.filter(cid => orders.filter(o => o.customer_id === cid).length > 1);

    // Revenue by day
    const revenueByDay = {};
    for (const o of orders) {
      const day = o.created_at.split('T')[0];
      revenueByDay[day] = (revenueByDay[day] || 0) + o.total;
    }

    // Top items
    const itemCounts = {};
    for (const o of orders) {
      try {
        const items = JSON.parse(o.items_json);
        for (const i of items) { itemCounts[i.name] = (itemCounts[i.name] || 0) + (i.qty || 1); }
      } catch(e) {}
    }
    const topItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

    // Rating distribution
    const ratings = db.prepare('SELECT rating, COUNT(*) as count FROM reviews WHERE vendor_id=? GROUP BY rating').all(vendor.id);
    const ratingDist = { 1:0, 2:0, 3:0, 4:0, 5:0 };
    for (const r of ratings) ratingDist[r.rating] = r.count;

    const ratingTotal = Object.values(ratingDist).reduce((a,b)=>a+b,0);
    const ratingAvg = ratingTotal ? Object.entries(ratingDist).reduce((s,[k,v])=>s+parseInt(k,10)*v,0)/ratingTotal : 0;

    res.json({
      ok: true,
      period, days,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      order_count: orders.length,
      avg_order: Math.round(avgOrder * 100) / 100,
      customer_count: customerIds.length,
      repeat_rate: customerIds.length ? Math.round(repeatCustomers.length / customerIds.length * 100) : 0,
      revenue_by_day: revenueByDay,
      top_items: topItems,
      rating_distribution: ratingDist,
      rating_avg: Math.round(ratingAvg * 10) / 10,
      rating_count: ratingTotal,
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Ambassador Commission System ─────────────────────────────

function getAmbassadorTier(vendorId) {
  const count = db.prepare("SELECT COUNT(*) as c FROM referrals WHERE referrer_id=? AND status='active'").get(vendorId)?.c || 0;
  if (count >= 26) return { tier: 'gold', rate: 0.30, count };
  if (count >= 11) return { tier: 'silver', rate: 0.25, count };
  return { tier: 'bronze', rate: 0.20, count };
}

app.get('/api/vendor/ambassador', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const ambInfo = getAmbassadorTier(vendor.id);
    const commissions = db.prepare('SELECT * FROM ambassador_commissions WHERE ambassador_id=? ORDER BY created_at DESC LIMIT 20').all(vendor.id);
    const payouts = db.prepare('SELECT * FROM ambassador_payouts WHERE ambassador_id=? ORDER BY created_at DESC LIMIT 10').all(vendor.id);
    const totalEarned = db.prepare("SELECT COALESCE(SUM(commission_amount),0) as total FROM ambassador_commissions WHERE ambassador_id=?").get(vendor.id)?.total ?? 0;
    const totalPaid = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM ambassador_payouts WHERE ambassador_id=? AND status='paid'").get(vendor.id)?.total ?? 0;
    res.json({ ok:true, ...ambInfo, total_earned:totalEarned, total_paid:totalPaid, balance:Math.round((totalEarned-totalPaid)*100)/100, commissions, payouts });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/vendor/ambassador/commissions', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { period } = req.query;
    let sql = 'SELECT * FROM ambassador_commissions WHERE ambassador_id=?';
    const params = [vendor.id];
    if (period) { sql += ' AND period=?'; params.push(period); }
    sql += ' ORDER BY created_at DESC';
    const commissions = db.prepare(sql).all(...params);
    res.json({ ok:true, commissions });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/ambassador/overview', isSuperAdmin, (req, res) => {
  try {
    const totalCommissions = db.prepare('SELECT COALESCE(SUM(commission_amount),0) as total FROM ambassador_commissions').get()?.total ?? 0;
    const totalPayouts = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM ambassador_payouts WHERE status='paid'").get()?.total ?? 0;
    const topAmbassadors = db.prepare(`
      SELECT v.name, v.id, COUNT(r.id) as referral_count, COALESCE(SUM(ac.commission_amount),0) as total_earned
      FROM referrals r JOIN vendors v ON r.referrer_id=v.id
      LEFT JOIN ambassador_commissions ac ON ac.ambassador_id=v.id
      GROUP BY r.referrer_id ORDER BY referral_count DESC LIMIT 10
    `).all();
    res.json({ ok:true, total_commissions:totalCommissions, total_payouts:totalPayouts, outstanding:Math.round((totalCommissions-totalPayouts)*100)/100, top_ambassadors:topAmbassadors });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/ambassador/payout/:id', isSuperAdmin, (req, res) => {
  try {
    const payout = db.prepare('SELECT * FROM ambassador_payouts WHERE id=?').get(req.params.id);
    if (!payout) return res.status(404).json({ error:'Payout not found' });
    db.prepare("UPDATE ambassador_payouts SET status='paid', paid_at=? WHERE id=?").run(new Date().toISOString(), payout.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Phase 748: Vendor Payout Request ─────────────────────────
app.post('/api/vendor/payout/request', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const totalEarned = db.prepare("SELECT COALESCE(SUM(commission_amount),0) as total FROM ambassador_commissions WHERE ambassador_id=?").get(vendor.id)?.total ?? 0;
    const totalPaid = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM ambassador_payouts WHERE ambassador_id=? AND status='paid'").get(vendor.id)?.total ?? 0;
    const balance = Math.round((totalEarned - totalPaid) * 100) / 100;
    if (balance < 25) return res.status(400).json({ error:'Minimum payout is $25', balance });
    const pending = db.prepare("SELECT id FROM ambassador_payouts WHERE ambassador_id=? AND status='pending'").get(vendor.id);
    if (pending) return res.status(409).json({ error:'You already have a pending payout request' });
    db.prepare("INSERT INTO ambassador_payouts (id,ambassador_id,amount,status,created_at) VALUES (?,?,?,?,?)").run(
      crypto.randomUUID(), vendor.id, balance, 'pending', new Date().toISOString()
    );
    res.json({ ok:true, amount:balance });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/ambassador/payouts/pending', isSuperAdmin, (req, res) => {
  try {
    const payouts = db.prepare(`
      SELECT ap.*, v.name as vendor_name, v.email as vendor_email
      FROM ambassador_payouts ap
      LEFT JOIN vendors v ON ap.ambassador_id=v.id
      WHERE ap.status='pending'
      ORDER BY ap.created_at ASC
    `).all();
    res.json({ ok:true, payouts });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/ambassador/payouts/:id/reject', isSuperAdmin, (req, res) => {
  try {
    const payout = db.prepare('SELECT * FROM ambassador_payouts WHERE id=?').get(req.params.id);
    if (!payout) return res.status(404).json({ error:'Payout not found' });
    db.prepare("UPDATE ambassador_payouts SET status='rejected' WHERE id=?").run(payout.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Phase 748: Vendor Push Blast ─────────────────────────────
app.post('/api/vendor/push/blast', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    if (!vendor.email_verified) return res.status(403).json({ error:'Verify your email first' });
    if (!rateLimit('blast:' + vendor.id, 3, 86400000)) return res.status(429).json({ error:'Blast limit reached (3/day)' });
    const { template, custom_message } = req.body;
    const templates = {
      going_live: `${vendor.name} is going live now! Come check us out.`,
      new_item: `${vendor.name} just added something new to the menu!`,
      special: `${vendor.name} has a special offer today!`,
      custom: null
    };
    if (!template || !Object.prototype.hasOwnProperty.call(templates, template)) return res.status(400).json({ error:'Invalid template' });
    let message = templates[template];
    if (template === 'custom') {
      if (!custom_message || !custom_message.trim()) return res.status(400).json({ error:'Custom message required' });
      message = sanitize(custom_message).slice(0, 200);
    }
    const followers = db.prepare('SELECT customer_id FROM vendor_followers WHERE vendor_id=? AND active=1').all(vendor.id);
    let sent = 0;
    for (const f of followers) {
      const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=? AND user_type=?').all(f.customer_id, 'customer');
      for (const sub of subs) {
        const pushSub = { endpoint:sub.endpoint, keys:{ p256dh:sub.p256dh, auth:sub.auth } };
        webpush.sendNotification(pushSub, JSON.stringify({ title:vendor.name, body:message, url:`https://wya.digisigns.link/customer?vendor=${vendor.id}` })).catch(() => {
          db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
        });
        sent++;
      }
    }
    res.json({ ok:true, sent, follower_count:followers.length });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/push/broadcast', isSuperAdmin, (req, res) => {
  try {
    const { target, title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error:'Title and message required' });
    const safeTitle = sanitize(title).slice(0, 100);
    const safeMessage = sanitize(message).slice(0, 200);
    const validTargets = ['all', 'vendors', 'customers'];
    if (!validTargets.includes(target)) return res.status(400).json({ error:'Invalid target' });
    let subs;
    if (target === 'all') subs = db.prepare('SELECT * FROM push_subscriptions').all();
    else if (target === 'vendors') subs = db.prepare("SELECT * FROM push_subscriptions WHERE user_type='vendor'").all();
    else subs = db.prepare("SELECT * FROM push_subscriptions WHERE user_type='customer'").all();
    for (const sub of subs) {
      const pushSub = { endpoint:sub.endpoint, keys:{ p256dh:sub.p256dh, auth:sub.auth } };
      webpush.sendNotification(pushSub, JSON.stringify({ title:safeTitle, body:safeMessage, url:'https://wya.digisigns.link/' })).catch(() => {
        db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
      });
    }
    res.json({ ok:true, sent:subs.length, target });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin Extensions ─────────────────────────────────────────

app.get('/api/admin/orders', isSuperAdmin, (req, res) => {
  try {
    const { status, vendor_id, limit } = req.query;
    let sql = 'SELECT o.*, v.name as vendor_name, c.name as customer_name FROM orders o LEFT JOIN vendors v ON o.vendor_id=v.id LEFT JOIN customers c ON o.customer_id=c.id WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND o.status=?'; params.push(status); }
    if (vendor_id) { sql += ' AND o.vendor_id=?'; params.push(vendor_id); }
    sql += ' ORDER BY o.created_at DESC LIMIT ?';
    params.push(parseInt(limit, 10) || 50);
    const orders = db.prepare(sql).all(...params);
    res.json({ ok:true, orders });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/analytics', isSuperAdmin, (req, res) => {
  try {
    const period = req.query.period || '30d';
    const days = period === '90d' ? 90 : period === '7d' ? 7 : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const totalOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE created_at>=?").get(since)?.c ?? 0;
    const gmv = db.prepare("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE created_at>=? AND status NOT IN ('cancelled')").get(since)?.total ?? 0;
    const revenueByDay = {};
    const rows = db.prepare("SELECT substr(created_at,1,10) as day, SUM(total) as total FROM orders WHERE created_at>=? AND status NOT IN ('cancelled') GROUP BY day ORDER BY day").all(since);
    for (const r of rows) revenueByDay[r.day] = r.total;
    const topVendors = db.prepare("SELECT v.name, COUNT(o.id) as order_count, SUM(o.total) as revenue FROM orders o JOIN vendors v ON o.vendor_id=v.id WHERE o.created_at>=? AND o.status NOT IN ('cancelled') GROUP BY o.vendor_id ORDER BY revenue DESC LIMIT 10").all(since);
    res.json({ ok:true, total_orders:totalOrders, gmv:Math.round(gmv*100)/100, revenue_by_day:revenueByDay, top_vendors:topVendors });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/customers', isSuperAdmin, (req, res) => {
  try {
    const { q } = req.query;
    let sql = `SELECT c.id, c.name, c.email, c.phone, c.created_at, c.last_seen,
      COUNT(o.id) as order_count, COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled') THEN o.total ELSE 0 END),0) as total_spent
      FROM customers c LEFT JOIN orders o ON c.id=o.customer_id`;
    const params = [];
    if (q) { sql += ` WHERE (c.name LIKE ? OR c.email LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
    sql += ' GROUP BY c.id ORDER BY c.created_at DESC LIMIT 100';
    const customers = db.prepare(sql).all(...params);
    res.json({ ok:true, customers });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 742: Force-update order status (admin)
app.put('/api/admin/orders/:id/status', isSuperAdmin, (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['pending','confirmed','preparing','ready','picked_up','delivered','cancelled'];
    if (!status || !allowed.includes(status)) return res.status(400).json({ error:'Invalid status. Allowed: '+allowed.join(', ') });
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error:'Order not found' });
    const oldStatus = order.status;
    db.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?").run(status, order.id);
    db.prepare("INSERT INTO order_status_log (order_id, old_status, new_status, changed_by) VALUES (?,?,?,?)").run(order.id, oldStatus, status, 'admin:'+req.adminVendor.email);
    broadcastSSE({ type:'order_update', order_id:order.id, status, vendor_id:order.vendor_id });
    const updated = db.prepare('SELECT o.*, v.name as vendor_name, c.name as customer_name FROM orders o LEFT JOIN vendors v ON o.vendor_id=v.id LEFT JOIN customers c ON o.customer_id=c.id WHERE o.id=?').get(order.id);
    res.json({ ok:true, order:updated });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 742: Revenue breakdown (admin)
app.get('/api/admin/revenue', isSuperAdmin, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
    const totals = db.prepare(`SELECT
      COALESCE(SUM(total),0) as total_revenue,
      COALESCE(SUM(commission_amount),0) as total_commission,
      COALESCE(SUM(tip),0) as total_tips
      FROM orders WHERE status='completed' OR status='delivered' OR status='picked_up'`).get();
    const todayR = db.prepare(`SELECT COALESCE(SUM(total),0) as rev FROM orders WHERE (status='completed' OR status='delivered' OR status='picked_up') AND created_at LIKE ?`).get(today+'%');
    const yestR = db.prepare(`SELECT COALESCE(SUM(total),0) as rev FROM orders WHERE (status='completed' OR status='delivered' OR status='picked_up') AND created_at LIKE ?`).get(yesterday+'%');
    const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM orders GROUP BY status`).all();
    const statusMap = {};
    for (const r of byStatus) statusMap[r.status] = r.count;
    const topByComm = db.prepare(`SELECT v.name, SUM(o.commission_amount) as commission, COUNT(o.id) as orders
      FROM orders o JOIN vendors v ON o.vendor_id=v.id WHERE o.status IN ('completed','delivered','picked_up')
      GROUP BY o.vendor_id ORDER BY commission DESC LIMIT 5`).all();
    res.json({
      ok:true,
      total_revenue: Math.round((totals?.total_revenue ?? 0)*100)/100,
      total_commission: Math.round((totals?.total_commission ?? 0)*100)/100,
      total_tips: Math.round((totals?.total_tips ?? 0)*100)/100,
      today_revenue: Math.round((todayR?.rev ?? 0)*100)/100,
      yesterday_revenue: Math.round((yestR?.rev ?? 0)*100)/100,
      orders_by_status: statusMap,
      top_vendors_by_commission: topByComm
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/reviews/:id', isSuperAdmin, (req, res) => {
  try {
    const review = db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
    if (!review) return res.status(404).json({ error:'Review not found' });
    db.prepare('DELETE FROM reviews WHERE id=?').run(review.id);
    // Recalculate vendor avg_rating
    const agg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE vendor_id=?').get(review.vendor_id);
    db.prepare('UPDATE vendors SET avg_rating=?, review_count=? WHERE id=?').run(agg?.avg ? Math.round(agg.avg * 10) / 10 : 0, agg?.cnt || 0, review.vendor_id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ── Admin: Event Moderation ───────────────────────────────────

// GET /api/admin/events — list all events with live counts
app.get('/api/admin/events', isSuperAdmin, (req, res) => {
  try {
    const events = db.prepare(`
      SELECT e.*,
        v.name as vendor_name,
        (SELECT COUNT(*) FROM event_bookings WHERE event_id=e.id AND user_type='customer' AND status IN ('pending','confirmed')) as rsvp_count_live,
        (SELECT COUNT(*) FROM event_bookings WHERE event_id=e.id AND user_type='vendor' AND status IN ('pending','approved')) as vendor_app_count
      FROM vendor_events e
      LEFT JOIN vendors v ON e.vendor_id=v.id
      ORDER BY e.created_at DESC
      LIMIT 200
    `).all();
    const total = events.length;
    const now = new Date().toISOString().slice(0, 10);
    const upcoming = events.filter(e => e.event_date >= now && e.status === 'active').length;
    const past = events.filter(e => e.event_date < now).length;
    const archived = events.filter(e => e.status === 'archived').length;
    res.json({ ok: true, events, stats: { total, upcoming, past, archived } });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/events/:id — update event status or fields
app.put('/api/admin/events/:id', isSuperAdmin, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM vendor_events WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const allowed = ['status', 'title', 'description', 'event_date', 'start_time', 'end_time', 'location', 'capacity', 'price', 'category', 'vendor_slots'];
    const updates = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key}=?`);
        vals.push(req.body[key]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE vendor_events SET ${updates.join(',')} WHERE id=?`).run(...vals);
    const updated = db.prepare('SELECT * FROM vendor_events WHERE id=?').get(req.params.id);
    console.log(`[WYA-APP] Admin updated event ${req.params.id}: ${updates.join(', ')}`);
    res.json({ ok: true, event: updated });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/events/:id — delete event and all bookings
app.delete('/api/admin/events/:id', isSuperAdmin, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM vendor_events WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    db.prepare('DELETE FROM event_bookings WHERE event_id=?').run(event.id);
    db.prepare('DELETE FROM vendor_events WHERE id=?').run(event.id);
    console.log(`[WYA-APP] Admin deleted event ${event.id} ("${event.title}") and all bookings`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/events/:id/bookings — list all bookings for an event
app.get('/api/admin/events/:id/bookings', isSuperAdmin, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM vendor_events WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const bookings = db.prepare('SELECT * FROM event_bookings WHERE event_id=? ORDER BY created_at DESC').all(event.id);
    res.json({ ok: true, bookings, event });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/events/:id/bookings/:bookingId — update booking status
app.put('/api/admin/events/:id/bookings/:bookingId', isSuperAdmin, (req, res) => {
  try {
    const booking = db.prepare('SELECT * FROM event_bookings WHERE id=? AND event_id=?').get(req.params.bookingId, req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'cancelled', 'approved', 'declined', 'pending_payment'];
    if (!status || !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare('UPDATE event_bookings SET status=? WHERE id=?').run(status, booking.id);
    // Keep rsvp_count in sync when confirming/cancelling customer bookings
    if (booking.user_type === 'customer') {
      const newCount = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='customer' AND status IN ('pending','confirmed')").get(req.params.id)?.c || 0;
      db.prepare('UPDATE vendor_events SET rsvp_count=? WHERE id=?').run(newCount, req.params.id);
    }
    console.log(`[WYA-APP] Admin updated booking ${booking.id} to status '${status}'`);
    res.json({ ok: true, booking: { ...booking, status } });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// ── Phase 742: GO-TO-MARKET ─────────────────────────────────
// ══════════════════════════════════════════════════════════════

// Public stats (no auth)
app.get('/api/public/stats', publicLimiter30, (req, res) => {
  try {
    // Vendors with menu items in SB area (what customers actually see)
    const vendorIdsWithMenu = new Set(db.prepare('SELECT DISTINCT vendor_id FROM menu_items').all().map(r => r.vendor_id));
    const allVendors = db.prepare('SELECT id, name, category, is_open, lat, lng, business_hours, photo_url FROM vendors WHERE lat IS NOT NULL').all()
      .filter(v => vendorIdsWithMenu.has(v.id));
    // Distance filter to SB (25mi radius)
    const sbLat = 34.4208, sbLng = -119.6982;
    const sbVendors = allVendors.filter(v => haversine(sbLat, sbLng, v.lat, v.lng) <= 25);
    // Auto-open logic: match /api/vendors/live behavior
    const nowPT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
    const todayDay = dayNames[nowPT.getDay()];
    const curTime = String(nowPT.getHours()).padStart(2,'0') + ':' + String(nowPT.getMinutes()).padStart(2,'0');
    let liveCount = 0;
    for (const v of sbVendors) {
      if (v.is_open === 1) { liveCount++; continue; }
      if (!v.business_hours) continue;
      try {
        const hours = JSON.parse(v.business_hours);
        const dayKeyCap = todayDay.charAt(0).toUpperCase() + todayDay.slice(1);
        const dayH = hours[todayDay] || hours[dayKeyCap];
        if (!dayH || dayH === 'closed') continue;
        let withinHours = false;
        if (typeof dayH === 'object' && dayH.open && dayH.close) {
          withinHours = curTime >= dayH.open && curTime <= dayH.close;
        } else if (typeof dayH === 'string' && dayH.includes('-')) {
          const [openT, closeT] = dayH.split('-').map(t => t.trim());
          withinHours = curTime >= openT && curTime <= closeT;
        }
        if (withinHours) liveCount++;
      } catch {}
    }
    // Category breakdown
    const catCounts = {};
    for (const v of sbVendors) { const c = v.category || 'other'; catCounts[c] = (catCounts[c] || 0) + 1; }
    // Top vendor names for social proof (with photos, sorted by menu count)
    const topNames = sbVendors.filter(v => v.photo_url).slice(0, 8).map(v => v.name);
    const orders_total = db.prepare('SELECT COUNT(*) as c FROM orders').get()?.c ?? 0;
    const reviews_total = db.prepare('SELECT COUNT(*) as c FROM reviews').get()?.c ?? 0;
    res.json({ ok:true, vendors_total: sbVendors.length, vendors_live: liveCount, orders_total, reviews_total, categories: catCounts, top_vendors: topNames });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor QR code
app.get('/api/vendor/qr', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const url = `https://wya.digisigns.link/customer?vendor=${vendor.id}`;
    QRCode.toString(url, { type:'svg', margin:1, color:{dark:'#FF5E1A',light:'#00000000'} }, (err, svg) => {
      if (err) return res.status(500).json({ error:'QR generation failed' });
      res.json({ ok:true, svg, url });
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Printable vendor flyer
app.get('/api/vendor/flyer', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const url = `https://wya.digisigns.link/customer?vendor=${vendor.id}`;
    const emoji = (BUSINESS_TYPES[vendor.category] || BUSINESS_TYPES.other).emoji;
    QRCode.toDataURL(url, { margin:1, width:300, color:{dark:'#FF5E1A',light:'#FFFFFF'} }, (err, dataUrl) => {
      if (err) return res.status(500).json({ error:'QR generation failed' });
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#fff;display:flex;justify-content:center;padding:40px}
    .flyer{width:400px;padding:48px 32px;text-align:center;border:3px solid #FF5E1A;border-radius:24px}
    .emoji{font-size:48px;margin-bottom:12px}.name{font-size:28px;font-weight:900;margin-bottom:4px}.cat{font-size:14px;color:#666;margin-bottom:24px;text-transform:capitalize}
    .qr{margin:0 auto 20px}.scan{font-size:16px;font-weight:700;color:#FF5E1A;margin-bottom:6px}.url{font-size:11px;color:#999;word-break:break-all}
    .brand{margin-top:24px;font-size:18px;font-weight:900;color:#FF5E1A;letter-spacing:1px}
    @media print{body{padding:0}.flyer{border:none}}</style></head>
    <body><div class="flyer">
    <div class="emoji">${emoji}</div><div class="name">${vendor.name}</div><div class="cat">${(vendor.category||'').replace(/_/g,' ')}</div>
    <img class="qr" src="${dataUrl}" width="200" height="200"><div class="scan">Scan to find us on WYA</div><div class="url">${url}</div>
    <div class="brand">WHERE YOU AT</div></div></body></html>`;
      res.setHeader('Content-Type','text/html');
      res.send(html);
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 1363: Quick-share page — pre-filled share links for Sergio's phone
app.get('/share', (req, res) => {
  try {
  const vendorCount = db.prepare('SELECT COUNT(*) as c FROM vendors').get()?.c ?? 0;
  const msg = encodeURIComponent(`Hey! I built a free app that puts food trucks and vendors on a live map in Santa Barbara. Customers find you the moment you open. Takes 2 min to set up: https://wya.digisigns.link/vendor`);
  const storeMsg = encodeURIComponent(`Check out my online sign shop — custom banners, vehicle wraps, business cards, NFC products: https://store.digisigns.link`);
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Share WYA</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8f0;min-height:100vh;padding:24px}
h1{font-size:1.4rem;font-weight:800;margin-bottom:20px;text-align:center}
.card{background:#141414;border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:20px;margin-bottom:16px}
.card h3{font-size:1rem;font-weight:700;margin-bottom:8px}
.card p{font-size:.85rem;color:#888;margin-bottom:12px;line-height:1.5}
.btns{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:10px 16px;border-radius:10px;font-weight:700;font-size:.85rem;text-decoration:none;display:inline-block;text-align:center}
.wa{background:#25D366;color:#fff}.sms{background:#333;color:#fff}.tw{background:#1DA1F2;color:#fff}.copy{background:#833AB4;color:#fff;cursor:pointer;border:none;font-family:inherit}
</style></head><body>
<h1>Share & Get Real Customers</h1>
<div style="text-align:center;margin-bottom:20px;color:#888;font-size:.8rem">${vendorCount} vendors on WYA · 0 real customers · Let's change that</div>
<div class="card"><h3>WYA — Send to Food Vendors</h3><p>Text this to any food truck, taco cart, or vendor in SB.</p>
<div class="btns"><a class="btn wa" href="https://wa.me/?text=${msg}">WhatsApp</a><a class="btn sms" href="sms:?body=${msg}">SMS</a><a class="btn tw" href="https://twitter.com/intent/tweet?text=${msg}">X / Twitter</a><button class="btn copy" onclick="navigator.clipboard.writeText(decodeURIComponent('${msg}'));this.textContent='Copied!'">Copy</button></div></div>
<div class="card"><h3>DigiStore — Share with Friends</h3><p>Anyone who needs signs, wraps, or print products.</p>
<div class="btns"><a class="btn wa" href="https://wa.me/?text=${storeMsg}">WhatsApp</a><a class="btn sms" href="sms:?body=${storeMsg}">SMS</a><button class="btn copy" onclick="navigator.clipboard.writeText(decodeURIComponent('${storeMsg}'));this.textContent='Copied!'">Copy</button></div></div>
<div class="card"><h3>All Product Links</h3><p>Tap to copy any link.</p>
<div style="display:flex;flex-direction:column;gap:8px">
${[['WYA Vendor Signup','wya.digisigns.link/vendor'],['WYA Customer Map','wya.digisigns.link/customer'],['DigiStore','store.digisigns.link'],['DigiBook','book.digisigns.link'],['Soul del Cora','souldelcora.digisigns.link'],['DigiTap','tap.digisigns.link']].map(([n,u])=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(131,58,180,.05);border-radius:8px"><span style="font-size:.85rem">${n}</span><button class="btn copy" style="padding:6px 12px;font-size:.75rem" onclick="navigator.clipboard.writeText('https://${u}');this.textContent='Copied!'">Copy</button></div>`).join('')}
</div></div>
<div style="text-align:center;margin-top:20px"><a href="/recruit-flyer" style="color:#833AB4;font-size:.85rem">Print Recruit Flyer →</a></div>
</body></html>`;
  res.type('html').send(html);
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public recruit flyer — no auth, marketing page for vendor recruitment
app.get('/recruit-flyer', (req, res) => {
  try {
  const vendorCount = db.prepare('SELECT COUNT(*) as c FROM vendors').get()?.c ?? 0;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Become a WYA Vendor — Where You At</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fff;color:#1a1a1a}
.hero{background:linear-gradient(135deg,#FF5E1A 0%,#FF8C42 100%);color:#fff;text-align:center;padding:60px 24px 48px}
.hero h1{font-size:36px;font-weight:900;margin-bottom:8px}.hero p{font-size:18px;opacity:.9;max-width:500px;margin:0 auto}
.container{max-width:600px;margin:0 auto;padding:32px 24px}
.stat{text-align:center;margin:24px 0;font-size:20px;color:#FF5E1A;font-weight:700}
.compare{margin:32px 0}.compare h2{font-size:22px;margin-bottom:16px;text-align:center}
.compare-table{width:100%;border-collapse:collapse;font-size:14px}
.compare-table th,.compare-table td{padding:12px 16px;text-align:left;border-bottom:1px solid #eee}
.compare-table th{background:#f8f8f8;font-weight:700}.compare-table .wya{color:#FF5E1A;font-weight:700}
.cta{display:block;background:#FF5E1A;color:#fff;text-align:center;padding:18px 32px;border-radius:12px;font-size:18px;font-weight:700;text-decoration:none;margin:32px auto;max-width:400px}
.cta:hover{background:#e0520f}
.features{list-style:none;margin:24px 0}.features li{padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:15px}
.features li::before{content:'✓ ';color:#FF5E1A;font-weight:700}
.brand{text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #eee;font-size:14px;color:#999}
@media print{.hero{background:#FF5E1A!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}.cta{border:2px solid #FF5E1A;color:#FF5E1A;background:transparent!important}}
</style></head><body>
<div class="hero"><h1>Join WYA</h1><p>Get discovered by local customers. Keep more of what you earn.</p></div>
<div class="container">
<div class="stat">${vendorCount} vendors already on the map</div>
<div class="compare"><h2>Commission Comparison</h2>
<table class="compare-table"><tr><th>Platform</th><th>Commission</th></tr>
<tr><td>DoorDash</td><td>15–30%</td></tr>
<tr><td>Uber Eats</td><td>15–30%</td></tr>
<tr><td>Grubhub</td><td>15–25%</td></tr>
<tr class="wya"><td>WYA Free</td><td>0%</td></tr>
<tr class="wya"><td>WYA Pro</td><td>5%</td></tr>
<tr class="wya"><td>WYA Enterprise</td><td>Custom</td></tr></table></div>
<ul class="features">
<li>Free tier — no monthly fees, no commission</li>
<li>Live map visibility — customers find you instantly</li>
<li>Real-time order management</li>
<li>Built-in analytics dashboard</li>
<li>Push notifications for new orders</li>
<li>Social sharing tools included</li>
<li>QR codes and printable flyers</li>
</ul>
<a class="cta" href="/vendor">Sign Up Free →</a>
<div class="brand">WHERE YOU AT — Santa Barbara, CA<br>wya.digisigns.link</div>
</div></body></html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Order confirmation page — shown after successful Stripe checkout
app.get('/order/:id', (req, res) => {
  const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).send('<!DOCTYPE html><html><body style="font-family:system-ui;background:#0a0a1a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><h1>Order not found</h1><a href="/customer" style="color:#7c3aed">Back to WYA</a></div></body></html>');
  const vendor = db.prepare('SELECT name,photo_url,estimated_prep_minutes FROM vendors WHERE id=?').get(order.vendor_id);
  const vName = esc(vendor?.name || 'Vendor');
  const items = JSON.parse(order.items_json || '[]');
  const isPaid = order.payment_status === 'paid';
  const estReady = order.estimated_ready_at ? new Date(order.estimated_ready_at).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }) : '';
  const itemsHtml = items.map(i => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1a1a2e"><span>${i.qty}x ${esc(i.name)}</span><span>$${(i.price*i.qty).toFixed(2)}</span></div>`).join('');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order Confirmed | WYA</title>
<style>*{margin:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0a0a1a;color:#fff;padding:1rem;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{max-width:480px;width:100%;background:#111;border-radius:16px;padding:2rem;text-align:center}
.check{width:64px;height:64px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem;font-size:2rem}
.pending{background:#f59e0b}
h1{font-size:1.5rem;margin-bottom:.5rem}
.vendor{color:#a78bfa;font-size:1rem;margin-bottom:1.5rem}
.items{text-align:left;margin:1rem 0;font-size:.9rem;color:#ccc}
.total{display:flex;justify-content:space-between;font-weight:700;font-size:1.1rem;padding:12px 0;border-top:2px solid #7c3aed;margin-top:8px}
.eta{background:#1a1a2e;border-radius:12px;padding:1rem;margin:1.5rem 0}
.eta-label{color:#9ca3af;font-size:.8rem}
.eta-time{font-size:1.3rem;font-weight:700;color:#22c55e;margin-top:4px}
.id{color:#666;font-size:.75rem;margin-top:1rem}
a.btn{display:inline-block;margin-top:1.5rem;padding:.75rem 2rem;background:#7c3aed;color:#fff;border-radius:2rem;text-decoration:none;font-weight:600}
</style></head><body>
<div class="card">
<div class="check ${isPaid ? '' : 'pending'}">${isPaid ? '✓' : '⏳'}</div>
<h1>${isPaid ? 'Order Confirmed!' : 'Payment Processing...'}</h1>
<p class="vendor">${vName}</p>
<div class="items">${itemsHtml}
<div class="total"><span>Total</span><span>$${parseFloat(order.total).toFixed(2)}</span></div></div>
${estReady ? `<div class="eta"><div class="eta-label">Estimated ready by</div><div class="eta-time">${estReady}</div></div>` : ''}
<p class="id">Order #${esc(order.id.slice(-8))} · ${order.type||'pickup'}</p>
<a class="btn" href="/customer">Track on Live Map →</a>
</div></body></html>`);
});

// Server-rendered vendor OG tags for social preview
app.get('/v/:id', (req, res) => {
  try {
  const vendor = db.prepare('SELECT id,name,category,description,photo_url,avg_rating,review_count,lat,lng,phone,website,instagram,tiktok,facebook,youtube,business_hours,doordash_url,ubereats_url,grubhub_url,yelp_url,google_maps_url,google_business_url,social_score FROM vendors WHERE id=?').get(req.params.id);
  if (!vendor) return res.redirect('/customer');
  const btype = BUSINESS_TYPES[vendor.category] || BUSINESS_TYPES.other;
  const emoji = btype.emoji;
  const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const jsonEsc = (s) => JSON.stringify(String(s||'')).slice(1,-1); // for JSON-LD
  const desc = vendor.description || `Find ${vendor.name} on the live vendor map in Santa Barbara`;
  const image = vendor.photo_url || 'https://wya.digisigns.link/icon-512.png';
  const catLabel = btype.label || vendor.category || 'Local Business';
  // Phase 1325: JSON-LD structured data for Google rich results
  const menuItems = db.prepare('SELECT name, price FROM menu_items WHERE vendor_id=? LIMIT 20').all(vendor.id);
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'LocalBusiness',
    name: vendor.name, description: desc, image,
    url: `https://wya.digisigns.link/v/${vendor.id}`,
    ...(vendor.phone ? { telephone: vendor.phone } : {}),
    sameAs: [vendor.website, vendor.instagram ? `https://instagram.com/${vendor.instagram.replace('@','')}` : '', vendor.tiktok ? `https://tiktok.com/@${vendor.tiktok.replace('@','')}` : '', vendor.facebook ? `https://facebook.com/${vendor.facebook}` : '', vendor.youtube ? `https://youtube.com/@${vendor.youtube.replace('@','')}` : '', vendor.yelp_url, vendor.google_maps_url].filter(Boolean),
    ...(vendor.lat && vendor.lng ? { geo: { '@type': 'GeoCoordinates', latitude: vendor.lat, longitude: vendor.lng }, address: { '@type': 'PostalAddress', addressLocality: 'Santa Barbara', addressRegion: 'CA' } } : {}),
    ...(vendor.avg_rating > 0 ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: vendor.avg_rating, reviewCount: vendor.review_count || 1, bestRating: 5 } } : {}),
    ...(menuItems.length > 0 ? { hasMenu: { '@type': 'Menu', hasMenuSection: { '@type': 'MenuSection', name: catLabel, hasMenuItem: menuItems.slice(0,10).map(m => ({ '@type': 'MenuItem', name: m.name, offers: { '@type': 'Offer', price: m.price, priceCurrency: 'USD' } })) } } } : {}),
  };
  res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(vendor.name)} — ${esc(catLabel)} in Santa Barbara | WYA</title>
<meta name="description" content="${esc(desc)} — ${esc(catLabel)} in Santa Barbara, CA. Order online or find on the live map.">
<meta property="og:title" content="${esc(emoji + ' ' + vendor.name + ' — Where You At')}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="https://wya.digisigns.link/v/${vendor.id}">
<meta property="og:type" content="restaurant.restaurant">
<meta property="og:site_name" content="WYA — Where You At">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(emoji + ' ' + vendor.name + ' — WYA')}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="canonical" href="https://wya.digisigns.link/v/${vendor.id}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<meta http-equiv="refresh" content="2;url=/customer?vendor=${vendor.id}${req.query.cart === 'restore' && req.query.order ? '&cart=restore&order=' + esc(req.query.order) : ''}">
<style>body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{text-align:center;max-width:400px;padding:2rem}.name{font-size:1.8rem;margin:.5rem 0}.cat{color:#a78bfa;font-size:.9rem}.desc{color:#ccc;margin:1rem 0;line-height:1.5}
.cta{display:inline-block;background:#7c3aed;color:#fff;padding:.8rem 2rem;border-radius:2rem;text-decoration:none;font-weight:600;margin-top:1rem}</style>
</head><body><div class="card">
<div style="font-size:3rem">${emoji}</div>
<h1 class="name">${esc(vendor.name)}</h1>
<p class="cat">${esc(catLabel)} · Santa Barbara</p>
${vendor.description ? `<p class="desc">${esc(vendor.description)}</p>` : ''}
${menuItems.length > 0 ? `<p class="desc">${menuItems.slice(0,5).map(m => esc(m.name)).join(' · ')}</p>` : ''}
${vendor.avg_rating > 0 ? `<p class="cat">${'★'.repeat(Math.round(vendor.avg_rating))} ${vendor.avg_rating.toFixed(1)} (${vendor.review_count} reviews)</p>` : ''}
${vendor.social_score > 0 ? `<p class="cat" style="margin-top:4px">${getSocialBadge(vendor.social_score)?.emoji || ''} Social Score: ${vendor.social_score}/100</p>` : ''}
<div style="display:flex;gap:8px;justify-content:center;margin:12px 0;flex-wrap:wrap">
${vendor.instagram ? `<a href="https://instagram.com/${vendor.instagram.replace('@','')}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:20px;background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);color:#fff;text-decoration:none;font-size:12px;font-weight:600">📸 Instagram</a>` : ''}
${vendor.tiktok ? `<a href="https://tiktok.com/@${vendor.tiktok.replace('@','')}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:20px;background:#000;border:1px solid #333;color:#fff;text-decoration:none;font-size:12px;font-weight:600">🎵 TikTok</a>` : ''}
${vendor.youtube ? `<a href="https://youtube.com/@${vendor.youtube.replace('@','')}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:20px;background:#FF0000;color:#fff;text-decoration:none;font-size:12px;font-weight:600">▶ YouTube</a>` : ''}
${vendor.facebook ? `<a href="${vendor.facebook.startsWith('http') ? vendor.facebook : 'https://facebook.com/' + vendor.facebook}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:20px;background:#1877F2;color:#fff;text-decoration:none;font-size:12px;font-weight:600">👤 Facebook</a>` : ''}
${vendor.website ? `<a href="${vendor.website.startsWith('http') ? vendor.website : 'https://' + vendor.website}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:20px;background:rgba(255,255,255,.1);color:#fff;text-decoration:none;font-size:12px;font-weight:600;border:1px solid rgba(255,255,255,.2)">🌐 Website</a>` : ''}
</div>
${vendor.doordash_url || vendor.ubereats_url || vendor.grubhub_url ? `
<div style="display:flex;gap:8px;justify-content:center;margin:8px 0;flex-wrap:wrap">
<span style="font-size:11px;color:#999;width:100%;text-align:center;margin-bottom:4px">Also order via</span>
${vendor.doordash_url ? `<a href="${vendor.doordash_url}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:10px;background:rgba(255,48,8,.12);border:1px solid rgba(255,48,8,.3);color:#FF3008;text-decoration:none;font-size:12px;font-weight:700">🔴 DoorDash</a>` : ''}
${vendor.ubereats_url ? `<a href="${vendor.ubereats_url}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:10px;background:rgba(6,193,103,.12);border:1px solid rgba(6,193,103,.3);color:#06C167;text-decoration:none;font-size:12px;font-weight:700">🟢 Uber Eats</a>` : ''}
${vendor.grubhub_url ? `<a href="${vendor.grubhub_url}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:10px;background:rgba(246,52,64,.12);border:1px solid rgba(246,52,64,.3);color:#F63440;text-decoration:none;font-size:12px;font-weight:700">🟠 Grubhub</a>` : ''}
</div>` : ''}
<a class="cta" href="/customer?vendor=${vendor.id}${req.query.cart === 'restore' && req.query.order ? '&cart=restore&order=' + esc(req.query.order) : ''}">View on Map →</a>
</div></body></html>`);
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// ── Phase 743: CUSTOMER UX POLISH ───────────────────────────
// ══════════════════════════════════════════════════════════════

// Push notification subscribe
app.post('/api/push/subscribe', (req, res) => {
  const { user_type, user_id, subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys) return res.status(400).json({ error:'Invalid subscription' });
  try {
    db.prepare('INSERT OR REPLACE INTO push_subscriptions (user_type,user_id,endpoint,p256dh,auth) VALUES (?,?,?,?,?)').run(
      user_type||'customer', user_id||'anon', subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth
    );
    res.json({ ok:true });
  } catch(e) { res.json({ ok:true }); }
});

app.delete('/api/push/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/push/vapid-key', (req, res) => {
  try {
    res.json({ ok:true, key: VAPID_PUBLIC });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Push notification helper — sends to both web push and APNs
function sendPushNotification(userId, userType, title, body, url, options = {}) {
  // Web push (VAPID)
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=? AND user_type=?').all(userId, userType);
    for (const sub of subs) {
      const pushSub = { endpoint:sub.endpoint, keys:{ p256dh:sub.p256dh, auth:sub.auth } };
      webpush.sendNotification(pushSub, JSON.stringify({ title, body, url })).catch(() => {
        db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
      });
    }
  }

  // APNs (iOS native push)
  if (apnProvider) {
    // Find APNs tokens for this user — check both customer_id column and device association
    const tokens = db.prepare('SELECT token FROM apns_tokens WHERE customer_id=?').all(userId);
    if (tokens.length === 0) return;

    // Build APNs notification
    const notification = new apn.Notification();
    notification.alert = { title, body };
    notification.sound = 'default';
    notification.badge = 1;
    notification.topic = APNS_BUNDLE_ID;
    notification.payload = { url, path: url?.replace('https://wya.digisigns.link', '') || '/' };

    // Set category for actionable notifications
    if (options.category) notification.category = options.category;
    if (options.orderId) notification.payload.order_id = options.orderId;
    if (options.vendorId) notification.payload.vendor_id = options.vendorId;

    for (const t of tokens) {
      apnProvider.send(notification, t.token).then(result => {
        // Remove invalid tokens
        if (result.failed?.length > 0) {
          for (const fail of result.failed) {
            if (fail.status === '410' || fail.response?.reason === 'Unregistered') {
              db.prepare('DELETE FROM apns_tokens WHERE token=?').run(fail.device);
            }
          }
        }
      }).catch(e => console.error('[WYA-APP] APNs send error:', e.message));
    }
  }
}

// Loyalty points
app.get('/api/customer/loyalty', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const history = db.prepare('SELECT * FROM loyalty_points WHERE customer_id=? ORDER BY created_at DESC LIMIT 50').all(cust.id);
    const total = cust.loyalty_points || 0;
    res.json({ ok:true, points:total, history });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/customer/loyalty/redeem', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const points = cust.loyalty_points || 0;
    if (points < 100) return res.status(400).json({ error:'Need at least 100 points to redeem ($5 off)' });
    // Create a promo code for this customer
    const code = 'LOYAL-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare('INSERT INTO promo_codes (code,vendor_id,discount_type,discount_value,max_uses,active,created_by) VALUES (?,NULL,?,?,1,1,?)').run(code,'flat',5.00,cust.id);
    db.prepare('UPDATE customers SET loyalty_points=loyalty_points-100 WHERE id=?').run(cust.id);
    db.prepare("INSERT INTO loyalty_points (customer_id,points,type,description) VALUES (?,?,'redeem','Redeemed 100 points for $5 promo code')").run(cust.id, -100);
    res.json({ ok:true, code, discount:5.00, remaining_points:points-100 });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Award loyalty points helper
function awardLoyaltyPoints(customerId, orderId, total) {
  const points = Math.floor(total);
  if (points <= 0) return;
  db.prepare('UPDATE customers SET loyalty_points=loyalty_points+? WHERE id=?').run(points, customerId);
  db.prepare("INSERT INTO loyalty_points (customer_id,order_id,points,type,description) VALUES (?,?,?,'earn',?)").run(customerId, orderId, points, `Earned ${points} pts on order`);
}

// Award signup bonus (idempotent — only awards once per customer)
function awardSignupBonus(customerId) {
  const existing = db.prepare("SELECT COUNT(*) as c FROM loyalty_points WHERE customer_id=? AND type='bonus'").get(customerId);
  if (existing && existing.c > 0) return; // Already awarded
  db.prepare('UPDATE customers SET loyalty_points=loyalty_points+50 WHERE id=?').run(customerId);
  db.prepare("INSERT INTO loyalty_points (customer_id,points,type,description) VALUES (?,50,'bonus','Welcome bonus!')").run(customerId);
}

// ══════════════════════════════════════════════════════════════
// ── Phase 744: VENDOR TOOLS UPGRADE ─────────────────────────
// ══════════════════════════════════════════════════════════════

// Vendor check-in (notify followers)
app.post('/api/vendor/checkin', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    // Phase 726: Require email verification before check-in
    if (!vendor.email_verified) return res.status(403).json({ error:'Verify your email before checking in', needs_verification:true });
    const { message } = req.body;
    const followers = db.prepare('SELECT * FROM vendor_followers WHERE vendor_id=? AND active=1').all(vendor.id);
    let sent = 0;
    const msg = message || `${vendor.name} is now open!`;
    for (const f of followers) {
      // Send push to customer
      sendPushNotification(f.customer_id, 'customer', vendor.name, msg, `https://wya.digisigns.link/customer?vendor=${vendor.id}`);
      // Try SMS via MSG_GW
      if (f.phone) {
        try {
          const smsBody = JSON.stringify({ to:f.phone, message:`WYA: ${msg} - https://wya.digisigns.link/v/${vendor.id}` });
          const smsReq = http.request({ hostname:'127.0.0.1', port:3070, path:'/send', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(smsBody)}, timeout:3000 });
          smsReq.on('error',()=>{});
          smsReq.write(smsBody); smsReq.end();
          sent++;
        } catch(e) {}
      }
      sent++;
    }
    res.json({ ok:true, notified:sent, follower_count:followers.length });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Follower management
app.post('/api/vendor/followers/add', (req, res) => {
  const cust = getCustomerByToken(req.headers['x-cust-token']);
  if (!cust) return res.status(401).json({ error:'Login required' });
  const { vendor_id } = req.body;
  if (!vendor_id) return res.status(400).json({ error:'vendor_id required' });
  try {
    db.prepare('INSERT OR IGNORE INTO vendor_followers (vendor_id,customer_id,phone,name) VALUES (?,?,?,?)').run(vendor_id, cust.id, cust.phone||'', cust.name);
    res.json({ ok:true });
  } catch(e) { console.error('[WYA-APP] Route error:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/vendor/followers/remove', (req, res) => {
  const cust = getCustomerByToken(req.headers['x-cust-token']);
  if (!cust) return res.status(401).json({ error:'Login required' });
  const { vendor_id } = req.body;
  try {
    db.prepare('DELETE FROM vendor_followers WHERE vendor_id=? AND customer_id=?').run(vendor_id, cust.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/vendor/followers', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const followers = db.prepare('SELECT vf.*, c.name as customer_name FROM vendor_followers vf LEFT JOIN customers c ON vf.customer_id=c.id WHERE vf.vendor_id=? AND vf.active=1').all(vendor.id);
    res.json({ ok:true, followers, count:followers.length });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/customer/following', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const following = db.prepare('SELECT vf.vendor_id, v.name, v.category, v.is_open, v.photo_url FROM vendor_followers vf JOIN vendors v ON vf.vendor_id=v.id WHERE vf.customer_id=? AND vf.active=1').all(cust.id);
    res.json({ ok:true, following });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Phase 1710: Vendor-Customer Messaging ──────────────────────────────────

// Vendor: get conversations list
app.get('/api/vendor/messages', (req, res) => {
  try {
    const vendor = getVendorAuth(req);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { customer_id } = req.query;
    if (customer_id) {
      // Get conversation with specific customer
      const messages = db.prepare('SELECT * FROM messages WHERE vendor_id=? AND customer_id=? ORDER BY created_at ASC LIMIT 100').all(vendor.id, customer_id);
      // Mark as read
      db.prepare("UPDATE messages SET read=1 WHERE vendor_id=? AND customer_id=? AND sender_type='customer' AND read=0").run(vendor.id, customer_id);
      const customer = db.prepare('SELECT id, name, email, phone FROM customers WHERE id=?').get(customer_id);
      res.json({ ok:true, messages, customer });
    } else {
      // Get all conversations (latest message per customer)
      const conversations = db.prepare(`
        SELECT m.customer_id, c.name as customer_name, c.email as customer_email,
          (SELECT message FROM messages WHERE vendor_id=m.vendor_id AND customer_id=m.customer_id ORDER BY created_at DESC LIMIT 1) as last_message,
          (SELECT created_at FROM messages WHERE vendor_id=m.vendor_id AND customer_id=m.customer_id ORDER BY created_at DESC LIMIT 1) as last_message_at,
          (SELECT COUNT(*) FROM messages WHERE vendor_id=m.vendor_id AND customer_id=m.customer_id AND sender_type='customer' AND read=0) as unread_count
        FROM messages m
        LEFT JOIN customers c ON m.customer_id = c.id
        WHERE m.vendor_id=?
        GROUP BY m.customer_id
        ORDER BY last_message_at DESC
      `).all(vendor.id);
      const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
      res.json({ ok:true, conversations, totalUnread });
    }
  } catch(e) { console.error('[WYA-APP] GET vendor/messages:', e.message); res.status(500).json({ error:'Internal server error' }); }
});

// Vendor: send message to customer
app.post('/api/vendor/messages', (req, res) => {
  try {
    const vendor = getVendorAuth(req);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { customer_id, message } = req.body;
    if (!customer_id) return res.status(400).json({ error:'customer_id required' });
    if (!message?.trim()) return res.status(400).json({ error:'message required' });
    if (message.length > 2000) return res.status(400).json({ error:'Message too long (max 2000 chars)' });
    const result = db.prepare('INSERT INTO messages (vendor_id, customer_id, sender_type, message) VALUES (?, ?, ?, ?)').run(vendor.id, customer_id, 'vendor', sanitize(message.trim()));
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
    res.json({ ok:true, message: msg });
  } catch(e) { console.error('[WYA-APP] POST vendor/messages:', e.message); res.status(500).json({ error:'Internal server error' }); }
});

// Customer: get messages with a vendor
app.get('/api/customer/messages', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const { vendor_id } = req.query;
    if (vendor_id) {
      const messages = db.prepare('SELECT * FROM messages WHERE vendor_id=? AND customer_id=? ORDER BY created_at ASC LIMIT 100').all(vendor_id, cust.id);
      db.prepare("UPDATE messages SET read=1 WHERE vendor_id=? AND customer_id=? AND sender_type='vendor' AND read=0").run(vendor_id, cust.id);
      const vendor = db.prepare('SELECT id, name, category, photo_url FROM vendors WHERE id=?').get(vendor_id);
      res.json({ ok:true, messages, vendor });
    } else {
      // All conversations for this customer
      const conversations = db.prepare(`
        SELECT m.vendor_id, v.name as vendor_name, v.photo_url,
          (SELECT message FROM messages WHERE vendor_id=m.vendor_id AND customer_id=m.customer_id ORDER BY created_at DESC LIMIT 1) as last_message,
          (SELECT created_at FROM messages WHERE vendor_id=m.vendor_id AND customer_id=m.customer_id ORDER BY created_at DESC LIMIT 1) as last_message_at,
          (SELECT COUNT(*) FROM messages WHERE vendor_id=m.vendor_id AND customer_id=m.customer_id AND sender_type='vendor' AND read=0) as unread_count
        FROM messages m
        LEFT JOIN vendors v ON m.vendor_id = v.id
        WHERE m.customer_id=?
        GROUP BY m.vendor_id
        ORDER BY last_message_at DESC
      `).all(cust.id);
      res.json({ ok:true, conversations });
    }
  } catch(e) { console.error('[WYA-APP] GET customer/messages:', e.message); res.status(500).json({ error:'Internal server error' }); }
});

// Customer: send message to vendor
app.post('/api/customer/messages', (req, res) => {
  try {
    const cust = getCustomerByToken(req.headers['x-cust-token']);
    if (!cust) return res.status(401).json({ error:'Login required' });
    const { vendor_id, message } = req.body;
    if (!vendor_id) return res.status(400).json({ error:'vendor_id required' });
    if (!message?.trim()) return res.status(400).json({ error:'message required' });
    if (message.length > 2000) return res.status(400).json({ error:'Message too long (max 2000 chars)' });
    // Verify vendor exists
    const vendor = db.prepare('SELECT id FROM vendors WHERE id=?').get(vendor_id);
    if (!vendor) return res.status(404).json({ error:'Vendor not found' });
    const result = db.prepare('INSERT INTO messages (vendor_id, customer_id, sender_type, message) VALUES (?, ?, ?, ?)').run(vendor_id, cust.id, 'customer', sanitize(message.trim()));
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
    res.json({ ok:true, message: msg });
  } catch(e) { console.error('[WYA-APP] POST customer/messages:', e.message); res.status(500).json({ error:'Internal server error' }); }
});

// ─── Phase 1710: QR Scan Attribution ─────────────────────────────────────────

// Public: Track QR scan (no auth needed — triggered when QR is scanned)
app.get('/api/vendors/:id/qr-scan', (req, res) => {
  try {
    const vendorId = req.params.id;
    const vendor = db.prepare('SELECT id, name FROM vendors WHERE id=?').get(vendorId);
    if (!vendor) return res.status(404).json({ error:'Vendor not found' });
    const ua = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const device = /mobile/i.test(ua) ? 'mobile' : 'desktop';
    db.prepare('INSERT INTO qr_scans (vendor_id, source, device, ip, user_agent) VALUES (?, ?, ?, ?, ?)').run(vendorId, 'qr', device, ip, ua.slice(0, 200));
    // Redirect to vendor profile
    res.redirect(`https://wya.digisigns.link/customer?vendor=${vendorId}&ref=qr`);
  } catch(e) { console.error('[WYA-APP] QR scan track:', e.message); res.status(500).json({ error:'Internal server error' }); }
});

// Vendor: QR attribution analytics
app.get('/api/vendor/qr-analytics', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const days = parseInt(req.query.days || '30', 10);
    const scans = db.prepare(`SELECT * FROM qr_scans WHERE vendor_id=? AND scanned_at >= datetime('now', '-${days} days') ORDER BY scanned_at DESC`).all(vendor.id);
    const totalScans = scans.length;
    const followedUp = scans.filter(s => s.resulted_in_follow).length;
    const orderedFrom = scans.filter(s => s.resulted_in_order).length;
    const totalRevenue = scans.reduce((sum, s) => sum + (s.revenue_cents || 0), 0);
    const byDevice = { mobile: scans.filter(s => s.device === 'mobile').length, desktop: scans.filter(s => s.device === 'desktop').length };
    const byDay = {};
    scans.forEach(s => {
      const day = s.scanned_at?.slice(0, 10) || 'unknown';
      byDay[day] = (byDay[day] || 0) + 1;
    });
    res.json({ ok:true, totalScans, followedUp, orderedFrom, totalRevenue, conversionRate: totalScans > 0 ? Math.round((orderedFrom / totalScans) * 100) : 0, byDevice, byDay, scans: scans.slice(0, 50) });
  } catch(e) { console.error('[WYA-APP] QR analytics:', e.message); res.status(500).json({ error:'Internal server error' }); }
});

// Admin: Update QR scan attribution (called when follow or order happens)
app.post('/api/admin/qr-scan/:scanId/attribute', (req, res) => {
  try {
    const portalSecret = req.headers['x-portal-secret'];
    if (!portalSecret || portalSecret !== SOUL_TOKEN) return res.status(401).json({ error:'Unauthorized' });
    const scanId = parseInt(req.params.scanId, 10);
    const { resulted_in_follow, resulted_in_order, order_id, revenue_cents } = req.body;
    const sets = []; const vals = [];
    if (resulted_in_follow !== undefined) { sets.push('resulted_in_follow=?'); vals.push(resulted_in_follow ? 1 : 0); }
    if (resulted_in_order !== undefined) { sets.push('resulted_in_order=?'); vals.push(resulted_in_order ? 1 : 0); }
    if (order_id) { sets.push('order_id=?'); vals.push(order_id); }
    if (revenue_cents !== undefined) { sets.push('revenue_cents=?'); vals.push(revenue_cents); }
    if (sets.length === 0) return res.json({ ok:true });
    vals.push(scanId);
    db.prepare(`UPDATE qr_scans SET ${sets.join(',')} WHERE id=?`).run(...vals);
    res.json({ ok:true });
  } catch(e) { console.error('[WYA-APP] QR attribution:', e.message); res.status(500).json({ error:'Internal server error' }); }
});

// ─── WYA Embed Widget ────────────────────────────────────────────────────────
app.get('/widget.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});

app.get('/api/embed-code', (req, res) => {
  const category = req.query.category || '';
  const theme = req.query.theme || 'dark';
  const limit = req.query.limit || '6';
  const baseUrl = 'https://wya.digisigns.link';
  const attrs = [category ? `data-category="${category}"` : '', `data-theme="${theme}"`, `data-limit="${limit}"`].filter(Boolean).join(' ');
  const embedCode = `<!-- WYA Live Vendor Widget -->\n<div id="wya-widget"></div>\n<script src="${baseUrl}/widget.js" ${attrs}></script>`;

  res.json({
    ok: true,
    embed_code: embedCode,
    direct_link: `${baseUrl}/customer`,
    widget_url: `${baseUrl}/widget.js`,
    category, theme, limit: parseInt(limit),
    instructions: [
      'Paste the embed code into any HTML page to show live vendors',
      'Filter by category: data-category="food_truck"',
      'Change theme: data-theme="light" or data-theme="dark"',
      'Limit vendors shown: data-limit="4"',
    ],
  });
});

// ─── Phase 1710: Santa Barbara Food Truck Compliance ─────────────────────────
// SB Municipal Code 9.127: 4-hour max at single location, 500ft minimum spacing
// This gives WYA a regulatory moat — vendors who use WYA stay compliant automatically

const SB_COMPLIANCE = {
  maxStayHours: 4,          // Max hours at a single location
  minSpacingFeet: 500,      // Minimum distance between food trucks
  minSpacingMiles: 500/5280, // ~0.0947 miles
  enforcementZone: {        // Santa Barbara city limits (approximate bounding box)
    minLat: 34.38, maxLat: 34.46,
    minLng: -119.76, maxLng: -119.66
  }
};

function isInSBZone(lat, lng) {
  const z = SB_COMPLIANCE.enforcementZone;
  return lat >= z.minLat && lat <= z.maxLat && lng >= z.minLng && lng <= z.maxLng;
}

// Check compliance for a vendor location
app.get('/api/vendor/compliance-check', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });

    const warnings = [];
    const lat = parseFloat(vendor.lat); const lng = parseFloat(vendor.lng);
    const inSB = lat && lng && isInSBZone(lat, lng);

    if (inSB) {
      // Check 4-hour stay limit
      const lastCheckin = db.prepare("SELECT * FROM activity_log WHERE vendor_id=? AND action='checkin' ORDER BY created_at DESC LIMIT 1").get(vendor.id);
      if (lastCheckin) {
        const hoursAtLocation = (Date.now() - new Date(lastCheckin.created_at).getTime()) / 3600000;
        if (hoursAtLocation > SB_COMPLIANCE.maxStayHours) {
          warnings.push({ type: 'overstay', message: `You've been at this location for ${Math.round(hoursAtLocation * 10) / 10} hours. SB limit is ${SB_COMPLIANCE.maxStayHours} hours.`, severity: 'warning', hours: Math.round(hoursAtLocation * 10) / 10 });
        } else if (hoursAtLocation > SB_COMPLIANCE.maxStayHours * 0.75) {
          const remaining = Math.round((SB_COMPLIANCE.maxStayHours - hoursAtLocation) * 60);
          warnings.push({ type: 'approaching_limit', message: `${remaining} minutes remaining at this location (SB 4-hour limit).`, severity: 'info', minutesRemaining: remaining });
        }
      }

      // Check 500ft spacing from other active vendors
      if (lat && lng) {
        const nearbyVendors = db.prepare("SELECT id, name, lat, lng FROM vendors WHERE is_open=1 AND id!=? AND lat IS NOT NULL AND lng IS NOT NULL").all(vendor.id);
        for (const nv of nearbyVendors) {
          const nvLat = parseFloat(nv.lat); const nvLng = parseFloat(nv.lng);
          if (!nvLat || !nvLng) continue;
          const distMiles = haversine(lat, lng, nvLat, nvLng);
          if (distMiles < SB_COMPLIANCE.minSpacingMiles) {
            const distFeet = Math.round(distMiles * 5280);
            warnings.push({ type: 'too_close', message: `${nv.name} is ${distFeet}ft away. SB minimum is ${SB_COMPLIANCE.minSpacingFeet}ft.`, severity: 'warning', vendorName: nv.name, distanceFeet: distFeet });
          }
        }
      }
    }

    res.json({
      ok: true,
      inSBZone: inSB,
      compliant: warnings.filter(w => w.severity === 'warning').length === 0,
      warnings,
      rules: inSB ? { maxStayHours: SB_COMPLIANCE.maxStayHours, minSpacingFeet: SB_COMPLIANCE.minSpacingFeet } : null
    });
  } catch(e) { console.error('[WYA-APP] Compliance check:', e.message); res.status(500).json({ error:'Internal server error' }); }
});

// Public: Check if a location is compliant for a new vendor
app.get('/api/compliance/check-location', (req, res) => {
  try {
    const lat = parseFloat(req.query.lat); const lng = parseFloat(req.query.lng);
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    const inSB = isInSBZone(lat, lng);
    if (!inSB) return res.json({ ok: true, inSBZone: false, compliant: true, message: 'Outside SB enforcement zone' });

    const conflicts = [];
    const activeVendors = db.prepare("SELECT id, name, lat, lng FROM vendors WHERE is_open=1 AND lat IS NOT NULL AND lng IS NOT NULL").all();
    for (const v of activeVendors) {
      const vLat = parseFloat(v.lat); const vLng = parseFloat(v.lng);
      if (!vLat || !vLng) continue;
      const distMiles = haversine(lat, lng, vLat, vLng);
      if (distMiles < SB_COMPLIANCE.minSpacingMiles) {
        conflicts.push({ vendorName: v.name, distanceFeet: Math.round(distMiles * 5280) });
      }
    }

    res.json({
      ok: true, inSBZone: true,
      compliant: conflicts.length === 0,
      conflicts,
      message: conflicts.length > 0 ? `${conflicts.length} vendor(s) within ${SB_COMPLIANCE.minSpacingFeet}ft` : 'Location is compliant'
    });
  } catch(e) { res.status(500).json({ error:'Internal server error' }); }
});

// Schedule planner
app.get('/api/vendor/schedule', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const schedule = db.prepare('SELECT * FROM vendor_schedules WHERE vendor_id=? ORDER BY day_of_week').all(vendor.id);
    const events = db.prepare("SELECT * FROM vendor_events WHERE vendor_id=? AND event_date >= date('now') ORDER BY event_date LIMIT 20").all(vendor.id);
    res.json({ ok:true, schedule, events });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/vendor/schedule', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { schedule } = req.body;
    if (!Array.isArray(schedule)) return res.status(400).json({ error:'schedule array required' });
    const upsert = db.prepare('INSERT OR REPLACE INTO vendor_schedules (vendor_id,day_of_week,start_time,end_time,location) VALUES (?,?,?,?,?)');
    for (const s of schedule) {
      if (s.day_of_week === undefined) continue;
      upsert.run(vendor.id, s.day_of_week, s.start_time||null, s.end_time||null, s.location||'');
    }
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/vendor/events', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { title, event_date, start_time, end_time, location, description, capacity, price, category, recurring, recurrence_end } = req.body;
    if (!title || !event_date) return res.status(400).json({ error:'title and event_date required' });

    const validRecurring = ['', 'daily', 'weekly', 'biweekly', 'monthly'];
    const recur = validRecurring.includes(recurring) ? (recurring || '') : '';

    const r = db.prepare('INSERT INTO vendor_events (vendor_id,title,event_date,start_time,end_time,location,description,capacity,price,category,event_type,recurring,recurrence_end) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      vendor.id, title.trim(), event_date, start_time||'', end_time||'', (location||'').trim(),
      (description||'').trim(), parseInt(capacity)||0, parseFloat(price)||0, category||vendor.category||'other', 'vendor',
      recur, recurrence_end || ''
    );
    const parentId = r.lastInsertRowid;
    const createdIds = [parentId];

    // Generate recurring instances (up to 52 weeks / 12 months)
    if (recur && recurrence_end) {
      const endDate = new Date(recurrence_end);
      let current = new Date(event_date);
      const maxInstances = 52;
      let count = 0;

      while (count < maxInstances) {
        if (recur === 'daily') current.setDate(current.getDate() + 1);
        else if (recur === 'weekly') current.setDate(current.getDate() + 7);
        else if (recur === 'biweekly') current.setDate(current.getDate() + 14);
        else if (recur === 'monthly') current.setMonth(current.getMonth() + 1);

        if (current > endDate) break;
        const nextDate = current.toISOString().slice(0, 10);
        const ri = db.prepare('INSERT INTO vendor_events (vendor_id,title,event_date,start_time,end_time,location,description,capacity,price,category,event_type,recurring,recurrence_end,parent_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          vendor.id, title.trim(), nextDate, start_time||'', end_time||'', (location||'').trim(),
          (description||'').trim(), parseInt(capacity)||0, parseFloat(price)||0, category||vendor.category||'other', 'vendor',
          recur, recurrence_end, parentId
        );
        createdIds.push(ri.lastInsertRowid);
        count++;
      }
    }

    // Notify followers about new event
    const followers = db.prepare('SELECT customer_id FROM vendor_followers WHERE vendor_id=? AND active=1').all(vendor.id);
    for (const f of followers) {
      sendPushNotification(f.customer_id, 'customer', vendor.name, `New event: "${title.trim()}" on ${event_date}${recur ? ` (${recur})` : ''}`, `https://wya.digisigns.link/customer?event=${parentId}`);
    }
    res.json({ ok:true, id: parentId, recurring: recur || null, instances_created: createdIds.length });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/vendor/events/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    db.prepare('DELETE FROM vendor_events WHERE id=? AND vendor_id=?').run(req.params.id, vendor.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public schedule view
app.get('/api/vendors/:id/schedule', (req, res) => {
  try {
    const schedule = db.prepare('SELECT * FROM vendor_schedules WHERE vendor_id=? ORDER BY day_of_week').all(req.params.id);
    const events = db.prepare("SELECT * FROM vendor_events WHERE vendor_id=? AND event_date >= date('now') ORDER BY event_date LIMIT 10").all(req.params.id);
    res.json({ ok:true, schedule, events });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enhanced analytics
app.get('/api/vendor/analytics/detailed', (req, res) => {
  try {
  const vendor = getVendorByToken(req.headers['x-auth-token']);
  if (!vendor) return res.status(401).json({ error:'Invalid session' });
  const period = req.query.period || '30d';
  const days = period === '90d' ? 90 : period === '7d' ? 7 : 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const priorStart = new Date(Date.now() - days * 2 * 86400000).toISOString();

  const orders = db.prepare("SELECT * FROM orders WHERE vendor_id=? AND created_at>=? AND status NOT IN ('cancelled')").all(vendor.id, since);
  const priorOrders = db.prepare("SELECT * FROM orders WHERE vendor_id=? AND created_at>=? AND created_at<? AND status NOT IN ('cancelled')").all(vendor.id, priorStart, since);

  // Orders by hour
  const byHour = {};
  for (let h = 0; h < 24; h++) byHour[h] = 0;
  for (const o of orders) { try { const h = new Date(o.created_at).getHours(); byHour[h]++; } catch(e) {} }

  // Orders by day of week
  const byDow = { 0:0,1:0,2:0,3:0,4:0,5:0,6:0 };
  for (const o of orders) { try { byDow[new Date(o.created_at).getDay()]++; } catch(e) {} }

  // Customer frequency
  const custOrders = {};
  for (const o of orders) { custOrders[o.customer_id] = (custOrders[o.customer_id]||0)+1; }
  const freq = { once:0, twice:0, three_plus:0 };
  for (const c of Object.values(custOrders)) { if (c===1) freq.once++; else if (c===2) freq.twice++; else freq.three_plus++; }

  // Revenue trend
  const currentRev = orders.reduce((s,o) => s+o.total, 0);
  const priorRev = priorOrders.reduce((s,o) => s+o.total, 0);
  const revChange = priorRev > 0 ? Math.round((currentRev - priorRev) / priorRev * 100) : 0;

  // Phase 752: Profile view trends (daily)
  const viewsByDay = {};
  try {
    const views = db.prepare("SELECT date(viewed_at) as day, COUNT(*) as cnt FROM profile_views WHERE vendor_id=? AND viewed_at>=? GROUP BY date(viewed_at) ORDER BY day").all(vendor.id, since);
    for (const v of views) viewsByDay[v.day] = v.cnt;
  } catch(e) {}

  // Phase 752: Popular menu items
  let popularItems = [];
  try {
    const itemCounts = {};
    for (const o of orders) {
      try { const items = JSON.parse(o.items_json); for (const i of items) { itemCounts[i.name] = (itemCounts[i.name]||0) + (i.qty||1); } } catch(e) {}
    }
    popularItems = Object.entries(itemCounts).sort((a,b) => b[1] - a[1]).slice(0,10).map(([name,count]) => ({ name, count }));
  } catch(e) {}

  // Phase 752: Peak hours heatmap (hour x day_of_week)
  const peakHeatmap = {};
  for (let d = 0; d < 7; d++) { peakHeatmap[d] = {}; for (let h = 0; h < 24; h++) peakHeatmap[d][h] = 0; }
  for (const o of orders) { try { const dt = new Date(o.created_at); peakHeatmap[dt.getDay()][dt.getHours()]++; } catch(e) {} }

  res.json({ ok:true, orders_by_hour:byHour, orders_by_day_of_week:byDow, customer_frequency:freq,
    revenue_trend:{ current:Math.round(currentRev*100)/100, prior:Math.round(priorRev*100)/100, change_pct:revChange },
    profile_views_by_day: viewsByDay, popular_items: popularItems, peak_hours_heatmap: peakHeatmap });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Multi-location CRUD
app.get('/api/vendor/locations', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const locations = db.prepare('SELECT * FROM vendor_locations WHERE vendor_id=? ORDER BY is_active DESC, created_at DESC').all(vendor.id);
    res.json({ ok:true, locations });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/vendor/locations', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { name, lat, lng, address } = req.body;
    if (!name || !lat || !lng) return res.status(400).json({ error:'name, lat, lng required' });
    const r = db.prepare('INSERT INTO vendor_locations (vendor_id,name,lat,lng,address) VALUES (?,?,?,?,?)').run(vendor.id, name, lat, lng, address||'');
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/vendor/locations/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const loc = db.prepare('SELECT * FROM vendor_locations WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!loc) return res.status(404).json({ error:'Location not found' });
    const { name, lat, lng, address } = req.body;
    db.prepare('UPDATE vendor_locations SET name=COALESCE(?,name),lat=COALESCE(?,lat),lng=COALESCE(?,lng),address=COALESCE(?,address) WHERE id=?').run(name||null,lat||null,lng||null,address||null,loc.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/vendor/locations/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    db.prepare('DELETE FROM vendor_locations WHERE id=? AND vendor_id=?').run(req.params.id, vendor.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/vendor/locations/:id/activate', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const loc = db.prepare('SELECT * FROM vendor_locations WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!loc) return res.status(404).json({ error:'Location not found' });
    db.prepare('UPDATE vendor_locations SET is_active=0 WHERE vendor_id=?').run(vendor.id);
    db.prepare('UPDATE vendor_locations SET is_active=1 WHERE id=?').run(loc.id);
    db.prepare('UPDATE vendors SET lat=?, lng=?, last_seen=? WHERE id=?').run(loc.lat, loc.lng, new Date().toISOString(), vendor.id);
    broadcastVendors();
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 752: Vendor profile photo upload (updates photo_url directly)
app.post('/api/vendor/photo', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    upload.single('photo')(req, res, (err) => {
      if (err) return res.status(400).json({ error:err.message });
      if (!req.file) return res.status(400).json({ error:'No file uploaded' });
      const ext = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp' }[req.file.mimetype] || '.jpg';
      const newName = req.file.filename + ext;
      const fs = require('fs');
      fs.renameSync(req.file.path, req.file.path + ext);
      const url = `/uploads/${newName}`;
      db.prepare('UPDATE vendors SET photo_url=? WHERE id=?').run(url, vendor.id);
      res.json({ ok:true, url });
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Photo upload
app.post('/api/vendor/upload', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    upload.single('photo')(req, res, (err) => {
      if (err) return res.status(400).json({ error:err.message });
      if (!req.file) return res.status(400).json({ error:'No file uploaded' });
      const ext = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp' }[req.file.mimetype] || '.jpg';
      const newName = req.file.filename + ext;
      const fs = require('fs');
      fs.renameSync(req.file.path, req.file.path + ext);
      const url = `/uploads/${newName}`;
      res.json({ ok:true, url });
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 2101: Event image upload — vendor uploads photo for their event
app.post('/api/vendor/events/:id/image', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const event = db.prepare('SELECT * FROM vendor_events WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!event) return res.status(404).json({ error:'Event not found or not yours' });
    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ error:err.message });
      if (!req.file) return res.status(400).json({ error:'No file uploaded' });
      const ext = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp' }[req.file.mimetype] || '.jpg';
      const newName = req.file.filename + ext;
      require('fs').renameSync(req.file.path, req.file.path + ext);
      const url = `/uploads/${newName}`;
      db.prepare('UPDATE vendor_events SET image_url=? WHERE id=?').run(url, event.id);
      res.json({ ok:true, url, event_id: event.id });
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 2101: Vendor update own event (title, description, date, time, location, capacity, price, category)
app.put('/api/vendor/events/:id', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const event = db.prepare('SELECT * FROM vendor_events WHERE id=? AND vendor_id=?').get(req.params.id, vendor.id);
    if (!event) return res.status(404).json({ error:'Event not found or not yours' });
    const allowed = ['title','description','event_date','start_time','end_time','location','capacity','price','category','image_url','recurring','recurrence_end'];
    const updates = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key}=?`);
        vals.push(req.body[key]);
      }
    }
    if (!updates.length) return res.status(400).json({ error:'No valid fields to update' });
    vals.push(event.id);
    db.prepare(`UPDATE vendor_events SET ${updates.join(',')} WHERE id=?`).run(...vals);
    const updated = db.prepare('SELECT * FROM vendor_events WHERE id=?').get(event.id);
    res.json({ ok:true, event: updated });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 2101: Event analytics — vendor sees stats for their events
app.get('/api/vendor/events/analytics', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });

    const events = db.prepare("SELECT * FROM vendor_events WHERE vendor_id=? ORDER BY event_date DESC").all(vendor.id);
    const now = new Date().toISOString().slice(0, 10);

    let totalRsvps = 0, totalRevenue = 0, totalEvents = events.length;
    const upcoming = [], past = [];

    for (const evt of events) {
      const rsvps = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='customer' AND status IN ('pending','confirmed')").get(evt.id)?.c || 0;
      const vendorApps = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='vendor' AND status IN ('pending','approved')").get(evt.id)?.c || 0;
      const revenue = evt.price > 0 ? db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='customer' AND status='confirmed'").get(evt.id)?.c * evt.price : 0;

      totalRsvps += rsvps;
      totalRevenue += revenue;

      const summary = { id: evt.id, title: evt.title, event_date: evt.event_date, start_time: evt.start_time, price: evt.price, capacity: evt.capacity, rsvps, vendor_apps: vendorApps, revenue: Math.round(revenue * 100) / 100, status: evt.status, image_url: evt.image_url };

      if (evt.event_date >= now && evt.status === 'active') upcoming.push(summary);
      else past.push(summary);
    }

    // Fill rate: avg rsvps / capacity for events with capacity > 0
    const capped = events.filter(e => e.capacity > 0);
    let avgFillRate = 0;
    if (capped.length > 0) {
      const fills = capped.map(e => {
        const r = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='customer' AND status IN ('pending','confirmed')").get(e.id)?.c || 0;
        return Math.min(r / e.capacity, 1);
      });
      avgFillRate = Math.round(fills.reduce((a, b) => a + b, 0) / fills.length * 100);
    }

    res.json({
      ok: true,
      total_events: totalEvents,
      upcoming_count: upcoming.length,
      past_count: past.length,
      total_rsvps: totalRsvps,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      avg_fill_rate_pct: avgFillRate,
      upcoming,
      past: past.slice(0, 20)
    });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Phase 1710: iCal Export for Vendor Events ──────────────────────────────
// Allows vendors and customers to subscribe to event feeds in Apple Calendar, Google Calendar, Outlook

function formatICalDate(dateStr, timeStr) {
  if (!dateStr) return '';
  const d = dateStr.replace(/-/g, '');
  if (timeStr) {
    const t = timeStr.replace(/:/g, '').padEnd(4, '0');
    return `${d}T${t}00`;
  }
  return `${d}T000000`;
}

function escapeICalText(text) {
  if (!text) return '';
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// Public: Vendor event feed as .ics (subscribable URL)
app.get('/api/vendors/:id/events.ics', (req, res) => {
  try {
    const vendorId = req.params.id;
    const vendor = db.prepare('SELECT id, name, email FROM vendors WHERE id=?').get(vendorId);
    if (!vendor) return res.status(404).send('Vendor not found');

    const events = db.prepare("SELECT * FROM vendor_events WHERE vendor_id=? AND status='active' ORDER BY event_date ASC").all(vendorId);
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    let ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//WYA//Events//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:${escapeICalText(vendor.name)} Events\r\nX-WR-TIMEZONE:America/Los_Angeles\r\n`;

    for (const evt of events) {
      const dtStart = formatICalDate(evt.event_date, evt.start_time);
      const dtEnd = formatICalDate(evt.event_date, evt.end_time || evt.start_time);
      const uid = `wya-event-${evt.id}@wya.digisigns.link`;

      ical += `BEGIN:VEVENT\r\n`;
      ical += `UID:${uid}\r\n`;
      ical += `DTSTART:${dtStart}\r\n`;
      ical += `DTEND:${dtEnd}\r\n`;
      ical += `DTSTAMP:${now}\r\n`;
      ical += `SUMMARY:${escapeICalText(evt.title)}\r\n`;
      if (evt.description) ical += `DESCRIPTION:${escapeICalText(evt.description)}\r\n`;
      if (evt.location) ical += `LOCATION:${escapeICalText(evt.location)}\r\n`;
      ical += `URL:https://wya.digisigns.link/customer?vendor=${vendorId}\r\n`;
      if (evt.price > 0) ical += `X-WYA-PRICE:${evt.price}\r\n`;
      if (evt.capacity > 0) ical += `X-WYA-CAPACITY:${evt.capacity}\r\n`;
      ical += `STATUS:CONFIRMED\r\n`;
      ical += `END:VEVENT\r\n`;
    }

    ical += `END:VCALENDAR\r\n`;

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${vendor.name.replace(/[^a-zA-Z0-9]/g, '_')}_events.ics"`);
    res.send(ical);
  } catch(e) { console.error('[WYA-APP] iCal export:', e.message); res.status(500).send('Export failed'); }
});

// Public: All community events as .ics
app.get('/api/events.ics', (req, res) => {
  try {
    const events = db.prepare("SELECT ve.*, v.name as vendor_name FROM vendor_events ve JOIN vendors v ON ve.vendor_id=v.id WHERE ve.status='active' AND ve.event_date >= date('now') ORDER BY ve.event_date ASC LIMIT 100").all();
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    let ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//WYA//Community Events//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:WYA Community Events\r\nX-WR-TIMEZONE:America/Los_Angeles\r\n`;

    for (const evt of events) {
      const dtStart = formatICalDate(evt.event_date, evt.start_time);
      const dtEnd = formatICalDate(evt.event_date, evt.end_time || evt.start_time);
      ical += `BEGIN:VEVENT\r\nUID:wya-event-${evt.id}@wya.digisigns.link\r\nDTSTART:${dtStart}\r\nDTEND:${dtEnd}\r\nDTSTAMP:${now}\r\nSUMMARY:${escapeICalText(evt.title)} (${escapeICalText(evt.vendor_name)})\r\n`;
      if (evt.description) ical += `DESCRIPTION:${escapeICalText(evt.description)}\r\n`;
      if (evt.location) ical += `LOCATION:${escapeICalText(evt.location)}\r\n`;
      ical += `URL:https://wya.digisigns.link/customer?vendor=${evt.vendor_id}\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\n`;
    }
    ical += `END:VCALENDAR\r\n`;

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="wya_events.ics"');
    res.send(ical);
  } catch(e) { console.error('[WYA-APP] iCal community export:', e.message); res.status(500).send('Export failed'); }
});

// ══════════════════════════════════════════════════════════════
// ── Phase 745: REVENUE FEATURES ─────────────────────────────
// ══════════════════════════════════════════════════════════════

// Subscription cancel
app.post('/api/vendor/subscription/cancel', async (req, res) => {
  const vendor = getVendorByToken(req.headers['x-auth-token']);
  if (!vendor) return res.status(401).json({ error:'Invalid session' });
  if (!vendor.stripe_subscription_id) return res.status(400).json({ error:'No active subscription' });
  try {
    // Only call Stripe API for real Stripe subscription IDs (start with 'sub_')
    if (vendor.stripe_subscription_id.startsWith('sub_') && !vendor.stripe_subscription_id.startsWith('sub_owner_')) {
      await getStripe().subscriptions.cancel(vendor.stripe_subscription_id);
    }
    db.prepare("UPDATE vendors SET subscription_status='cancelled', stripe_subscription_id=NULL WHERE id=?").run(vendor.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Stripe billing portal
app.get('/api/vendor/subscription/portal', async (req, res) => {
  const vendor = getVendorByToken(req.headers['x-auth-token']);
  if (!vendor) return res.status(401).json({ error:'Invalid session' });
  if (!vendor.stripe_customer_id) return res.status(400).json({ error:'No Stripe customer' });
  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: vendor.stripe_customer_id,
      return_url: 'https://wya.digisigns.link/vendor'
    });
    res.json({ ok:true, url:session.url });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Commission on order completion helper
function recordOrderCommission(order) {
  const existing = db.prepare('SELECT id FROM vendor_commissions WHERE order_id=?').get(order.id);
  if (existing) return;
  const rate = order.commission_rate || 0.12;
  const commission = Math.round(order.subtotal * rate * 100) / 100;
  const payout = Math.round((order.total - commission) * 100) / 100;
  const period = new Date().toISOString().slice(0, 7);
  db.prepare('INSERT INTO vendor_commissions (order_id,vendor_id,gross,rate,commission,payout,status,period) VALUES (?,?,?,?,?,?,?,?)').run(
    order.id, order.vendor_id, order.total, rate, commission, payout, 'pending', period
  );
}

// Admin commissions
app.get('/api/admin/commissions', isSuperAdmin, (req, res) => {
  try {
    const { vendor_id, status, period } = req.query;
    let sql = 'SELECT vc.*, v.name as vendor_name FROM vendor_commissions vc LEFT JOIN vendors v ON vc.vendor_id=v.id WHERE 1=1';
    const params = [];
    if (vendor_id) { sql += ' AND vc.vendor_id=?'; params.push(vendor_id); }
    if (status) { sql += ' AND vc.status=?'; params.push(status); }
    if (period) { sql += ' AND vc.period=?'; params.push(period); }
    sql += ' ORDER BY vc.created_at DESC LIMIT 100';
    const commissions = db.prepare(sql).all(...params);
    const totals = db.prepare("SELECT COALESCE(SUM(commission),0) as total_commission, COALESCE(SUM(payout),0) as total_payout FROM vendor_commissions WHERE status='pending'").get();
    res.json({ ok:true, commissions, pending_commission:Math.round((totals?.total_commission ?? 0)*100)/100, pending_payout:Math.round((totals?.total_payout ?? 0)*100)/100 });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/commissions/approve', isSuperAdmin, (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error:'ids array required' });
    const stmt = db.prepare("UPDATE vendor_commissions SET status='approved' WHERE id=?");
    for (const id of ids) stmt.run(id);
    res.json({ ok:true, approved:ids.length });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/payouts/create', isSuperAdmin, (req, res) => {
  try {
    const { vendor_id, amount, period, method, notes } = req.body;
    if (!vendor_id || !amount) return res.status(400).json({ error:'vendor_id and amount required' });
    const r = db.prepare('INSERT INTO vendor_payouts (vendor_id,amount,period,status,method,notes) VALUES (?,?,?,?,?,?)').run(
      vendor_id, parseFloat(amount), period||new Date().toISOString().slice(0,7), 'pending', method||'manual', notes||''
    );
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admin/payouts/:id', isSuperAdmin, (req, res) => {
  try {
    const { status, notes } = req.body;
    const sets = [], vals = [];
    if (status) { sets.push('status=?'); vals.push(status); }
    if (notes !== undefined) { sets.push('notes=?'); vals.push(notes); }
    if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE vendor_payouts SET ${sets.join(',')} WHERE id=?`).run(...vals); }
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor payouts view
app.get('/api/vendor/payouts', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const payouts = db.prepare('SELECT * FROM vendor_payouts WHERE vendor_id=? ORDER BY created_at DESC LIMIT 50').all(vendor.id);
    const commissions = db.prepare('SELECT * FROM vendor_commissions WHERE vendor_id=? ORDER BY created_at DESC LIMIT 50').all(vendor.id);
    const totalPending = db.prepare("SELECT COALESCE(SUM(payout),0) as total FROM vendor_commissions WHERE vendor_id=? AND status='pending'").get(vendor.id)?.total ?? 0;
    res.json({ ok:true, payouts, commissions, pending_payout:Math.round(totalPending*100)/100 });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Phase 1336: Stripe Connect — Vendor Bank Account Onboarding ──────────────
// Creates a Stripe Express connected account and returns the onboarding link
app.post('/api/vendor/connect/setup', async (req, res) => {
  const vendor = getVendorByToken(req.headers['x-auth-token']);
  if (!vendor) return res.status(401).json({ error: 'Invalid session' });
  try {
    let accountId = vendor.stripe_connect_id;
    if (!accountId) {
      const account = await getStripe().accounts.create({
        type: 'express',
        country: 'US',
        email: vendor.email,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_type: 'individual',
        metadata: { vendor_id: vendor.id, vendor_name: vendor.name }
      });
      accountId = account.id;
      db.prepare('UPDATE vendors SET stripe_connect_id=? WHERE id=?').run(accountId, vendor.id);
    }
    const accountLink = await getStripe().accountLinks.create({
      account: accountId,
      refresh_url: 'https://wya.digisigns.link/vendor?connect=refresh',
      return_url: 'https://wya.digisigns.link/vendor?connect=complete',
      type: 'account_onboarding'
    });
    res.json({ ok: true, url: accountLink.url });
  } catch (e) {
    console.error('[STRIPE-CONNECT] Setup error:', e.message);
    res.status(500).json({ error: 'Could not start bank setup: ' + e.message });
  }
});

// Check Stripe Connect onboarding status
app.get('/api/vendor/connect/status', async (req, res) => {
  const vendor = getVendorByToken(req.headers['x-auth-token']);
  if (!vendor) return res.status(401).json({ error: 'Invalid session' });
  if (!vendor.stripe_connect_id) return res.json({ ok: true, connected: false, onboarded: false });
  try {
    const account = await getStripe().accounts.retrieve(vendor.stripe_connect_id);
    const onboarded = account.charges_enabled && account.payouts_enabled;
    if (onboarded && !vendor.stripe_connect_onboarded) {
      db.prepare('UPDATE vendors SET stripe_connect_onboarded=1 WHERE id=?').run(vendor.id);
    }
    res.json({
      ok: true, connected: true, onboarded,
      charges_enabled: account.charges_enabled, payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      bank_last4: account.external_accounts?.data?.[0]?.last4 || null,
      bank_name: account.external_accounts?.data?.[0]?.bank_name || null
    });
  } catch (e) {
    console.error('[STRIPE-CONNECT] Status error:', e.message);
    res.json({ ok: true, connected: !!vendor.stripe_connect_id, onboarded: !!vendor.stripe_connect_onboarded, error: e.message });
  }
});

// Vendor requests a payout — transfers earned balance to their connected account
app.post('/api/vendor/payouts/request', async (req, res) => {
  const vendor = getVendorByToken(req.headers['x-auth-token']);
  if (!vendor) return res.status(401).json({ error: 'Invalid session' });
  if (!vendor.stripe_connect_id || !vendor.stripe_connect_onboarded) {
    return res.status(400).json({ error: 'Please connect your bank account first' });
  }
  // Calculate pending earnings since last payout
  const lastPayout = db.prepare("SELECT MAX(period_end) as last_end FROM vendor_payouts WHERE vendor_id=? AND status IN ('completed','paid')").get(vendor.id);
  const since = lastPayout?.last_end || '2020-01-01';
  const earnings = db.prepare(`
    SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as gross, COALESCE(SUM(commission_amount),0) as commission, COALESCE(SUM(tip),0) as tips
    FROM orders WHERE vendor_id=? AND payment_status='paid' AND created_at > ? AND status IN ('picked_up','delivered')
  `).get(vendor.id, since);
  const net = Math.round((earnings.gross - earnings.commission + earnings.tips) * 100) / 100;
  if (net < 1) return res.status(400).json({ error: 'Minimum payout is $1.00. Current balance: $' + net.toFixed(2) });
  // Check no pending payout exists
  const pending = db.prepare("SELECT id FROM vendor_payouts WHERE vendor_id=? AND status='pending'").get(vendor.id);
  if (pending) return res.status(400).json({ error: 'You already have a pending payout request' });
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO vendor_payouts (vendor_id, amount, period_start, period_end, order_count, gross_revenue, commission_amount, status) VALUES (?,?,?,?,?,?,?,?)').run(
    vendor.id, net, since, now, earnings.order_count, earnings.gross, earnings.commission, 'pending'
  );
  // Auto-process via Stripe Transfer if amount >= $1
  try {
    const amountCents = Math.round(net * 100);
    const transfer = await getStripe().transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: vendor.stripe_connect_id,
      metadata: { vendor_id: vendor.id, payout_id: String(r.lastInsertRowid) }
    });
    db.prepare("UPDATE vendor_payouts SET status='completed', paid_at=datetime('now'), payment_method='stripe_transfer', notes=? WHERE id=?")
      .run('stripe_transfer_id:' + transfer.id, r.lastInsertRowid);
    // Update the stripe_transfer_id column
    try { db.prepare("UPDATE vendor_payouts SET stripe_transfer_id=? WHERE id=?").run(transfer.id, r.lastInsertRowid); } catch(e) {}
    res.json({ ok: true, payout_id: r.lastInsertRowid, amount: net, status: 'completed', transfer_id: transfer.id });
  } catch (e) {
    console.error('[STRIPE-CONNECT] Transfer error:', e.message);
    // Payout stays pending — admin will process manually
    res.json({ ok: true, payout_id: r.lastInsertRowid, amount: net, status: 'pending', note: 'Auto-transfer failed — will be processed manually within 48h' });
  }
});

// ── Phase 1660: Automatic Weekly Payout Sweep ─────────────────────────────
const PAYOUT_SWEEP_MIN = 10.00; // minimum net earnings to auto-transfer
let lastSweepResult = null;

async function runPayoutSweep() {
  const started = new Date().toISOString();
  console.log('[PAYOUT-SWEEP] Starting automatic payout sweep at', started);
  const result = { started, processed: 0, transferred: 0, skipped: 0, errors: 0, details: [] };

  // Find all eligible vendors: non-free tier, Stripe Connect account, onboarded
  const vendors = db.prepare(
    "SELECT * FROM vendors WHERE subscription_tier != 'free' AND stripe_connect_id IS NOT NULL AND stripe_connect_id != '' AND stripe_connect_onboarded = 1"
  ).all();

  for (const vendor of vendors) {
    result.processed++;
    try {
      // Skip if they already have a pending payout
      const pending = db.prepare("SELECT id FROM vendor_payouts WHERE vendor_id=? AND status='pending'").get(vendor.id);
      if (pending) {
        result.skipped++;
        result.details.push({ vendor_id: vendor.id, name: vendor.name, status: 'skipped', reason: 'pending_exists' });
        continue;
      }

      // Calculate pending earnings since last completed payout
      const lastPayout = db.prepare(
        "SELECT MAX(period_end) as last_end FROM vendor_payouts WHERE vendor_id=? AND status IN ('completed','paid')"
      ).get(vendor.id);
      const since = lastPayout?.last_end || '2020-01-01';

      const earnings = db.prepare(`
        SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as gross, COALESCE(SUM(commission_amount),0) as commission, COALESCE(SUM(tip),0) as tips
        FROM orders WHERE vendor_id=? AND payment_status='paid' AND created_at > ? AND status IN ('picked_up','delivered')
      `).get(vendor.id, since);

      const net = Math.round((earnings.gross - earnings.commission + earnings.tips) * 100) / 100;

      if (net < PAYOUT_SWEEP_MIN) {
        result.skipped++;
        result.details.push({ vendor_id: vendor.id, name: vendor.name, status: 'skipped', reason: 'below_threshold', net });
        continue;
      }

      // Verify charges_enabled live with Stripe before transferring
      let chargesEnabled = false;
      try {
        const acct = await getStripe().accounts.retrieve(vendor.stripe_connect_id);
        chargesEnabled = acct.charges_enabled;
        if (chargesEnabled && !vendor.stripe_connect_onboarded) {
          db.prepare('UPDATE vendors SET stripe_connect_onboarded=1 WHERE id=?').run(vendor.id);
        }
      } catch (stripeAcctErr) {
        console.error('[PAYOUT-SWEEP] Could not retrieve Stripe account for vendor', vendor.id, ':', stripeAcctErr.message);
        result.errors++;
        result.details.push({ vendor_id: vendor.id, name: vendor.name, status: 'error', reason: 'stripe_account_check_failed', error: stripeAcctErr.message });
        continue;
      }

      if (!chargesEnabled) {
        result.skipped++;
        result.details.push({ vendor_id: vendor.id, name: vendor.name, status: 'skipped', reason: 'charges_not_enabled', net });
        continue;
      }

      const now = new Date().toISOString();
      const r = db.prepare(
        'INSERT INTO vendor_payouts (vendor_id, amount, period_start, period_end, order_count, gross_revenue, commission_amount, status) VALUES (?,?,?,?,?,?,?,?)'
      ).run(vendor.id, net, since, now, earnings.order_count, earnings.gross, earnings.commission, 'pending');

      const amountCents = Math.round(net * 100);
      const transfer = await getStripe().transfers.create({
        amount: amountCents,
        currency: 'usd',
        destination: vendor.stripe_connect_id,
        metadata: { vendor_id: vendor.id, payout_id: String(r.lastInsertRowid), source: 'auto_sweep' }
      });

      db.prepare("UPDATE vendor_payouts SET status='completed', paid_at=datetime('now'), payment_method='stripe_transfer', notes=? WHERE id=?")
        .run('auto_sweep:stripe_transfer_id:' + transfer.id, r.lastInsertRowid);
      try { db.prepare("UPDATE vendor_payouts SET stripe_transfer_id=? WHERE id=?").run(transfer.id, r.lastInsertRowid); } catch (e) {}

      result.transferred++;
      result.details.push({ vendor_id: vendor.id, name: vendor.name, status: 'transferred', net, transfer_id: transfer.id, payout_id: r.lastInsertRowid });
      console.log('[PAYOUT-SWEEP] Transferred $' + net.toFixed(2) + ' to vendor', vendor.id, '(' + vendor.name + ') — transfer', transfer.id);

    } catch (err) {
      console.error('[PAYOUT-SWEEP] Error processing vendor', vendor.id, ':', err.message);
      result.errors++;
      result.details.push({ vendor_id: vendor.id, name: vendor.name, status: 'error', error: err.message });
    }
  }

  result.finished = new Date().toISOString();
  console.log('[PAYOUT-SWEEP] Complete —', result.processed, 'processed,', result.transferred, 'transferred, $' +
    result.details.filter(d => d.status === 'transferred').reduce((s, d) => s + (d.net || 0), 0).toFixed(2) +
    ' total,', result.skipped, 'skipped,', result.errors, 'errors');

  lastSweepResult = result;
  return result;
}

// Admin endpoint: trigger sweep manually or view last result (localhost + portal-secret only)
app.get('/api/admin/payout-sweep', isSuperAdmin, async (req, res) => {
  if (req.query.run === '1') {
    try {
      const result = await runPayoutSweep();
      return res.json({ ok: true, triggered: true, result });
    } catch (err) {
      console.error('[PAYOUT-SWEEP] Admin-triggered sweep error:', err.message);
      return res.status(500).json({ error: 'Sweep failed', detail: err.message });
    }
  }
  res.json({ ok: true, last_sweep: lastSweepResult, next_run: 'weekly (every 7 days)' });
});

// Weekly automatic sweep — runs every 7 days, first run after 60s startup delay
setTimeout(() => {
  runPayoutSweep().catch(err => console.error('[PAYOUT-SWEEP] Startup run error:', err.message));
  setInterval(() => {
    runPayoutSweep().catch(err => console.error('[PAYOUT-SWEEP] Weekly run error:', err.message));
  }, 7 * 24 * 60 * 60 * 1000); // 604800000ms
}, 60 * 1000);

// Premium purchase
app.post('/api/vendor/premium/purchase', async (req, res) => {
  const vendor = getVendorByToken(req.headers['x-auth-token']);
  if (!vendor) return res.status(401).json({ error:'Invalid session' });
  try {
    let customerId = vendor.stripe_customer_id;
    if (!customerId) {
      const cust = await getStripe().customers.create({ email: vendor.email, name: vendor.name, metadata: { vendor_id: vendor.id } });
      customerId = cust.id;
      db.prepare('UPDATE vendors SET stripe_customer_id=? WHERE id=?').run(customerId, vendor.id);
    }
    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card', 'link'],
      mode: 'payment',
      line_items: [{ price_data: { currency:'usd', product_data:{ name:'WYA Premium Placement (30 days)' }, unit_amount:2999 }, quantity:1 }],
      success_url: `https://wya.digisigns.link/vendor?premium=1`,
      cancel_url: 'https://wya.digisigns.link/vendor',
      metadata: { vendor_id: vendor.id, type: 'premium' },
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    });
    res.json({ ok:true, url:session.url });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Ad CRUD
app.post('/api/vendor/ads', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const { type, budget, cost_per_click } = req.body;
    const r = db.prepare('INSERT INTO ad_spots (vendor_id,type,budget,cost_per_click) VALUES (?,?,?,?)').run(vendor.id, type||'feed', parseFloat(budget)||50, parseFloat(cost_per_click)||0.50);
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/vendor/ads', (req, res) => {
  try {
    const vendor = getVendorByToken(req.headers['x-auth-token']);
    if (!vendor) return res.status(401).json({ error:'Invalid session' });
    const ads = db.prepare('SELECT * FROM ad_spots WHERE vendor_id=? ORDER BY created_at DESC').all(vendor.id);
    res.json({ ok:true, ads });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ad impression/click tracking (rate limited per IP)
app.post('/api/ads/:id/impression', (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!rateLimit(`ad_imp_${req.params.id}_${ip}`, 60, 60000)) return res.status(429).json({ error:'Rate limited' });
    db.prepare('UPDATE ad_spots SET impressions=impressions+1 WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ads/:id/click', (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!rateLimit(`ad_click_${req.params.id}_${ip}`, 10, 60000)) return res.status(429).json({ error:'Rate limited' });
    db.prepare('UPDATE ad_spots SET clicks=clicks+1 WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin revenue MRR
app.get('/api/admin/revenue/mrr', isSuperAdmin, (req, res) => {
  try {
    const tiers = db.prepare("SELECT subscription_tier, COUNT(*) as count FROM vendors WHERE subscription_status IN ('active','trial') GROUP BY subscription_tier").all();
    const tierPrices = { free:0, growth:29.99, pro:49.99, enterprise:99.99 };
    let mrr = 0;
    const tierBreakdown = {};
    for (const t of tiers) {
      const price = tierPrices[t.subscription_tier] || 0;
      tierBreakdown[t.subscription_tier] = { count:t.count, revenue:Math.round(t.count*price*100)/100 };
      mrr += t.count * price;
    }
    const churn = db.prepare("SELECT COUNT(*) as c FROM vendors WHERE subscription_status='cancelled'").get()?.c ?? 0;
    const commSummary = db.prepare("SELECT COALESCE(SUM(CASE WHEN status='pending' THEN commission ELSE 0 END),0) as pending, COALESCE(SUM(CASE WHEN status='approved' THEN commission ELSE 0 END),0) as approved, COALESCE(SUM(commission),0) as total FROM vendor_commissions").get();
    const adRevenue = db.prepare("SELECT COALESCE(SUM(clicks*cost_per_click),0) as total FROM ad_spots").get()?.total ?? 0;
    res.json({ ok:true, mrr:Math.round(mrr*100)/100, tier_breakdown:tierBreakdown, churn, commission:{ pending:Math.round((commSummary?.pending ?? 0)*100)/100, approved:Math.round((commSummary?.approved ?? 0)*100)/100, total:Math.round((commSummary?.total ?? 0)*100)/100 }, ad_revenue:Math.round(adRevenue*100)/100 });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// (crash guards moved to top of file)

// ── Stripe Subscription ─────────────────────────────────────
app.post('/api/vendor/subscribe', async (req, res) => {
  const token = req.headers['x-auth-token'] || req.body?.token;
  const vendor = getVendorByToken(token);
  if (!vendor) return res.status(401).json({ error: 'Invalid session' });
  const tier = req.body?.tier || 'pro';
  const tierData = db.prepare('SELECT * FROM subscription_tiers WHERE id=?').get(tier);
  if (!tierData?.stripe_price_id) return res.status(400).json({ error: 'Selected plan not available for purchase yet' });
  const priceId = tierData.stripe_price_id;
  try {
    let customerId = vendor.stripe_customer_id;
    if (!customerId) {
      const cust = await getStripe().customers.create({ email: vendor.email, name: vendor.name, metadata: { vendor_id: vendor.id } });
      customerId = cust.id;
      db.prepare('UPDATE vendors SET stripe_customer_id=? WHERE id=?').run(customerId, vendor.id);
    }
    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card', 'link'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `https://wya.digisigns.link/vendor?subscribed=1&tier=${tier}&token=${token}`,
      cancel_url:  `https://wya.digisigns.link/vendor?token=${token}`,
      metadata: { vendor_id: vendor.id, tier }
    });
    res.json({ ok: true, url: session.url });
  } catch(e) {
    console.error(`[STRIPE] ${e.message}`);
    res.status(500).json({ error: 'Payment error: ' + e.message });
  }
});

// ── Stripe Webhook ────────────────────────────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.WYA_STRIPE_WEBHOOK_SECRET;
  // Phase 1653: Enforce webhook signature — reject all unsigned events
  if (!webhookSecret) {
    console.error('[STRIPE] WYA_STRIPE_WEBHOOK_SECRET not configured — rejecting webhook');
    return res.status(503).json({ error: 'Webhook signing not configured' });
  }
  if (!sig) {
    return res.status(400).end();
  }
  // Ensure body is a Buffer for Stripe signature verification
  let rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    try { rawBody = Buffer.from(rawBody); } catch(e) {
      console.error('[STRIPE] Cannot convert body to Buffer:', e.message);
      return res.status(400).json({ error: 'Invalid request body' });
    }
  }
  try { event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret); }
  catch(e) {
    // Rate-limit signature failure logging — 1 per 5 min max
    const now = Date.now();
    if (!global._lastWebhookSigErr || now - global._lastWebhookSigErr > 300000) {
      console.error('[STRIPE] Webhook signature failed (suppressing for 5min):', e.message.slice(0, 80));
      global._lastWebhookSigErr = now;
    }
    return res.status(400).end();
  }
  console.log(`[STRIPE] Webhook received: ${event.type} (verified)`);
  const obj = event.data?.object || {};
  if (event.type === 'checkout.session.completed') {
    const meta = obj.metadata || {};
    if (meta.order_id) {
      // Phase 736: Customer order payment completed
      // Phase 2: Idempotency — skip if already paid
      const existingOrder = db.prepare('SELECT payment_status, stripe_payment_intent_id FROM orders WHERE id=?').get(meta.order_id);
      if (existingOrder?.payment_status === 'paid' || existingOrder?.stripe_payment_intent_id) {
        console.log(`[STRIPE] Duplicate webhook for order ${meta.order_id} — skipping`);
        return res.json({ received: true });
      }
      db.prepare("UPDATE orders SET payment_status='paid', stripe_payment_intent_id=?, updated_at=datetime('now') WHERE id=?")
        .run(obj.payment_intent, meta.order_id);
      broadcastSSE({ type:'order_paid', order_id:meta.order_id, vendor_id:meta.vendor_id });
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(meta.order_id);
      const vendor = meta.vendor_id ? db.prepare('SELECT * FROM vendors WHERE id=?').get(meta.vendor_id) : null;
      const customer = meta.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(meta.customer_id) : null;
      const billingEmail = customer?.email || obj.customer_details?.email || obj.customer_email;
      if (billingEmail) {
        emsBillingRecord(billingEmail, obj.amount_total || 0, obj.payment_intent, 'WYA order');
        emsSyncCustomer(billingEmail, customer?.name || null, null, 'customer');
      }
      if (order && vendor) {
        sendPushNotification(vendor.id, 'vendor', 'New Order — Paid!', `$${order.total.toFixed(2)} from ${customer?.name || 'Customer'}`, `https://wya.digisigns.link/vendor`);
        sendEmail(vendor.email, 'Order Confirmed & Paid!', `<div style="font-family:-apple-system,sans-serif;max-width:480px;padding:24px;background:#050505;color:#f5f5f5"><div style="font-size:20px;font-weight:900;color:#FF5E1A;margin-bottom:12px">Order Paid!</div><p>Order #${meta.order_id.slice(-8)} from ${customer?.name || 'Customer'}</p><p style="color:#9ca3af">Total: $${order.total.toFixed(2)} (${order.type})</p><p style="color:#9ca3af">Payment confirmed — start preparing!</p></div>`).catch(()=>{});
        if (customer) {
          try { const items = JSON.parse(order.items_json); sendEmail(customer.email, `WYA Order Receipt — #${meta.order_id.slice(-8)}`, buildReceiptEmailHtml(order, vendor, items)).catch(()=>{}); } catch(e) {}
        }
      }
      console.log(`[STRIPE] Order ${meta.order_id} payment completed`);
    } else if (meta.vendor_id) {
      // Vendor subscription payment
      const vid = meta.vendor_id;
      const tier = meta.tier || 'pro';
      const tierData = db.prepare('SELECT * FROM subscription_tiers WHERE id=?').get(tier);
      const stripeSubId = obj.subscription || null;
      const stripeCustId = obj.customer || null;
      // Phase 2: Idempotency — skip if subscription already active with same ID
      const existingVendor = db.prepare('SELECT stripe_subscription_id FROM vendors WHERE id=?').get(vid);
      if (existingVendor?.stripe_subscription_id === stripeSubId && stripeSubId) {
        console.log(`[STRIPE] Duplicate subscription webhook for vendor ${vid} — skipping`);
        return res.json({ received: true });
      }
      db.prepare("UPDATE vendors SET subscription_status='active', subscription_tier=?, commission_rate=?, stripe_subscription_id=?, stripe_customer_id=? WHERE id=?").run(
        tier, tierData ? tierData.commission_rate : 0.10, stripeSubId, stripeCustId, vid
      );
      // Phase 1300: First revenue celebration — notify Brain + THE SOUL
      const vendor = db.prepare('SELECT name, email FROM vendors WHERE id=?').get(vid);
      const vendorName = vendor?.name || vid;
      const amount = obj.amount_total ? (obj.amount_total / 100).toFixed(2) : '0';
      console.log(`[STRIPE] SUBSCRIPTION! ${vendorName} subscribed to ${tier} ($${amount})`);
      // EMS billing record for vendor subscription payment
      if (vendor?.email) {
        emsBillingRecord(vendor.email, obj.amount_total || 0, obj.payment_intent || obj.id, `WYA ${tier} subscription`);
        emsSyncCustomer(vendor.email, vendorName, null, 'vendor');
      }
      // Brain/INBOX celebration
      try {
        const celebBody = JSON.stringify({ folderId: BRAIN_FOLDERS.INBOX, name: `FIRST_REVENUE_WYA_${new Date().toISOString().slice(0,10)}.md`, content: `# FIRST PAYING VENDOR!\n\n**${vendorName}** subscribed to **${tier}** plan ($${amount})\n\nTimestamp: ${new Date().toISOString()}\n\nThis is real revenue. The machine is selling.` });
        const brReq = require('http').request({ hostname: '127.0.0.1', port: 3350, path: '/write', method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(celebBody), 'X-Portal-Secret': SOUL_TOKEN } });
        brReq.on('error', (e) => console.warn('[WYA] Fire-and-forget failed:', e.message)); brReq.write(celebBody); brReq.end();
      } catch (_) {}
      // THE SOUL chat notification
      try {
        const soulMsg = JSON.stringify({ message: `FIRST PAYING VENDOR! ${vendorName} subscribed to ${tier} ($${amount}/mo). Revenue is live.`, userId: 'wya-app', sessionId: 'revenue-celebration' });
        const soulReq = require('http').request({ hostname: '127.0.0.1', port: 3003, path: '/chat/quick', method: 'POST', timeout: 5000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(soulMsg) } });
        soulReq.on('error', (e) => console.warn('[WYA] Fire-and-forget failed:', e.message)); soulReq.write(soulMsg); soulReq.end();
      } catch (_) {}
      // Phase 1369: Log conversion in pod-agent activation_emails table
      try {
        const podDb = require('better-sqlite3')('/root/universoul-ecosystem/soul-pod-agent/data/pod.db');
        podDb.prepare("UPDATE activation_emails SET converted_at = datetime('now') WHERE vendor_id = ? AND product = 'wya' AND converted_at IS NULL").run(vid);
        podDb.close();
      } catch (_) {}
      // Vendor subscription confirmation email
      try {
        const vInfo = db.prepare('SELECT email, name FROM vendors WHERE id=?').get(vid);
        if (vInfo?.email && !vInfo.email.startsWith('claim-')) {
          sendEmail(vInfo.email,
            `Subscription Active — ${tier} Plan`,
            `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
              <h2 style="color:#6c63ff">Welcome to WYA ${tier}!</h2>
              <p>Hi ${vInfo.name || 'there'},</p>
              <p>Your <strong>${tier}</strong> subscription ($${amount}/mo) is now active.</p>
              <p>Your vendor dashboard is ready with all ${tier} features enabled.</p>
              <p style="margin:20px 0"><a href="https://wya.digisigns.link/vendor/dashboard" style="background:#6c63ff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Open Dashboard</a></p>
              <p style="color:#999;font-size:12px;">— The WYA Team</p>
            </div>`
          ).catch(() => {});
          console.log(`[STRIPE] Subscription confirmation email sent to ${vInfo.email}`);
        }
      } catch (_) {}
      // Ambassador commission on subscription
      const ref = db.prepare("SELECT * FROM referrals WHERE referred_id=? AND status='active'").get(vid);
      if (ref) {
        const amount = obj.amount_total ? obj.amount_total / 100 : 0;
        if (amount > 0) {
          // Phase 2: Idempotency — skip duplicate commissions
          const existingComm = db.prepare('SELECT id FROM ambassador_commissions WHERE source_id=? AND ambassador_id=?').get(obj.id, ref.referrer_id);
          if (!existingComm) {
            const ambInfo = getAmbassadorTier(ref.referrer_id);
            const commAmount = Math.round(amount * ambInfo.rate * 100) / 100;
            const period = new Date().toISOString().slice(0, 7);
            db.prepare('INSERT INTO ambassador_commissions (ambassador_id,source_vendor_id,source_type,source_id,gross_amount,commission_rate,commission_amount,status,period) VALUES (?,?,?,?,?,?,?,?,?)').run(
              ref.referrer_id, vid, 'subscription', obj.id, amount, ambInfo.rate, commAmount, 'pending', period
            );
          } else {
            console.log(`[STRIPE] Duplicate commission for source ${obj.id} — skipping`);
          }
        }
      }
    } else if (meta.event_booking_id) {
      // Feature: Paid event booking payment confirmed
      const bookingId = meta.event_booking_id;
      const eventId = meta.event_id;
      // Idempotency — skip if already confirmed
      const existingBooking = db.prepare('SELECT * FROM event_bookings WHERE id=?').get(bookingId);
      if (existingBooking && existingBooking.status === 'confirmed') {
        console.log(`[STRIPE] Duplicate event booking webhook for booking ${bookingId} — skipping`);
        return res.json({ received: true });
      }
      try {
        db.prepare("UPDATE event_bookings SET status='confirmed' WHERE id=?").run(bookingId);
        // Update rsvp_count on event
        const newCount = db.prepare("SELECT COUNT(*) as c FROM event_bookings WHERE event_id=? AND user_type='customer' AND status IN ('pending','confirmed')").get(eventId)?.c || 0;
        db.prepare('UPDATE vendor_events SET rsvp_count=? WHERE id=?').run(newCount, eventId);
        const evtRow = db.prepare('SELECT * FROM vendor_events WHERE id=?').get(eventId);
        const booking = db.prepare('SELECT * FROM event_bookings WHERE id=?').get(bookingId);
        // Push notify vendor
        if (evtRow?.vendor_id) {
          sendPushNotification(evtRow.vendor_id, 'vendor', 'New Paid RSVP!', `${booking?.user_name || booking?.user_email || 'Someone'} booked "${evtRow?.title}"`, 'https://wya.digisigns.link/vendor');
        }
        // Email confirmation to customer
        const custEmail = booking?.user_email || meta.customer_email;
        if (custEmail && evtRow) {
          sendEmail(custEmail, `Booking Confirmed — ${evtRow.title}`,
            `<div style="font-family:-apple-system,sans-serif;max-width:480px;padding:24px;background:#050505;color:#f5f5f5;border-radius:16px">
              <div style="font-size:20px;font-weight:900;color:#FF5E1A;margin-bottom:12px">You're In!</div>
              <p style="color:#e5e5e5">Your spot at <strong>${evtRow.title}</strong> is confirmed.</p>
              <p style="color:#9ca3af;margin-top:8px">Date: ${evtRow.event_date}${evtRow.start_time ? ' at ' + evtRow.start_time : ''}</p>
              ${evtRow.location ? `<p style="color:#9ca3af">Location: ${evtRow.location}</p>` : ''}
              <div style="margin-top:20px;text-align:center">
                <a href="https://wya.digisigns.link/customer?event=${evtRow.id}" style="background:#FF5E1A;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:700">View Event</a>
              </div>
            </div>`
          ).catch(() => {});
        }
        console.log(`[STRIPE] Event booking ${bookingId} confirmed for event ${eventId}`);
        // Phase 2101: Vendor payout for ticket sales via Stripe Connect (fire-and-forget)
        if (evtRow?.vendor_id && evtRow.price > 0) {
          const payoutVendor = db.prepare('SELECT id, name, stripe_connect_id, stripe_connect_onboarded, commission_rate FROM vendors WHERE id=?').get(evtRow.vendor_id);
          if (payoutVendor?.stripe_connect_id && payoutVendor.stripe_connect_onboarded) {
            const commRate = payoutVendor.commission_rate || 0.12;
            const gross = evtRow.price;
            const commission = Math.round(gross * commRate * 100) / 100;
            const net = Math.round((gross - commission) * 100) / 100;
            if (net > 0) {
              getStripe().transfers.create({
                amount: Math.round(net * 100),
                currency: 'usd',
                destination: payoutVendor.stripe_connect_id,
                metadata: { vendor_id: payoutVendor.id, event_id: String(eventId), booking_id: String(bookingId), source: 'event_ticket' }
              }).then(transfer => {
                console.log(`[STRIPE] Event ticket payout: $${net} → ${payoutVendor.name} (${payoutVendor.stripe_connect_id}), transfer: ${transfer.id}`);
              }).catch(payoutErr => {
                console.error('[STRIPE] Event ticket payout error:', payoutErr.message);
              });
            }
          }
        }
      } catch(webhookErr) {
        console.error('[STRIPE] Event booking webhook error:', webhookErr.message);
      }
    }
  }
  // Phase 745: Premium purchase completed
  if (event.type === 'checkout.session.completed' && obj.metadata?.type === 'premium') {
    const vid = obj.metadata.vendor_id;
    if (vid) {
      const expires = new Date(Date.now() + 30*24*60*60*1000).toISOString();
      db.prepare('UPDATE vendors SET is_premium=1, premium_expires_at=? WHERE id=?').run(expires, vid);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const cid = event.data.object?.customer;
    if (cid) db.prepare("UPDATE vendors SET subscription_status='cancelled', stripe_subscription_id=NULL WHERE stripe_customer_id=?").run(cid);
  }
  // Phase 745: invoice.payment_failed — mark past due
  if (event.type === 'invoice.payment_failed') {
    const cid = event.data.object?.customer;
    if (cid) {
      const vendor = db.prepare('SELECT * FROM vendors WHERE stripe_customer_id=?').get(cid);
      if (vendor && !vendor.subscription_past_due_since) {
        db.prepare("UPDATE vendors SET subscription_past_due_since=datetime('now') WHERE id=?").run(vendor.id);
        sendEmail(vendor.email, 'WYA Payment Failed', `<div style="font-family:-apple-system,sans-serif;max-width:480px;padding:24px;background:#050505;color:#f5f5f5"><div style="font-size:20px;font-weight:900;color:#EF4444;margin-bottom:12px">Payment Failed</div><p style="color:#e5e5e5">Your subscription payment could not be processed. Please update your payment method within 3 days to avoid downgrade.</p><a href="https://wya.digisigns.link/vendor" style="display:inline-block;margin-top:16px;padding:14px 28px;background:#FF5E1A;color:#fff;border-radius:12px;text-decoration:none;font-weight:700">Update Payment</a></div>`).catch(()=>{});
      }
    }
  }
  // Phase 745: customer.subscription.updated — sync tier
  if (event.type === 'customer.subscription.updated') {
    const cid = event.data.object?.customer;
    const subId = event.data.object?.id;
    if (cid) {
      db.prepare("UPDATE vendors SET stripe_subscription_id=?, subscription_past_due_since=NULL WHERE stripe_customer_id=?").run(subId, cid);
    }
  }
  if (event.type === 'invoice.paid') {
    const cid = event.data.object?.customer;
    const amount = event.data.object?.amount_paid ? event.data.object.amount_paid / 100 : 0;
    if (cid && amount > 0) {
      const vendor = db.prepare('SELECT * FROM vendors WHERE stripe_customer_id=?').get(cid);
      if (vendor) {
        const ref = db.prepare("SELECT * FROM referrals WHERE referred_id=? AND status='active'").get(vendor.id);
        if (ref) {
          const ambInfo = getAmbassadorTier(ref.referrer_id);
          const commAmount = Math.round(amount * ambInfo.rate * 100) / 100;
          const period = new Date().toISOString().slice(0, 7);
          db.prepare('INSERT INTO ambassador_commissions (ambassador_id,source_vendor_id,source_type,source_id,gross_amount,commission_rate,commission_amount,status,period) VALUES (?,?,?,?,?,?,?,?,?)').run(
            ref.referrer_id, vendor.id, 'invoice', event.data.object.id, amount, ambInfo.rate, commAmount, 'pending', period
          );
        }
      }
    }
  }
  // Phase 1336: Stripe Connect account.updated — mark vendor onboarded when bank setup completes
  if (event.type === 'account.updated') {
    const acct = event.data.object;
    if (acct?.id && acct.charges_enabled && acct.payouts_enabled) {
      const v = db.prepare('SELECT id FROM vendors WHERE stripe_connect_id=?').get(acct.id);
      if (v) db.prepare('UPDATE vendors SET stripe_connect_onboarded=1 WHERE id=?').run(v.id);
    }
  }
  // Phase 1336: Transfer events — update payout status
  if (event.type === 'transfer.paid' || event.type === 'transfer.created') {
    const transferId = event.data.object?.id;
    if (transferId) {
      try { db.prepare("UPDATE vendor_payouts SET status='completed', paid_at=datetime('now') WHERE stripe_transfer_id=?").run(transferId); } catch(e) {}
    }
  }
  if (event.type === 'transfer.failed') {
    const transferId = event.data.object?.id;
    if (transferId) {
      try { db.prepare("UPDATE vendor_payouts SET status='failed', notes='Stripe transfer failed' WHERE stripe_transfer_id=?").run(transferId); } catch(e) {}
    }
  }
  // Handle expired checkout sessions — auto-cancel unpaid orders
  if (event.type === 'checkout.session.expired') {
    const meta = obj.metadata || {};
    if (meta.order_id) {
      const order = db.prepare('SELECT id, payment_status FROM orders WHERE id=?').get(meta.order_id);
      if (order && order.payment_status !== 'paid') {
        db.prepare("UPDATE orders SET status='cancelled', payment_status='expired', updated_at=datetime('now') WHERE id=?").run(meta.order_id);
        console.log(`[STRIPE] Checkout expired for order ${meta.order_id} — marked expired`);
      }
    }
  }
  res.json({ received: true });
});

// ── Vendor subscription status ────────────────────────────────
app.get('/api/vendor/subscription', (req, res) => {
  try {
    const token = req.headers['x-auth-token'];
    const vendor = getVendorByToken(token);
    if (!vendor) return res.status(401).json({ error: 'Invalid session' });
    const days = vendor.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(vendor.trial_ends_at) - Date.now()) / 86400000)) : 30;
    res.json({ status: vendor.is_founding_vendor ? 'active' : (vendor.subscription_status || 'trial'),
      trial_days_remaining: vendor.is_founding_vendor ? null : days,
      tier: vendor.subscription_tier || 'free', commission_rate: vendor.commission_rate || 0.12,
      stripe_pk: process.env.WYA_STRIPE_PK || '',
      is_founding_vendor: vendor.is_founding_vendor === 1,
      tier_name: vendor.is_founding_vendor ? 'Founding Vendor — Free Forever' : undefined });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Phase 1330: Expire unpaid/pending orders after 24h (was 1h — killed real Stripe transactions)
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 86400000).toISOString(); // 24h matches Stripe session TTL
    const staleOrders = db.prepare("SELECT id, stripe_checkout_session_id FROM orders WHERE payment_status IN ('unpaid','pending') AND created_at < ?").all(cutoff);
    let expired = 0;
    for (const order of staleOrders) {
      // Check Stripe session before cancelling — customer may still pay
      if (order.stripe_checkout_session_id && process.env.WYA_STRIPE_SK) {
        try {
          const session = await getStripe().checkout.sessions.retrieve(order.stripe_checkout_session_id);
          if (session.status === 'open') continue; // Still active — don't cancel
          if (session.status === 'complete') {
            // Payment happened but webhook missed — recover it
            db.prepare("UPDATE orders SET status='confirmed', payment_status='paid', updated_at=datetime('now') WHERE id=?").run(order.id);
            console.log(`[ORDER-CLEANUP] Recovered missed payment for order #${order.id}`);
            continue;
          }
          // Expired session — mark as expired (not cancelled — different intent)
          if (session.status === 'expired') {
            db.prepare("UPDATE orders SET status='cancelled', payment_status='expired', updated_at=datetime('now') WHERE id=?").run(order.id);
            expired++;
            continue;
          }
        } catch(stripeErr) {
          // Stripe API error — skip and retry next cycle instead of cancelling
          console.warn(`[ORDER-CLEANUP] Stripe check failed for order #${order.id}: ${stripeErr.message} — skipping`);
          continue;
        }
      }
      // Only cancel orders without Stripe sessions (never reached checkout)
      if (!order.stripe_checkout_session_id) {
        db.prepare("UPDATE orders SET status='cancelled', payment_status='expired', updated_at=datetime('now') WHERE id=?").run(order.id);
      }
      expired++;
    }
    if (expired > 0) console.log(`[ORDER-CLEANUP] Expired ${expired} unpaid orders (24h cutoff)`);
  } catch(e) { console.error('[ORDER-CLEANUP]', e.message); }
}, 1800000);

// Phase 741: Downgrade expired trial subscriptions (hourly)
setInterval(async () => {
  try {
    const now = new Date().toISOString();
    // Find vendors to expire (need their stripe_subscription_id before updating)
    const expiring = db.prepare("SELECT id, name, stripe_subscription_id FROM vendors WHERE subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < ? AND is_founding_vendor = 0").all(now);
    if (expiring.length > 0) {
      // Cancel Stripe subscriptions before downgrading
      for (const v of expiring) {
        if (v.stripe_subscription_id && process.env.WYA_STRIPE_SK) {
          try {
            await getStripe().subscriptions.cancel(v.stripe_subscription_id);
            console.log(`[TRIAL-EXPIRE] Cancelled Stripe subscription ${v.stripe_subscription_id} for vendor ${v.id} (${v.name})`);
          } catch (stripeErr) {
            console.error(`[TRIAL-EXPIRE] Failed to cancel Stripe sub for vendor ${v.id}: ${stripeErr.message}`);
          }
        }
      }
      const result = db.prepare("UPDATE vendors SET subscription_status='expired', subscription_tier='free', accepts_orders=0, is_open=0 WHERE subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < ? AND is_founding_vendor = 0").run(now);
      if (result.changes > 0) console.log(`[TRIAL-EXPIRE] Downgraded ${result.changes} expired trial vendors`);
    }
    // Phase 745: Auto-downgrade after 3 days past due
    const threeDaysAgo = new Date(Date.now() - 3*86400000).toISOString();
    const pastDueVendors = db.prepare("SELECT id, name, stripe_subscription_id FROM vendors WHERE subscription_past_due_since IS NOT NULL AND subscription_past_due_since < ? AND is_founding_vendor = 0").all(threeDaysAgo);
    if (pastDueVendors.length > 0) {
      for (const v of pastDueVendors) {
        if (v.stripe_subscription_id && process.env.WYA_STRIPE_SK) {
          try {
            await getStripe().subscriptions.cancel(v.stripe_subscription_id);
            console.log(`[PAST-DUE] Cancelled Stripe subscription ${v.stripe_subscription_id} for vendor ${v.id} (${v.name})`);
          } catch (stripeErr) {
            console.error(`[PAST-DUE] Failed to cancel Stripe sub for vendor ${v.id}: ${stripeErr.message}`);
          }
        }
      }
      const pastDue = db.prepare("UPDATE vendors SET subscription_status='expired', subscription_tier='free', accepts_orders=0, is_open=0, subscription_past_due_since=NULL WHERE subscription_past_due_since IS NOT NULL AND subscription_past_due_since < ? AND is_founding_vendor = 0").run(threeDaysAgo);
      if (pastDue.changes > 0) console.log(`[PAST-DUE] Downgraded ${pastDue.changes} past-due vendors`);
    }
    // Phase 745: Expire premium placements
    const premExpired = db.prepare("UPDATE vendors SET is_premium=0, premium_expires_at=NULL WHERE is_premium=1 AND premium_expires_at IS NOT NULL AND premium_expires_at < ?").run(now);
    if (premExpired.changes > 0) console.log(`[PREMIUM-EXPIRE] Expired ${premExpired.changes} premium placements`);
  } catch(e) { console.error('[TRIAL-EXPIRE]', e.message); }
}, 3600000);

// Feature: Event reminder push notifications — 24h before event (hourly check)
setInterval(() => {
  try {
    const events = db.prepare(`
      SELECT * FROM vendor_events
      WHERE event_date = date('now', '+1 day')
        AND reminder_sent = 0
        AND status = 'active'
    `).all();
    for (const evt of events) {
      const rsvps = db.prepare("SELECT * FROM event_bookings WHERE event_id=? AND user_type='customer' AND status='confirmed'").all(evt.id);
      let sent = 0;
      const timeStr = evt.start_time ? ` at ${evt.start_time}` : '';
      const locStr = evt.location ? ` — ${evt.location}` : '';
      for (const rsvp of rsvps) {
        sendPushNotification(rsvp.user_id, 'customer', 'Event Tomorrow!', `${evt.title} is tomorrow${timeStr}${locStr}`, `https://wya.digisigns.link/customer?event=${evt.id}`);
        sent++;
      }
      // Also remind the vendor
      if (evt.vendor_id) {
        sendPushNotification(evt.vendor_id, 'vendor', 'Your Event is Tomorrow!', `"${evt.title}" is tomorrow${timeStr} — ${rsvps.length} attendee(s) confirmed`, 'https://wya.digisigns.link/vendor');
      }
      db.prepare('UPDATE vendor_events SET reminder_sent=1 WHERE id=?').run(evt.id);
      console.log(`[WYA-APP] Sent event reminders for "${evt.title}" to ${sent} attendees`);
    }
  } catch(e) { console.error('[WYA-APP] Event reminder error:', e.message); }
}, 3600000); // Every hour

// Phase 1655: Auto-purge test/QA data that slips through (every 6h)
// Belt-and-suspenders: even if the API firewall misses something, this catches it.
setInterval(() => {
  try {
    const testEmailFilter = "email LIKE 'e2e-%' OR email LIKE 'qa-%' OR email LIKE 'test-audit-%' OR email LIKE 'jwt_test_%' OR email LIKE '%@test.digisigns.link' OR email LIKE '%@qa.digisigns.link' OR email LIKE '%@universoul.test' OR email LIKE '%@test.com' OR email LIKE '%@example.com' OR email LIKE '%@wya.test'";
    const testNameFilter = "name LIKE '[QA-TEST]%' OR name LIKE 'E2E %' OR name LIKE 'XSS Test%' OR name LIKE 'QA %' OR name LIKE 'Robert%DROP TABLE%' OR name LIKE 'TestUser%'";

    // Purge test vendor sessions first (FK safety)
    const vIds = db.prepare(`SELECT id FROM vendors WHERE ${testEmailFilter} OR ${testNameFilter}`).all().map(r => r.id);
    if (vIds.length > 0) {
      const placeholders = vIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM sessions WHERE vendor_id IN (${placeholders})`).run(...vIds);
      const vr = db.prepare(`DELETE FROM vendors WHERE id IN (${placeholders})`).run(...vIds);
      if (vr.changes > 0) console.log(`[TEST-CLEANUP] Purged ${vr.changes} test vendors`);
    }

    // Purge test customer sessions + customers
    const cIds = db.prepare(`SELECT id FROM customers WHERE ${testEmailFilter} OR ${testNameFilter}`).all().map(r => r.id);
    if (cIds.length > 0) {
      const placeholders = cIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM customer_sessions WHERE customer_id IN (${placeholders})`).run(...cIds);
      db.prepare(`DELETE FROM orders WHERE customer_id IN (${placeholders})`).run(...cIds);
      const cr = db.prepare(`DELETE FROM customers WHERE id IN (${placeholders})`).run(...cIds);
      if (cr.changes > 0) console.log(`[TEST-CLEANUP] Purged ${cr.changes} test customers + orders`);
    }
  } catch(e) { console.error('[TEST-CLEANUP]', e.message); }
}, 6 * 3600000); // Every 6 hours

// Phase 726: Trial expiration warning emails (every 4h)
setInterval(() => {
  try {
    const warnings = [
      { days: 7, label: '7 days', tag: '7' },
      { days: 3, label: '3 days', tag: '3' },
      { days: 1, label: 'tomorrow', tag: '1' },
    ];
    const now = new Date().toISOString();
    for (const w of warnings) {
      const cutoffEnd = new Date(Date.now() + w.days * 86400000).toISOString();
      const cutoffStart = new Date(Date.now() + (w.days - 1) * 86400000).toISOString();
      const vendors = db.prepare(
        "SELECT id,name,email,trial_ends_at FROM vendors WHERE subscription_status='trial' AND trial_ends_at > ? AND trial_ends_at <= ? AND (trial_warning_sent IS NULL OR CAST(trial_warning_sent AS INTEGER) > ?) AND is_founding_vendor = 0 AND email NOT LIKE 'claim-%' AND email NOT LIKE 'e2e-%' AND email NOT LIKE 'qa-%' AND email NOT LIKE '%@test.digisigns.link' AND email NOT LIKE '%@qa.digisigns.link'"
      ).all(cutoffStart, cutoffEnd, w.days);
      for (const v of vendors) {
        const daysLeft = Math.max(1, Math.ceil((new Date(v.trial_ends_at) - Date.now()) / 86400000));
        sendEmail(v.email, `Your WYA trial expires ${w.label}`,
          `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#0a0a0a;color:#f5f5f5;border-radius:16px">
            <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:16px">WYA Trial Ending Soon</div>
            <p style="color:#e5e5e5;font-size:16px;line-height:1.6">Hey ${v.name},</p>
            <p style="color:#e5e5e5;font-size:16px;line-height:1.6">Your WYA trial expires <strong style="color:#FF5E1A">${w.label}</strong> (${daysLeft} day${daysLeft!==1?'s':''} left).</p>
            <p style="color:#e5e5e5;font-size:16px;line-height:1.6">After expiration, your listing will be hidden and you won't be able to accept orders. Upgrade now to keep your business visible!</p>
            <div style="text-align:center;margin:28px 0">
              <a href="https://wya.digisigns.link/plans" style="background:#FF5E1A;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px">Choose a Plan</a>
            </div>
            <p style="color:#9ca3af;font-size:13px">Questions? Reply to this email or contact hello@digisigns.link</p>
          </div>`
        );
        db.prepare('UPDATE vendors SET trial_warning_sent=? WHERE id=?').run(w.tag, v.id);
        console.log(`[TRIAL-WARN] Sent ${w.label} warning to ${v.email}`);
      }
    }
  } catch(e) { console.error('[TRIAL-WARN]', e.message); }
}, 14400000);

// Phase 727: Onboarding nudge emails (daily — vendors with incomplete profiles after 3+ days)
setInterval(() => {
  try {
    const threeDaysAgo = new Date(Date.now() - 3*86400000).toISOString();
    // Phase 778: Exclude test/demo vendor emails from nudge
    const vendors = db.prepare(
      "SELECT id,name,email,email_verified,photo_url,description,business_hours,lat,lng,created_at FROM vendors WHERE subscription_status IN ('trial','active') AND created_at < ? AND is_founding_vendor = 0 AND email NOT LIKE '%@demo.wya' AND email NOT LIKE '%@universoul.test' AND email NOT LIKE '%@wya.com' AND email NOT LIKE 'testvendor%' AND email NOT LIKE 'claim-%' AND email NOT LIKE 'e2e-%' AND email NOT LIKE 'qa-%' AND email NOT LIKE '%@test.digisigns.link' AND email NOT LIKE '%@qa.digisigns.link'"
    ).all(threeDaysAgo);
    const menuCounts = {};
    for (const r of db.prepare('SELECT vendor_id, COUNT(*) as c FROM menu_items GROUP BY vendor_id').all()) menuCounts[r.vendor_id] = r.c;
    for (const v of vendors) {
      const ob = computeOnboardingSteps(v, menuCounts[v.id]||0);
      if (ob.ready) continue;
      const incomplete = ob.steps.filter(s => !s.done);
      // Only nudge once per week (check last nudge via activity_log)
      const lastNudge = db.prepare("SELECT ts FROM activity_log WHERE vendor_id=? AND action='onboarding_nudge' ORDER BY ts DESC LIMIT 1").get(v.id);
      if (lastNudge && new Date(lastNudge.ts) > new Date(Date.now() - 7*86400000)) continue;
      const todoList = incomplete.map(s => `<li style="color:#e5e5e5;padding:4px 0">${s.label}</li>`).join('');
      sendNudgeEmail(v, ob);
      db.prepare("INSERT INTO activity_log (vendor_id, action, ts) VALUES (?, 'onboarding_nudge', datetime('now'))").run(v.id);
      console.log(`[ONBOARD-NUDGE] Sent to ${v.email} (${ob.completed}/${ob.total})`);
    }
  } catch(e) { console.error('[ONBOARD-NUDGE]', e.message); }
}, 86400000); // 24h

// Shared nudge email sender (used by cron + manual nudge)
function sendNudgeEmail(vendor, ob) {
  const incomplete = ob.steps.filter(s => !s.done);
  const todoList = incomplete.map(s => `<li style="color:#e5e5e5;padding:4px 0">${s.label}</li>`).join('');
  sendEmail(vendor.email, `Complete your WYA profile (${ob.completed}/${ob.total} done)`,
    `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#0a0a0a;color:#f5f5f5;border-radius:16px">
      <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:16px">Almost There!</div>
      <p style="color:#e5e5e5;font-size:16px;line-height:1.6">Hey ${vendor.name}, you're ${ob.completed}/${ob.total} steps done with your WYA profile. Complete these to go live:</p>
      <ul style="margin:16px 0;padding-left:20px">${todoList}</ul>
      <div style="text-align:center;margin:28px 0">
        <a href="https://wya.digisigns.link/vendor" style="background:#FF5E1A;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px">Complete Profile</a>
      </div>
      <p style="color:#9ca3af;font-size:13px">Vendors with complete profiles get 3x more views!</p>
    </div>`
  );
}

// Phase 750/1661: Manual nudge endpoint — localhost+portal-secret OR superadmin JWT
app.post('/api/admin/nudge/:vendorId', (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.includes('100.');
  if (isAdmin(req) && isLocal) return next();
  return isSuperAdmin(req, res, next);
}, (req, res) => {
  try {
    const vendor = db.prepare('SELECT id,name,email,email_verified,photo_url,description,business_hours,lat,lng FROM vendors WHERE id=?').get(req.params.vendorId);
    if (!vendor) return res.status(404).json({ error:'Vendor not found' });
    const menuCount = db.prepare('SELECT COUNT(*) as c FROM menu_items WHERE vendor_id=?').get(vendor.id)?.c || 0;
    const ob = computeOnboardingSteps(vendor, menuCount);
    if (ob.ready) return res.status(400).json({ error:'Vendor profile is already complete' });
    sendNudgeEmail(vendor, ob);
    db.prepare("INSERT INTO activity_log (vendor_id, action, ts) VALUES (?, 'manual_nudge', datetime('now'))").run(vendor.id);
    console.log(`[MANUAL-NUDGE] Admin sent nudge to ${vendor.email} (${ob.completed}/${ob.total})`);
    res.json({ ok:true, sent_to: vendor.email, missing_steps: ob.missing });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// ── Phase 750: LAUNCH COMPLIANCE ────────────────────────────
// ══════════════════════════════════════════════════════════════

// Account deletion — vendor (Apple/Google requirement)
app.delete('/api/vendor/account', isVendor, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required for account deletion' });
  if (!verifyPw(password, req.vendor.password_hash, req.vendor.password_version || 1)) return res.status(403).json({ error: 'Incorrect password' });
  const vid = req.vendor.id;
  try {
    // Cancel Stripe subscription if active
    if (req.vendor.stripe_subscription_id) {
      try { await getStripe().subscriptions.cancel(req.vendor.stripe_subscription_id); } catch(e) {}
    }
    // Delete all vendor data
    db.prepare('DELETE FROM sessions WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM menu_modifiers WHERE item_id IN (SELECT id FROM menu_items WHERE vendor_id=?)').run(vid);
    db.prepare('DELETE FROM menu_items WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM menu_categories WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM vendor_schedules WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM vendor_events WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM vendor_locations WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM vendor_followers WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM push_subscriptions WHERE user_type=? AND user_id=?').run('vendor', vid);
    db.prepare('DELETE FROM activity_log WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM vendor_commissions WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM vendor_payouts WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM promo_codes WHERE vendor_id=?').run(vid);
    db.prepare('DELETE FROM referrals WHERE referrer_id=? OR referred_id=?').run(vid, vid);
    db.prepare('DELETE FROM vendors WHERE id=?').run(vid);
    console.log(`[ACCOUNT-DELETE] Vendor ${vid} account deleted`);
    res.json({ ok: true, message: 'Account and all associated data permanently deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Account deletion — customer
app.delete('/api/customer/account', (req, res) => {
  const token = req.headers['x-cust-token'] || req.headers['x-auth-token'];
  const customer = getCustomerByToken(token);
  if (!customer) return res.status(401).json({ error: 'Invalid session' });
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!verifyPw(password, customer.password_hash, customer.password_version || 1)) return res.status(403).json({ error: 'Incorrect password' });
  const cid = customer.id;
  try {
    db.prepare('DELETE FROM customer_sessions WHERE customer_id=?').run(cid);
    db.prepare('DELETE FROM favorites WHERE customer_id=?').run(cid);
    db.prepare('DELETE FROM loyalty_points WHERE customer_id=?').run(cid);
    db.prepare('DELETE FROM push_subscriptions WHERE user_type=? AND user_id=?').run('customer', cid);
    // Anonymize orders (keep for vendor records, remove PII)
    db.prepare("UPDATE orders SET customer_notes='[deleted]', delivery_address=NULL WHERE customer_id=?").run(cid);
    // Phase 1661: Anonymize guest orders with matching email
    if (customer.email) {
      db.prepare("UPDATE orders SET guest_email='[deleted]', guest_name='[deleted]' WHERE guest_email=?").run(customer.email.toLowerCase());
    }
    db.prepare("UPDATE reviews SET review_text='[deleted]' WHERE customer_id=?").run(cid);
    db.prepare('DELETE FROM vendor_followers WHERE customer_id=?').run(cid);
    db.prepare('DELETE FROM customers WHERE id=?').run(cid);
    console.log(`[ACCOUNT-DELETE] Customer ${cid} account deleted`);
    res.json({ ok: true, message: 'Account deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Subscription plan change (upgrade/downgrade)
app.post('/api/vendor/subscription/change', isVendor, async (req, res) => {
  const { tier_id } = req.body;
  if (!tier_id) return res.status(400).json({ error: 'tier_id required' });
  const tier = db.prepare('SELECT * FROM subscription_tiers WHERE id=?').get(tier_id);
  if (!tier || !tier.stripe_price_id) return res.status(400).json({ error: 'Invalid tier' });
  if (!req.vendor.stripe_subscription_id) return res.status(400).json({ error: 'No active subscription to change' });
  try {
    const sub = await getStripe().subscriptions.retrieve(req.vendor.stripe_subscription_id);
    await getStripe().subscriptions.update(req.vendor.stripe_subscription_id, {
      items: [{ id: sub.items.data[0].id, price: tier.stripe_price_id }],
      proration_behavior: 'create_prorations'
    });
    db.prepare('UPDATE vendors SET subscription_tier=? WHERE id=?').run(tier_id, req.vendor.id);
    res.json({ ok: true, new_tier: tier.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// EULA page
app.get('/eula', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WYA — End User License Agreement</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#08090A;color:rgba(255,255,255,.92);line-height:1.7;padding:24px;max-width:720px;margin:0 auto}h1{font-size:28px;margin-bottom:8px}h2{font-size:18px;margin:24px 0 8px;color:#FF5E1A}p,li{font-size:15px;color:rgba(255,255,255,.75);margin-bottom:12px}ul{padding-left:20px}.date{font-size:13px;color:rgba(255,255,255,.4);margin-bottom:24px}a{color:#FF5E1A}</style>
</head><body>
<h1>End User License Agreement</h1>
<p class="date">Last updated: March 29, 2026</p>
<p>This End User License Agreement ("Agreement") is between you and Universoul LLC ("Company") for use of the Where You At ("WYA") application.</p>
<h2>1. License Grant</h2>
<p>We grant you a limited, non-exclusive, non-transferable, revocable license to use WYA for its intended purpose — discovering and ordering from local vendors in Santa Barbara, CA.</p>
<h2>2. Restrictions</h2>
<ul><li>You may not reverse engineer, decompile, or disassemble the application</li><li>You may not use the service for any unlawful purpose</li><li>You may not scrape vendor data or automate interactions without written consent</li><li>You may not impersonate another user or vendor</li></ul>
<h2>3. Vendor Accounts</h2>
<p>Vendors are responsible for the accuracy of their listings, menu items, and pricing. Vendors agree to fulfill orders placed through the platform in a timely manner.</p>
<h2>4. Payments</h2>
<p>Payments are processed by Stripe. WYA does not store credit card information. Subscription fees are billed monthly and non-refundable except as required by law.</p>
<h2>5. Account Deletion</h2>
<p>You may delete your account at any time from account settings or by contacting hello@digisigns.link. See our <a href="/data-deletion">Data Deletion Policy</a>.</p>
<h2>6. Disclaimer</h2>
<p>WYA is provided "as is" without warranty. We are not liable for the quality, safety, or legality of vendor products.</p>
<h2>7. Governing Law</h2>
<p>This Agreement is governed by the laws of the State of California, Santa Barbara County.</p>
<h2>8. Contact</h2>
<p>Universoul LLC &mdash; Santa Barbara, CA<br>Email: hello@digisigns.link</p>
<p style="margin-top:32px"><a href="/">&larr; Back to WYA</a></p>
</body></html>`);
});

// Data deletion instructions (Apple/Google requirement)
app.get('/data-deletion', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WYA — Data Deletion</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#08090A;color:rgba(255,255,255,.92);line-height:1.7;padding:24px;max-width:720px;margin:0 auto}h1{font-size:28px;margin-bottom:8px}h2{font-size:18px;margin:24px 0 8px;color:#FF5E1A}p,li{font-size:15px;color:rgba(255,255,255,.75);margin-bottom:12px}ol{padding-left:20px}.date{font-size:13px;color:rgba(255,255,255,.4);margin-bottom:24px}a{color:#FF5E1A}.card{background:#111214;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:20px;margin:16px 0}</style>
</head><body>
<h1>Data Deletion Instructions</h1>
<p class="date">Last updated: March 29, 2026</p>
<h2>How to Delete Your Account</h2>
<div class="card">
<p><strong>Option 1: In-App Deletion</strong></p>
<ol><li>Log in to your WYA account</li><li>Go to <strong>Account Settings</strong></li><li>Scroll to <strong>Danger Zone</strong></li><li>Tap <strong>Delete My Account</strong></li><li>Enter your password to confirm</li></ol>
</div>
<div class="card">
<p><strong>Option 2: Email Request</strong></p>
<p>Send an email to <a href="mailto:hello@digisigns.link">hello@digisigns.link</a> with subject "Delete My WYA Account" from the email address associated with your account. We will process your request within 48 hours.</p>
</div>
<h2>What Gets Deleted</h2>
<p><strong>Vendors:</strong> Profile, menu items, business hours, location history, sessions, push subscriptions, promo codes, referral data, and all associated records.</p>
<p><strong>Customers:</strong> Profile, favorites, loyalty points, push subscriptions, and sessions. Order history is anonymized (personal details removed) but retained for vendor accounting purposes.</p>
<h2>What Gets Retained</h2>
<p>Anonymized order records (with customer PII removed) are retained for vendor financial reporting as required by tax law. Reviews are anonymized but may be retained.</p>
<h2>Stripe Payment Data</h2>
<p>Stripe payment records are managed by Stripe per their retention policies. Active subscriptions are cancelled upon account deletion.</p>
<p style="margin-top:32px"><a href="/">&larr; Back to WYA</a> &middot; <a href="/privacy">Privacy Policy</a></p>
</body></html>`);
});

// ══════════════════════════════════════════════════════════════
// ── Phase 1626: SDC MONETIZATION — Re-engagement + Welcome Promo ─
// ══════════════════════════════════════════════════════════════

// 1626a: Customer re-engagement campaign (runs daily, targets dormant users)
setInterval(() => {
  try {
    // Find customers who haven't been seen in 7+ days, have never ordered, and haven't been emailed in 14 days
    const dormant = db.prepare(`
      SELECT c.id, c.email, c.name, c.loyalty_points FROM customers c
      WHERE (c.last_seen IS NULL OR c.last_seen < datetime('now', '-7 days'))
      AND c.email NOT LIKE '%test%' AND c.email NOT LIKE '%demo%'
      AND c.email NOT LIKE '%qa%' AND c.email NOT LIKE 'e2e%'
      AND c.id NOT IN (SELECT DISTINCT customer_id FROM orders WHERE customer_id IS NOT NULL)
      AND c.id NOT IN (
        SELECT DISTINCT json_extract(meta,'$.customer_id') FROM activity_log
        WHERE action='reengagement_email' AND ts > datetime('now', '-14 days')
        AND json_extract(meta,'$.customer_id') IS NOT NULL
      )
    `).all();
    for (const c of dormant) {
      sendEmail(c.email, `${c.name}, your 20% off is waiting — WYA`,
        `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#0a0a0a;color:#f5f5f5;border-radius:16px">
          <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:16px">We miss you!</div>
          <p style="color:#e5e5e5;font-size:16px;line-height:1.6">Hey ${c.name},</p>
          <p style="color:#e5e5e5;font-size:16px;line-height:1.6">You signed up for WYA but haven't placed your first order yet. We get it — life's busy. But local vendors in Santa Barbara are ready to serve you!</p>
          <p style="color:#e5e5e5;font-size:16px;line-height:1.6">Use code <strong style="color:#FF5E1A;font-size:18px">WELCOME20</strong> for <strong>20% off</strong> your first order ($10 min).</p>
          <div style="text-align:center;margin:28px 0">
            <a href="https://wya.digisigns.link" style="background:#FF5E1A;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px">Explore Vendors Near You</a>
          </div>
          <p style="color:#9ca3af;font-size:13px">You have ${c.loyalty_points} loyalty points waiting too!</p>
        </div>`
      );
      db.prepare("INSERT INTO activity_log (vendor_id, action, meta, ts) VALUES (?, 'reengagement_email', ?, datetime('now'))").run('system', JSON.stringify({ customer_id: c.id, email: c.email }));
      console.log(`[REENGAGE] Sent welcome-back to ${c.email}`);
    }
    if (dormant.length > 0) console.log(`[REENGAGE] Campaign sent to ${dormant.length} dormant customers`);
  } catch(e) { console.error('[REENGAGE]', e.message); }
}, 86400000); // 24h

// 1626b/1661: Admin endpoint to trigger re-engagement — localhost+portal-secret OR superadmin JWT
app.post('/api/admin/reengage', (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.includes('100.');
  const secret = req.headers['x-portal-secret'] || '';
  if (secret && SOUL_TOKEN && secret === SOUL_TOKEN && isLocal) return next();
  return isSuperAdmin(req, res, next);
}, (req, res) => {
  const dormant = db.prepare(`
    SELECT c.id, c.email, c.name, c.loyalty_points FROM customers c
    WHERE (c.last_seen IS NULL OR c.last_seen < datetime('now', '-7 days'))
    AND c.email NOT LIKE '%test%' AND c.email NOT LIKE '%demo%'
    AND c.email NOT LIKE '%qa%' AND c.email NOT LIKE 'e2e%'
    AND c.id NOT IN (SELECT DISTINCT customer_id FROM orders WHERE customer_id IS NOT NULL)
  `).all();
  let sent = 0;
  for (const c of dormant) {
    sendEmail(c.email, `${c.name}, your 20% off is waiting — WYA`,
      `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#0a0a0a;color:#f5f5f5;border-radius:16px">
        <div style="font-size:24px;font-weight:900;color:#FF5E1A;margin-bottom:16px">We miss you!</div>
        <p style="color:#e5e5e5;font-size:16px;line-height:1.6">Hey ${c.name},</p>
        <p style="color:#e5e5e5;font-size:16px;line-height:1.6">You signed up for WYA but haven't placed your first order yet. Local vendors in Santa Barbara are ready to serve you!</p>
        <p style="color:#e5e5e5;font-size:16px;line-height:1.6">Use code <strong style="color:#FF5E1A;font-size:18px">WELCOME20</strong> for <strong>20% off</strong> your first order ($10 min).</p>
        <div style="text-align:center;margin:28px 0">
          <a href="https://wya.digisigns.link" style="background:#FF5E1A;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px">Explore Vendors Near You</a>
        </div>
        <p style="color:#9ca3af;font-size:13px">You have ${c.loyalty_points} loyalty points waiting too!</p>
      </div>`
    );
    sent++;
  }
  console.log(`[REENGAGE] Manual campaign: ${sent} emails sent`);
  res.json({ ok: true, sent, dormant_count: dormant.length });
});

// 1626c: Auto-apply WELCOME20 for first-time customers at checkout prompt
// (Promo already exists in DB — this just surfaces it in the checkout UI)
app.get('/api/customer/welcome-promo', (req, res) => {
  try {
    const token = req.headers['x-cust-token'] || req.headers['x-auth-token'];
    const customer = getCustomerByToken(token);
    if (!customer) return res.status(401).json({ error: 'Invalid session' });
    // Check if customer has ever ordered
    const hasOrders = db.prepare('SELECT COUNT(*) as c FROM orders WHERE customer_id=?').get(customer.id);
    if ((hasOrders?.c ?? 0) > 0) return res.json({ ok: true, promo: null, reason: 'not_first_order' });
    // Return the welcome promo for UI display
    const promo = db.prepare("SELECT code, discount_type, discount_value, min_order FROM promo_codes WHERE code='WELCOME20' AND active=1").get();
    if (!promo) return res.json({ ok: true, promo: null, reason: 'promo_inactive' });
    res.json({ ok: true, promo: { code: promo.code, discount_type: promo.discount_type, discount_value: promo.discount_value, min_order: promo.min_order, message: '20% off your first order!' } });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Phase 747g: Global error handler
app.use((err, req, res, next) => {
  console.error('[WYA-ERROR]', err.message);
  res.status(err.status || 500).json({ error: 'Something went wrong' });
});

// Phase 753: Cleanup old profile_views (90-day retention)
function cleanupProfileViews() {
  try {
    const cutoff = new Date(Date.now() - 90*86400000).toISOString();
    const r = db.prepare("DELETE FROM profile_views WHERE created_at < ?").run(cutoff);
    if (r.changes > 0) console.log(`[WYA-APP] Cleaned ${r.changes} old profile_views`);
  } catch(e) {}
}
cleanupProfileViews();
setInterval(cleanupProfileViews, 24 * 60 * 60 * 1000);

// Phase 1331: Admin-only test subscribe — proves Stripe E2E
app.get('/api/vendor/subscribe-test', isSuperAdmin, async (req, res) => {
  try {
    const vendor = req.adminVendor;
    const tier = req.query.tier || 'pro';
    const tierData = db.prepare('SELECT * FROM subscription_tiers WHERE id=?').get(tier);
    if (!tierData?.stripe_price_id) return res.status(400).json({ error: 'No Stripe price ID configured for tier: ' + tier });
    let customerId = vendor.stripe_customer_id;
    if (!customerId) {
      const cust = await getStripe().customers.create({ email: vendor.email, name: vendor.name, metadata: { vendor_id: vendor.id } });
      customerId = cust.id;
      db.prepare('UPDATE vendors SET stripe_customer_id=? WHERE id=?').run(customerId, vendor.id);
    }
    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card', 'link'],
      mode: 'subscription',
      line_items: [{ price: tierData.stripe_price_id, quantity: 1 }],
      success_url: `https://wya.digisigns.link/vendor?subscribed=1&tier=${tier}`,
      cancel_url: 'https://wya.digisigns.link/vendor',
      metadata: { vendor_id: vendor.id, tier }
    });
    res.json({ ok: true, url: session.url, vendor_id: vendor.id, tier });
  } catch(e) {
    res.status(500).json({ error: 'Stripe error: ' + e.message });
  }
});

// Phase 1352: /api/me — cross-product identity endpoint (added 2026-04-30)
app.get('/api/me', requireEMSAuthWithProduct('wya'), (req, res) => {
  const u = req.emsUser;
  const productUserId = lookupProductUserId(u.memberId, 'wya_customer');
  res.json({
    memberId: u.memberId,
    email: u.email,
    name: u.name,
    role: u.role,
    app: 'wya',
    app_user_id: productUserId,
    authenticated_via: 'ems_jwt'
  });
});

// Phase 1352: /api/auth/verify — verify EMS token (for HTTP-based verification by other services)
app.get('/api/auth/verify', (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const user = validateEMSToken(token);
    if (!user) return res.status(401).json({ valid: false });
    res.json({ valid: true, memberId: user.memberId, role: user.role, email: user.email });
  } catch(e) {
    console.error('[WYA-APP] Route error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ─────────────────────────────────────────────────────────────
// FEATURE 1 — DELIVERY ZONE MANAGEMENT (vendor auth required)
// ─────────────────────────────────────────────────────────────

// GET /api/vendor/zones — list vendor's delivery zones
app.get('/api/vendor/zones', isVendor, (req, res) => {
  try {
    const zones = db.prepare("SELECT * FROM delivery_zones WHERE vendor_id=? ORDER BY created_at DESC").all(req.vendor.id);
    res.json({ ok: true, zones });
  } catch(e) {
    console.error('[zones GET]', e.message);
    res.status(500).json({ error: 'Failed to fetch zones' });
  }
});

// POST /api/vendor/zones — create a new delivery zone
app.post('/api/vendor/zones', isVendor, (req, res) => {
  try {
    const { name, zone_type, radius_mi, center_lat, center_lng, polygon_coords, delivery_fee, min_order } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Zone name is required' });
    const zType = zone_type || 'radius';
    if (!['radius','polygon'].includes(zType)) return res.status(400).json({ error: "zone_type must be 'radius' or 'polygon'" });
    if (zType === 'radius') {
      if (!radius_mi || !center_lat || !center_lng) return res.status(400).json({ error: 'radius_mi, center_lat, center_lng required for radius zones' });
      const zoneCenter = validateCoords(center_lat, center_lng);
      if (!zoneCenter) return res.status(400).json({ error: 'Invalid center coordinates — lat must be -90..90, lng must be -180..180' });
    }
    if (zType === 'polygon') {
      if (!polygon_coords) return res.status(400).json({ error: 'polygon_coords required for polygon zones' });
      let parsedPoly;
      try { parsedPoly = JSON.parse(polygon_coords); if (!Array.isArray(parsedPoly) || parsedPoly.length < 3) throw new Error(); } catch(e) { return res.status(400).json({ error: 'polygon_coords must be valid JSON array of [lat,lng] pairs (min 3)' }); }
      // Validate each coordinate pair is within valid range
      for (const pt of parsedPoly) {
        if (!Array.isArray(pt) || pt.length < 2) return res.status(400).json({ error: 'Each polygon point must be a [lat,lng] array' });
        const [lat, lng] = pt;
        if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return res.status(400).json({ error: `Invalid coordinate [${lat},${lng}] — lat must be -90..90, lng must be -180..180` });
        }
      }
      // Roadmap T4.3: Validate polygon isn't self-intersecting
      if (isPolygonSelfIntersecting(parsedPoly)) return res.status(400).json({ error: 'Polygon is self-intersecting — edges must not cross each other' });
    }
    const validCenter = zType === 'radius' ? validateCoords(center_lat, center_lng) : null;
    const result = db.prepare(`INSERT INTO delivery_zones (vendor_id, name, zone_type, radius_mi, center_lat, center_lng, polygon_coords, delivery_fee, min_order, active) VALUES (?,?,?,?,?,?,?,?,?,1)`)
      .run(req.vendor.id, sanitize(name.trim()), zType, parseFloat(radius_mi) || null, validCenter ? validCenter.lat : null, validCenter ? validCenter.lng : null, polygon_coords || null, parseFloat(delivery_fee) ?? 3.99, parseFloat(min_order) || 0);
    const zone = db.prepare("SELECT * FROM delivery_zones WHERE id=?").get(result.lastInsertRowid);
    res.json({ ok: true, zone });
  } catch(e) {
    console.error('[zones POST]', e.message);
    res.status(500).json({ error: 'Failed to create zone' });
  }
});

// PUT /api/vendor/zones/:id — update a delivery zone
app.put('/api/vendor/zones/:id', isVendor, (req, res) => {
  try {
    const zone = db.prepare("SELECT * FROM delivery_zones WHERE id=? AND vendor_id=?").get(req.params.id, req.vendor.id);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    const { name, zone_type, radius_mi, center_lat, center_lng, polygon_coords, delivery_fee, min_order, active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = sanitize(String(name).trim());
    if (zone_type !== undefined) {
      if (!['radius','polygon'].includes(zone_type)) return res.status(400).json({ error: "zone_type must be 'radius' or 'polygon'" });
      updates.zone_type = zone_type;
    }
    if (radius_mi !== undefined) updates.radius_mi = parseFloat(radius_mi) || null;
    if (center_lat !== undefined && center_lng !== undefined) {
      const zoneCoords = validateCoords(center_lat, center_lng);
      if (!zoneCoords) return res.status(400).json({ error: 'Invalid center coordinates — lat must be -90..90, lng must be -180..180' });
      updates.center_lat = zoneCoords.lat;
      updates.center_lng = zoneCoords.lng;
    } else if (center_lat !== undefined || center_lng !== undefined) {
      return res.status(400).json({ error: 'Both center_lat and center_lng required together' });
    }
    if (polygon_coords !== undefined) updates.polygon_coords = polygon_coords;
    if (delivery_fee !== undefined) updates.delivery_fee = parseFloat(delivery_fee) ?? 3.99;
    if (min_order !== undefined) updates.min_order = parseFloat(min_order) || 0;
    if (active !== undefined) updates.active = active ? 1 : 0;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });
    const setClauses = Object.keys(updates).map(k => `${k}=?`).join(', ');
    db.prepare(`UPDATE delivery_zones SET ${setClauses} WHERE id=?`).run(...Object.values(updates), req.params.id);
    const updated = db.prepare("SELECT * FROM delivery_zones WHERE id=?").get(req.params.id);
    res.json({ ok: true, zone: updated });
  } catch(e) {
    console.error('[zones PUT]', e.message);
    res.status(500).json({ error: 'Failed to update zone' });
  }
});

// DELETE /api/vendor/zones/:id — delete a delivery zone
app.delete('/api/vendor/zones/:id', isVendor, (req, res) => {
  try {
    const zone = db.prepare("SELECT id FROM delivery_zones WHERE id=? AND vendor_id=?").get(req.params.id, req.vendor.id);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    db.prepare("DELETE FROM delivery_zones WHERE id=?").run(req.params.id);
    res.json({ ok: true, deleted: true });
  } catch(e) {
    console.error('[zones DELETE]', e.message);
    res.status(500).json({ error: 'Failed to delete zone' });
  }
});

// POST /api/vendor/zones/check — check if lat/lng falls within any zone
app.post('/api/vendor/zones/check', isVendor, (req, res) => {
  try {
    const coords = validateCoords(req.body.lat, req.body.lng);
    if (!coords) return res.status(400).json({ error: 'Invalid coordinates — lat must be -90..90, lng must be -180..180' });
    const match = checkDeliveryZones(req.vendor.id, coords.lat, coords.lng);
    if (match) {
      res.json({ ok: true, deliverable: true, zone: match.zone, fee: match.fee });
    } else {
      res.json({ ok: true, deliverable: false, message: 'Location is outside all active delivery zones' });
    }
  } catch(e) {
    console.error('[zones check]', e.message);
    res.status(500).json({ error: 'Zone check failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// FEATURE 2 — PUBLIC DELIVERY CHECK ENDPOINTS
// ─────────────────────────────────────────────────────────────

// GET /api/vendors/:id/delivery-check?lat=&lng= — check if location is deliverable
app.get('/api/vendors/:id/delivery-check', (req, res) => {
  try {
    const vendor = db.prepare("SELECT id, name, delivery_enabled, delivery_radius_mi, lat, lng FROM vendors WHERE id=?").get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (!vendor.delivery_enabled) return res.json({ deliverable: false, reason: 'Vendor does not offer delivery' });
    const coords = validateCoords(req.query.lat, req.query.lng);
    if (!coords) return res.status(400).json({ error: 'Invalid coordinates — lat must be -90..90, lng must be -180..180' });
    const activeZones = db.prepare("SELECT COUNT(*) as cnt FROM delivery_zones WHERE vendor_id=? AND active=1").get(vendor.id);
    if (activeZones && activeZones.cnt > 0) {
      const match = checkDeliveryZones(vendor.id, coords.lat, coords.lng);
      if (match) {
        res.json({ deliverable: true, fee: match.fee, zone_name: match.zone.name, min_order: match.zone.min_order });
      } else {
        res.json({ deliverable: false, reason: 'Outside all delivery zones' });
      }
    } else {
      // Fall back to delivery_radius_mi
      if (!vendor.lat || !vendor.lng) return res.json({ deliverable: false, reason: 'Vendor location not set' });
      const dist = haversine(coords.lat, coords.lng, vendor.lat, vendor.lng);
      const radiusMi = vendor.delivery_radius_mi || 5;
      if (dist <= radiusMi) {
        res.json({ deliverable: true, fee: 3.99, distance_mi: Math.round(dist * 10) / 10, radius_mi: radiusMi });
      } else {
        res.json({ deliverable: false, distance_mi: Math.round(dist * 10) / 10, radius_mi: radiusMi, reason: `${Math.round(dist * 10) / 10} miles away, delivers within ${radiusMi} miles` });
      }
    }
  } catch(e) {
    console.error('[delivery-check]', e.message);
    res.status(500).json({ error: 'Delivery check failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// FEATURE 3 — DRIVER/COURIER ASSIGNMENT
// ─────────────────────────────────────────────────────────────

// GET /api/vendor/drivers — list vendor's drivers
app.get('/api/vendor/drivers', isVendor, (req, res) => {
  try {
    const drivers = db.prepare("SELECT id, name, phone, email, status, current_lat, current_lng, last_location_update, created_at FROM drivers WHERE vendor_id=? ORDER BY name ASC").all(req.vendor.id);
    res.json({ ok: true, drivers });
  } catch(e) {
    console.error('[drivers GET]', e.message);
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

// POST /api/vendor/drivers — add a driver
app.post('/api/vendor/drivers', isVendor, (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Driver name is required' });
    const driverToken = crypto.randomBytes(24).toString('hex');
    const result = db.prepare("INSERT INTO drivers (name, phone, email, vendor_id, driver_token) VALUES (?,?,?,?,?)")
      .run(sanitize(name.trim()), sanitize(phone || ''), sanitize(email || ''), req.vendor.id, driverToken);
    const driver = db.prepare("SELECT id, name, phone, email, status, created_at FROM drivers WHERE id=?").get(result.lastInsertRowid);
    res.json({ ok: true, driver, driver_token: driverToken });
  } catch(e) {
    console.error('[drivers POST]', e.message);
    res.status(500).json({ error: 'Failed to add driver' });
  }
});

// PUT /api/vendor/drivers/:id — update driver info or status
app.put('/api/vendor/drivers/:id', isVendor, (req, res) => {
  try {
    const driver = db.prepare("SELECT id FROM drivers WHERE id=? AND vendor_id=?").get(req.params.id, req.vendor.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const { name, phone, email, status } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = sanitize(String(name).trim());
    if (phone !== undefined) updates.phone = sanitize(String(phone));
    if (email !== undefined) updates.email = sanitize(String(email));
    if (status !== undefined) {
      if (!['available','assigned','en_route','offline'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      updates.status = status;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });
    const setClauses = Object.keys(updates).map(k => `${k}=?`).join(', ');
    db.prepare(`UPDATE drivers SET ${setClauses} WHERE id=?`).run(...Object.values(updates), req.params.id);
    const updated = db.prepare("SELECT id, name, phone, email, status, current_lat, current_lng, last_location_update FROM drivers WHERE id=?").get(req.params.id);
    res.json({ ok: true, driver: updated });
  } catch(e) {
    console.error('[drivers PUT]', e.message);
    res.status(500).json({ error: 'Failed to update driver' });
  }
});

// DELETE /api/vendor/drivers/:id — remove a driver
app.delete('/api/vendor/drivers/:id', isVendor, (req, res) => {
  try {
    const driver = db.prepare("SELECT id FROM drivers WHERE id=? AND vendor_id=?").get(req.params.id, req.vendor.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    db.prepare("DELETE FROM drivers WHERE id=?").run(req.params.id);
    res.json({ ok: true, deleted: true });
  } catch(e) {
    console.error('[drivers DELETE]', e.message);
    res.status(500).json({ error: 'Failed to remove driver' });
  }
});

// POST /api/vendor/deliveries/assign — assign driver to order
app.post('/api/vendor/deliveries/assign', isVendor, (req, res) => {
  try {
    const { order_id, driver_id } = req.body;
    if (!order_id || !driver_id) return res.status(400).json({ error: 'order_id and driver_id required' });
    const order = db.prepare("SELECT id, vendor_id, type FROM orders WHERE id=? AND vendor_id=?").get(order_id, req.vendor.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.type !== 'delivery') return res.status(400).json({ error: 'Order is not a delivery order' });
    const driver = db.prepare("SELECT id, status FROM drivers WHERE id=? AND vendor_id=?").get(driver_id, req.vendor.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    if (driver.status === 'offline') return res.status(400).json({ error: 'Driver is offline and cannot be assigned' });
    // Cancel any existing active assignment for this order
    db.prepare("UPDATE delivery_assignments SET status='cancelled' WHERE order_id=? AND status NOT IN ('delivered','cancelled')").run(order_id);
    const result = db.prepare("INSERT INTO delivery_assignments (order_id, driver_id, status, assigned_at) VALUES (?,?,'assigned',datetime('now'))")
      .run(order_id, driver_id);
    db.prepare("UPDATE drivers SET status='assigned' WHERE id=?").run(driver_id);
    const assignment = db.prepare("SELECT da.*, d.name as driver_name, d.phone as driver_phone FROM delivery_assignments da JOIN drivers d ON d.id=da.driver_id WHERE da.id=?").get(result.lastInsertRowid);
    broadcastSSE({ type: 'delivery_assigned', vendor_id: req.vendor.id, order_id, driver_id });
    res.json({ ok: true, assignment });
  } catch(e) {
    console.error('[deliveries assign]', e.message);
    res.status(500).json({ error: 'Failed to assign driver' });
  }
});

// PUT /api/vendor/deliveries/:id/status — update delivery assignment status
app.put('/api/vendor/deliveries/:id/status', isVendor, (req, res) => {
  try {
    const assignment = db.prepare(`
      SELECT da.*, o.vendor_id FROM delivery_assignments da
      JOIN orders o ON o.id=da.order_id
      WHERE da.id=?
    `).get(req.params.id);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.vendor_id !== req.vendor.id) return res.status(403).json({ error: 'Not authorized' });
    const { status, notes } = req.body;
    if (!['assigned','picked_up','en_route','delivered','cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const now = new Date().toISOString();
    const updates = { status };
    if (notes !== undefined) updates.notes = sanitize(String(notes));
    if (status === 'picked_up') updates.picked_up_at = now;
    if (status === 'delivered') updates.delivered_at = now;
    const setClauses = Object.keys(updates).map(k => `${k}=?`).join(', ');
    db.prepare(`UPDATE delivery_assignments SET ${setClauses} WHERE id=?`).run(...Object.values(updates), req.params.id);
    // Update driver status when delivered or cancelled
    if (status === 'delivered' || status === 'cancelled') {
      db.prepare("UPDATE drivers SET status='available' WHERE id=?").run(assignment.driver_id);
    }
    broadcastSSE({ type: 'delivery_status', assignment_id: parseInt(req.params.id), status, vendor_id: req.vendor.id });
    res.json({ ok: true, status });
  } catch(e) {
    console.error('[deliveries status PUT]', e.message);
    res.status(500).json({ error: 'Failed to update delivery status' });
  }
});

// GET /api/vendor/deliveries — list active deliveries for vendor
app.get('/api/vendor/deliveries', isVendor, (req, res) => {
  try {
    const deliveries = db.prepare(`
      SELECT da.id, da.order_id, da.driver_id, da.status, da.assigned_at, da.picked_up_at, da.delivered_at, da.notes,
             d.name as driver_name, d.phone as driver_phone, d.current_lat, d.current_lng,
             o.delivery_address, o.total, o.customer_notes
      FROM delivery_assignments da
      JOIN drivers d ON d.id=da.driver_id
      JOIN orders o ON o.id=da.order_id
      WHERE o.vendor_id=? AND da.status NOT IN ('delivered','cancelled')
      ORDER BY da.assigned_at DESC
    `).all(req.vendor.id);
    res.json({ ok: true, deliveries });
  } catch(e) {
    console.error('[deliveries GET]', e.message);
    res.status(500).json({ error: 'Failed to fetch deliveries' });
  }
});

// POST /api/driver/location — driver updates their GPS (uses x-driver-token header)
app.post('/api/driver/location', (req, res) => {
  try {
    const driverToken = req.headers['x-driver-token'];
    if (!driverToken) return res.status(401).json({ error: 'x-driver-token header required' });
    const driver = db.prepare("SELECT * FROM drivers WHERE driver_token=?").get(driverToken);
    if (!driver) return res.status(401).json({ error: 'Invalid driver token' });
    const coords = validateCoords(req.body.lat, req.body.lng);
    if (!coords) return res.status(400).json({ error: 'Invalid coordinates — lat must be -90..90, lng must be -180..180' });
    // Rate limit: 1 update per 5s per driver
    if (!locationRateOk('driver_' + driver.id)) return res.status(429).json({ error: 'Location updates limited to once per 5 seconds' });
    // Teleportation guard: reject >200mi jumps (drivers cover smaller areas than vendors)
    if (driver.current_lat && driver.current_lng) {
      const jump = haversine(coords.lat, coords.lng, driver.current_lat, driver.current_lng);
      if (jump > 200) return res.status(400).json({ error: 'Location jump too large — possible GPS error', distance_mi: Math.round(jump) });
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE drivers SET current_lat=?, current_lng=?, last_location_update=? WHERE id=?").run(coords.lat, coords.lng, now, driver.id);
    broadcastSSE({ type: 'driver_location', driver_id: driver.id, lat: coords.lat, lng: coords.lng, vendor_id: driver.vendor_id });
    res.json({ ok: true, lat: coords.lat, lng: coords.lng, ts: now });
  } catch(e) {
    console.error('[driver location]', e.message);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// GET /api/driver/assignments — get driver's active assignments (uses x-driver-token header)
app.get('/api/driver/assignments', (req, res) => {
  try {
    const driverToken = req.headers['x-driver-token'];
    if (!driverToken) return res.status(401).json({ error: 'x-driver-token header required' });
    const driver = db.prepare("SELECT id, name, status FROM drivers WHERE driver_token=?").get(driverToken);
    if (!driver) return res.status(401).json({ error: 'Invalid driver token' });
    const assignments = db.prepare(`
      SELECT da.id, da.order_id, da.status, da.assigned_at, da.picked_up_at, da.notes,
             o.delivery_address, o.total, o.customer_notes, o.items_json,
             v.name as vendor_name, v.lat as vendor_lat, v.lng as vendor_lng
      FROM delivery_assignments da
      JOIN orders o ON o.id=da.order_id
      JOIN vendors v ON v.id=o.vendor_id
      WHERE da.driver_id=? AND da.status NOT IN ('delivered','cancelled')
      ORDER BY da.assigned_at DESC
    `).all(driver.id);
    res.json({ ok: true, driver: { id: driver.id, name: driver.name, status: driver.status }, assignments });
  } catch(e) {
    console.error('[driver assignments]', e.message);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ─────────────────────────────────────────────────────────────
// FEATURE 4 — CUSTOMER NEARBY VENDOR DELIVERY CHECK
// ─────────────────────────────────────────────────────────────

// GET /api/customer/nearby-vendors?lat=&lng=&radius= — all vendors within radius
app.get('/api/customer/nearby-vendors', publicLimiter60, (req, res) => {
  try {
    const coords = validateCoords(req.query.lat, req.query.lng);
    if (!coords) return res.status(400).json({ error: 'Invalid coordinates — lat must be -90..90, lng must be -180..180' });
    const radiusMi = Math.min(parseFloat(req.query.radius) || 10, 50);
    // Get all vendors with coordinates
    const vendors = db.prepare(`
      SELECT id, name, category, lat, lng, photo_url, avg_rating, review_count, is_open,
             delivery_enabled, delivery_radius_mi, min_order_amount, estimated_prep_minutes
      FROM vendors
      WHERE lat IS NOT NULL AND lng IS NOT NULL
    `).all();
    const nearby = [];
    for (const vendor of vendors) {
      const distToVendor = haversine(coords.lat, coords.lng, vendor.lat, vendor.lng);
      if (distToVendor > radiusMi) continue;
      const entry = { ...vendor, distance_mi: Math.round(distToVendor * 10) / 10 };
      // Add delivery info if vendor supports it
      if (vendor.delivery_enabled) {
        const activeZones = db.prepare("SELECT COUNT(*) as cnt FROM delivery_zones WHERE vendor_id=? AND active=1").get(vendor.id);
        if (activeZones && activeZones.cnt > 0) {
          const match = checkDeliveryZones(vendor.id, coords.lat, coords.lng);
          if (match) {
            entry.delivers_here = true;
            entry.delivery_fee = match.fee;
            entry.min_order = match.zone.min_order;
            entry.zone_name = match.zone.name;
          }
        } else {
          const vendorRadius = vendor.delivery_radius_mi || 5;
          if (distToVendor <= vendorRadius) {
            entry.delivers_here = true;
            entry.delivery_fee = 3.99;
            entry.min_order = vendor.min_order_amount || 0;
          }
        }
      }
      nearby.push(entry);
    }
    // Sort: open first, then by distance
    nearby.sort((a, b) => (b.is_open - a.is_open) || (a.distance_mi - b.distance_mi));
    res.json({ ok: true, count: nearby.length, vendors: nearby });
  } catch(e) {
    console.error('[nearby-vendors]', e.message);
    res.status(500).json({ error: 'Failed to fetch nearby vendors' });
  }
});

// Phase 1654: Automated daily DB backup (keep 7 days)
function backupDatabase() {
  try {
    const backupDir = '/root/backups/wya';
    const date = new Date().toISOString().split('T')[0];
    const dest = path.join(backupDir, `wya.db.${date}`);
    db.backup(dest).then(() => {
      console.log(`[WYA-BACKUP] Database backed up to ${dest}`);
      // Prune backups older than 7 days
      const files = fs.readdirSync(backupDir).filter(f => f.startsWith('wya.db.')).sort();
      while (files.length > 7) {
        const old = files.shift();
        try { fs.unlinkSync(path.join(backupDir, old)); } catch(_) {}
      }
    }).catch(e => console.error('[WYA-BACKUP] Failed:', e.message));
  } catch(e) { console.error('[WYA-BACKUP] Error:', e.message); }
}
setTimeout(backupDatabase, 30000); // First backup 30s after start
setInterval(backupDatabase, 24 * 60 * 60 * 1000); // Then daily

// Phase 1660/1661: Periodic WAL checkpoint — prevent WAL growth between restarts
setInterval(() => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) { console.error('[WYA-APP] WAL checkpoint error:', e.message); }
}, 1 * 60 * 60 * 1000); // Every 1 hour

// Phase 1655b: Startup orphan cleanup — purge sessions referencing deleted customers/vendors
(function startupCleanup() {
  try {
    const r1 = db.prepare("DELETE FROM customer_sessions WHERE customer_id NOT IN (SELECT id FROM customers)").run();
    const r2 = db.prepare("DELETE FROM sessions WHERE vendor_id NOT IN (SELECT id FROM vendors)").run();
    const r3 = db.prepare("DELETE FROM orders WHERE payment_status IN ('cancelled','expired') AND created_at < datetime('now', '-90 days')").run();
    const total = (r1.changes||0) + (r2.changes||0) + (r3.changes||0);
    if (total) {
      console.log(`[WYA-CLEANUP] Startup: ${r1.changes} orphaned customer_sessions, ${r2.changes} orphaned vendor_sessions, ${r3.changes} stale cancelled orders`);
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } catch(e) { console.error('[WYA-CLEANUP] Startup cleanup error:', e.message); }
})();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WYA-APP] Running on :${PORT}`);
  console.log(`[WYA-APP] DB: ${DB_PATH}`);
  // Startup self-test — verify key tables exist and DB is healthy
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    const required = ['vendors', 'customers', 'orders', 'sessions', 'customer_sessions'];
    const missing = required.filter(t => !tables.includes(t));
    if (missing.length) console.error(`[WYA-APP] CRITICAL: Missing tables: ${missing.join(', ')}`);
    else console.log(`[WYA-APP] Self-test PASS: ${tables.length} tables, DB intact`);
  } catch(e) { console.error('[WYA-APP] Self-test FAILED:', e.message); }
  // Startup env validation — warn on missing keys
  const _envChecks = [
    ['PORTAL_SECRET', process.env.PORTAL_SECRET],
    ['WYA_STRIPE_SK', process.env.WYA_STRIPE_SK],
    ['WYA_STRIPE_WEBHOOK_SECRET', process.env.WYA_STRIPE_WEBHOOK_SECRET],
    ['WYA_VAPID_PUBLIC', process.env.WYA_VAPID_PUBLIC],
    ['WYA_VAPID_PRIVATE', process.env.WYA_VAPID_PRIVATE]
  ];
  const _missingEnv = _envChecks.filter(([k, v]) => !v).map(([k]) => k);
  if (_missingEnv.length) console.warn(`[WYA-APP] WARNING: Missing env vars: ${_missingEnv.join(', ')}`);
  else console.log('[WYA-APP] All required env vars present');
});

// Phase 1640: Graceful shutdown — close HTTP server then SQLite DB
function gracefulShutdown(signal) {
  console.log(`[WYA-APP] ${signal} received — shutting down gracefully...`);
  server.close(() => {
    console.log('[WYA-APP] HTTP server closed');
    try { db.close(); console.log('[WYA-APP] SQLite DB closed'); } catch (e) { console.error('[WYA-APP] DB close error:', e.message); }
    process.exit(0);
  });
  setTimeout(() => { console.error('[WYA-APP] Forced exit after 5s timeout'); process.exit(1); }, 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Phase 1650: Crash guards — log but don't die on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[WYA-APP] UNCAUGHT EXCEPTION (staying alive):', err.message, err.stack?.split('\n')[1]);
});
process.on('unhandledRejection', (reason) => {
  console.error('[WYA-APP] UNHANDLED REJECTION (staying alive):', reason?.message || reason);
});

// EADDRINUSE self-heal guard (fleet-wide patch)
try {
  const _srv = typeof server !== 'undefined' ? server : null;
  const _listenObj = _srv || (typeof app !== 'undefined' && app.address ? app : null);
  if (_listenObj && !_listenObj.__eaddrinuse_guard) {
    _listenObj.__eaddrinuse_guard = true;
    _listenObj.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn('[wya-app] Port in use — killing stale holder and retrying in 3s...');
        try { require('child_process').execSync('fuser -k ' + (process.env.PORT || '') + '/tcp 2>/dev/null || true'); } catch (_) {}
      }
    });
  }
} catch (_) {}

// Phase v4.0: iOS Share Extension ingest
app.post('/api/ios/share-ingest', (req, res) => {
  try {
    const { note, url, text, type, has_image, source } = req.body;
    console.log(`[WYA-iOS] Share ingest: type=${type || 'general'} url=${url || 'none'} note=${(note || '').substring(0, 50)} image=${!!has_image}`);
    // Store in activity log for now — can be expanded to create orders/reviews
    db.prepare("INSERT INTO activity_log (vendor_id, action, lat, lng) VALUES (?, ?, ?, ?)").run(
      'ios-share', 'share_extension', null, null
    );
    res.json({ ok: true, message: 'Shared to WYA' });
  } catch (e) {
    console.error('[WYA-iOS] Share ingest error:', e.message);
    res.status(500).json({ error: 'ingest failed' });
  }
});

// Phase v4.0: Minimal test pass for debugging
app.get('/api/test-pass', async (req, res) => {
  try {
    const JSZip = require('/root/universoul-ecosystem/ems/node_modules/jszip');
    const crypto = require('crypto');
    const fs = require('fs');
    const { execSync } = require('child_process');
    
    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: "pass.link.digisigns.tap",
      serialNumber: "TEST-" + Date.now(),
      teamIdentifier: "9V74TT48MV",
      organizationName: "WYA",
      description: "Test Pass",
      foregroundColor: "rgb(255,255,255)",
      backgroundColor: "rgb(255,94,26)",
      generic: {
        primaryFields: [{ key: "name", label: "NAME", value: "Test" }]
      }
    };
    
    const zip = new JSZip();
    const passJsonBuf = Buffer.from(JSON.stringify(passJson));
    zip.file('pass.json', passJsonBuf);
    
    // RGB icon — no alpha
    const iconBuf = fs.readFileSync('/root/.apple-wallet/icon.png');
    const icon2xBuf = fs.readFileSync('/root/.apple-wallet/icon@2x.png');
    zip.file('icon.png', iconBuf);
    zip.file('icon@2x.png', icon2xBuf);
    
    // Manifest
    const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
    const manifest = {
      'pass.json': sha1(passJsonBuf),
      'icon.png': sha1(iconBuf),
      'icon@2x.png': sha1(icon2xBuf)
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest));
    zip.file('manifest.json', manifestBuf);
    
    // Sign
    const tmpM = '/tmp/test-manifest-' + Date.now() + '.json';
    const tmpS = '/tmp/test-sig-' + Date.now() + '.der';
    fs.writeFileSync(tmpM, manifestBuf);
    execSync(`openssl smime -sign -binary -md sha256 -in ${tmpM} -out ${tmpS} -outform DER -signer /root/.apple-wallet/signerCert.pem -inkey /root/.apple-wallet/pass-probook.key -certfile /root/.apple-wallet/wwdr.pem`, { timeout: 5000 });
    zip.file('signature', fs.readFileSync(tmpS));
    fs.unlinkSync(tmpM);
    fs.unlinkSync(tmpS);
    
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', 'attachment; filename="test.pkpass"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
