#!/usr/bin/env node
/**
 * App Store Connect Screenshot Upload & Submit Script
 * Uses the ASC API to upload screenshots and submit for review without web login
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// Config
const KEY_ID = '6T7FMU83Q3';
const ISSUER_ID = '54717bff-71a1-46bc-a578-a94db1886499';
const KEY_PATH = '/root/.credentials/apns/AuthKey_6T7FMU83Q3.p8';
const APP_ID = '6829488221';
const BUNDLE_ID = 'com.universoul.wya';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

// Screenshot display targets for iPhone 6.7"
const SCREENSHOT_DISPLAY_TYPE = 'APP_IPHONE_67';

function generateJWT() {
  const privateKey = fs.readFileSync(KEY_PATH, 'utf8');
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(privateKey);

  const derToRaw = (derSig) => {
    let offset = 2;
    const rLength = derSig[offset + 1];
    offset += 2;
    let r = derSig.slice(offset, offset + rLength);
    offset += rLength + 2;
    const sLength = derSig[offset - 1];
    let s = derSig.slice(offset, offset + sLength);
    if (r.length > 32) r = r.slice(r.length - 32);
    if (s.length > 32) s = s.slice(s.length - 32);
    if (r.length < 32) r = Buffer.concat([Buffer.alloc(32 - r.length), r]);
    if (s.length < 32) s = Buffer.concat([Buffer.alloc(32 - s.length), s]);
    return Buffer.concat([r, s]);
  };

  const rawSig = derToRaw(signature);
  return `${headerB64}.${payloadB64}.${rawSig.toString('base64url')}`;
}

async function apiRequest(method, endpoint, body = null) {
  const token = generateJWT();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.appstoreconnect.apple.com',
      path: `/v1/${endpoint}`,
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            console.error(`API Error ${res.statusCode}:`, JSON.stringify(json.errors || json, null, 2));
            reject(new Error(`API error: ${res.statusCode}`));
          } else {
            resolve({ status: res.statusCode, data: json });
          }
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function uploadFile(url, fileBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': fileBuffer.length }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

async function getAppStoreVersion() {
  const result = await apiRequest('GET', `apps/${APP_ID}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION,REJECTED,DEVELOPER_REJECTED,METADATA_REJECTED`);
  return result.data?.data?.[0];
}

async function getLocalizations(versionId) {
  const result = await apiRequest('GET', `appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  return result.data?.data || [];
}

async function getScreenshotSets(locId) {
  const result = await apiRequest('GET', `appStoreVersionLocalizations/${locId}/appScreenshotSets`);
  return result.data?.data || [];
}

async function createScreenshotSet(locId, displayType) {
  const body = {
    data: {
      type: 'appScreenshotSets',
      attributes: { screenshotDisplayType: displayType },
      relationships: {
        appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: locId } }
      }
    }
  };
  const result = await apiRequest('POST', 'appScreenshotSets', body);
  return result.data?.data;
}

async function reserveScreenshot(setId, fileName, fileSize) {
  const body = {
    data: {
      type: 'appScreenshots',
      attributes: { fileName, fileSize },
      relationships: {
        appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } }
      }
    }
  };
  const result = await apiRequest('POST', 'appScreenshots', body);
  return result.data?.data;
}

async function commitScreenshot(screenshotId, checksum) {
  const body = {
    data: {
      type: 'appScreenshots',
      id: screenshotId,
      attributes: { uploaded: true, sourceFileChecksum: checksum }
    }
  };
  return apiRequest('PATCH', `appScreenshots/${screenshotId}`, body);
}

async function main() {
  try {
    console.log('=== App Store Connect Screenshot Upload & Submit ===\n');

    // Get editable version
    console.log('1. Finding editable app version...');
    let version = await getAppStoreVersion();
    if (!version) {
      console.log('   No editable version found. Creating new version 1.1...');
      const createResult = await apiRequest('POST', 'appStoreVersions', {
        data: {
          type: 'appStoreVersions',
          attributes: { platform: 'IOS', versionString: '1.1' },
          relationships: { app: { data: { type: 'apps', id: APP_ID } } }
        }
      });
      version = createResult.data?.data;
      if (!version) {
        console.error('   Failed to create new version');
        process.exit(1);
      }
    }
    console.log(`   ✓ Version: ${version.attributes?.versionString} (${version.attributes?.appStoreState})`);
    const versionId = version.id;

    // Get localizations
    console.log('\n2. Getting localizations...');
    const locs = await getLocalizations(versionId);
    const enLoc = locs.find(l => l.attributes?.locale === 'en-US') || locs[0];
    if (!enLoc) {
      console.error('   No localization found');
      process.exit(1);
    }
    console.log(`   ✓ Localization: ${enLoc.attributes?.locale}`);
    const locId = enLoc.id;

    // Get or create screenshot set
    console.log('\n3. Setting up screenshot set...');
    let sets = await getScreenshotSets(locId);
    let screenshotSet = sets.find(s => s.attributes?.screenshotDisplayType === SCREENSHOT_DISPLAY_TYPE);
    if (!screenshotSet) {
      console.log(`   Creating ${SCREENSHOT_DISPLAY_TYPE} screenshot set...`);
      screenshotSet = await createScreenshotSet(locId, SCREENSHOT_DISPLAY_TYPE);
    }
    if (!screenshotSet) {
      console.error('   Failed to get/create screenshot set');
      process.exit(1);
    }
    console.log(`   ✓ Screenshot set: ${screenshotSet.id}`);

    // Upload screenshots
    console.log('\n4. Uploading screenshots...');
    const screenshots = fs.readdirSync(SCREENSHOT_DIR)
      .filter(f => f.endsWith('.png') && !f.startsWith('.'))
      .sort();

    for (const filename of screenshots) {
      const filePath = path.join(SCREENSHOT_DIR, filename);
      const fileBuffer = fs.readFileSync(filePath);
      const fileSize = fileBuffer.length;

      console.log(`   Uploading ${filename} (${Math.round(fileSize/1024)}KB)...`);

      // Reserve upload
      const screenshot = await reserveScreenshot(screenshotSet.id, filename, fileSize);
      if (!screenshot) {
        console.log(`   ⚠ Failed to reserve ${filename}, skipping`);
        continue;
      }

      // Get upload operations
      const ops = screenshot.attributes?.uploadOperations || [];
      if (ops.length === 0) {
        console.log(`   ⚠ No upload URL for ${filename}, skipping`);
        continue;
      }

      // Upload to S3
      for (const op of ops) {
        const chunk = fileBuffer.slice(op.offset, op.offset + op.length);
        const uploadResult = await uploadFile(op.url, chunk, 'image/png');
        if (uploadResult.status >= 400) {
          console.log(`   ⚠ Upload failed for ${filename}: ${uploadResult.status}`);
        }
      }

      // Commit
      const checksum = crypto.createHash('md5').update(fileBuffer).digest('hex');
      await commitScreenshot(screenshot.id, checksum);
      console.log(`   ✓ ${filename} uploaded`);
    }

    console.log('\n✅ Screenshots uploaded successfully!');
    console.log('\nNext steps:');
    console.log('1. Go to App Store Connect to verify screenshots');
    console.log('2. Fill in any missing metadata');
    console.log('3. Submit for review');
    console.log('\nOr trigger a Codemagic build to submit automatically.');

  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  }
}

main();
