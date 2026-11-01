/**
 * WYA App Store Connect Metadata Filler
 * Run this after creating the app entry in App Store Connect
 * Usage: node scripts/fill-app-metadata.js
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const https = require('https');

const KEY_ID = '6T7FMU83Q3';
const ISSUER_ID = '54717bff-71a1-46bc-a578-a94db1886499';
const PRIVATE_KEY_PATH = '/root/BRAIN/CREDENTIALS/AuthKey_6T7FMU83Q3.p8';

const APP_METADATA = {
  name: 'WYA — Where You At',
  subtitle: 'Find Local Vendors Near You',
  description: `WYA is the real-time vendor discovery app for Santa Barbara. Find food trucks, pop-up shops, farmers market vendors, and local businesses — exactly when and where they're open.

For Customers:
• See vendors on a live map with real-time GPS locations
• Filter by category: food trucks, coffee, bakeries, art, services
• View menus, hours, and reviews before you visit
• Get directions and order ahead from your favorites

For Vendors:
• Go live with one tap — customers see you instantly
• Track your earnings and popular items
• Manage your menu and business hours
• Connect with nearby customers automatically

Whether you're hunting for the perfect taco truck or running a mobile coffee cart, WYA connects you in real-time.

Currently serving Santa Barbara, CA`,
  keywords: 'food truck,vendor,local,pop-up,farmers market,Santa Barbara,live map,GPS,mobile vendor,near me',
  privacyPolicyUrl: 'https://wya.digisigns.link/privacy',
  supportUrl: 'https://wya.digisigns.link/support',
  marketingUrl: 'https://wya.digisigns.link'
};

function generateToken() {
  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1'
  }, privateKey, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: KEY_ID, typ: 'JWT' }
  });
}

function apiRequest(token, method, path, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.appstoreconnect.apple.com',
      port: 443,
      path: `/v1${path}`,
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function main() {
  console.log('WYA App Store Metadata Filler\n');
  const token = generateToken();
  
  console.log('Finding WYA app...');
  const apps = await apiRequest(token, 'GET', '/apps?filter[bundleId]=com.universoul.wya');
  
  if (!apps.data.data?.length) {
    console.error('ERROR: WYA app not found. Create app entry first.');
    process.exit(1);
  }
  
  const appId = apps.data.data[0].id;
  console.log(`Found: ${apps.data.data[0].attributes.name} (${appId})\n`);
  
  // Update app info
  const infos = await apiRequest(token, 'GET', `/apps/${appId}/appInfos`);
  if (infos.data.data?.length) {
    const appInfoId = infos.data.data[0].id;
    const locs = await apiRequest(token, 'GET', `/appInfos/${appInfoId}/appInfoLocalizations`);
    const enUs = locs.data.data?.find(l => l.attributes.locale === 'en-US');
    
    if (enUs) {
      console.log('Updating app info...');
      const r = await apiRequest(token, 'PATCH', `/appInfoLocalizations/${enUs.id}`, {
        data: {
          type: 'appInfoLocalizations', id: enUs.id,
          attributes: {
            name: APP_METADATA.name,
            subtitle: APP_METADATA.subtitle,
            privacyPolicyUrl: APP_METADATA.privacyPolicyUrl
          }
        }
      });
      console.log('App info:', r.status === 200 ? 'SUCCESS' : r.status);
    }
  }
  
  // Update version
  const vers = await apiRequest(token, 'GET', `/apps/${appId}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION`);
  if (vers.data.data?.length) {
    const verId = vers.data.data[0].id;
    const vLocs = await apiRequest(token, 'GET', `/appStoreVersions/${verId}/appStoreVersionLocalizations`);
    const enUsV = vLocs.data.data?.find(l => l.attributes.locale === 'en-US');
    
    if (enUsV) {
      console.log('Updating version metadata...');
      const r = await apiRequest(token, 'PATCH', `/appStoreVersionLocalizations/${enUsV.id}`, {
        data: {
          type: 'appStoreVersionLocalizations', id: enUsV.id,
          attributes: {
            description: APP_METADATA.description,
            keywords: APP_METADATA.keywords,
            marketingUrl: APP_METADATA.marketingUrl,
            supportUrl: APP_METADATA.supportUrl
          }
        }
      });
      console.log('Version metadata:', r.status === 200 ? 'SUCCESS' : r.status);
    }
  }
  
  console.log('\nDone! Next: upload screenshots.');
}

main().catch(console.error);
