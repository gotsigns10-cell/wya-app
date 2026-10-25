#!/usr/bin/env node
/**
 * WYA E2E Regression Test — runs on ProBook via Playwright
 * Tests: landing page, customer app, vendor login page, API endpoints
 * Exit 0 = all pass, Exit 1 = failures
 */
const { chromium } = require('playwright');

const BASE = 'https://wya.digisigns.link';
const API = 'https://wya.digisigns.link';
const results = [];

function log(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ': ' + detail : ''}`);
}

async function testPage(browser, url, name, checks) {
  const page = await browser.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!resp || resp.status() >= 400) {
      log(name, false, `HTTP ${resp ? resp.status() : 'no response'}`);
      return;
    }
    log(`${name} loads`, true, `HTTP ${resp.status()}`);
    if (checks) await checks(page);
  } catch (e) {
    log(name, false, e.message.slice(0, 120));
  } finally {
    await page.close();
  }
}

async function testAPI(url, name, validate) {
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (validate) {
      validate(resp, data);
    } else {
      log(name, resp.ok, `HTTP ${resp.status}`);
    }
  } catch (e) {
    log(name, false, e.message.slice(0, 120));
  }
}

(async () => {
  console.log(`\n=== WYA E2E Regression — ${new Date().toISOString()} ===\n`);

  // API tests
  await testAPI(`${API}/api/vendors/live`, 'API /vendors/live', (resp, data) => {
    log('API /vendors/live', data.ok && typeof data.count === 'number', `${data.count} vendors`);
  });

  await testAPI(`${API}/api/categories`, 'API /categories', (resp, data) => {
    const cats = data.categories ? Object.keys(data.categories) : [];
    log('API /categories', resp.ok && cats.length > 0, `${cats.length} categories`);
  });

  // NaN guard test
  try {
    const resp = await fetch(`${API}/api/vendors/TORTAS-ERIKA-001/delivery-check?lat=NaN&lng=NaN`);
    const data = await resp.json();
    // Should get 400 or non-deliverable (not a server error)
    log('NaN lat/lng guard', resp.status < 500, `HTTP ${resp.status}`);
  } catch (e) {
    log('NaN lat/lng guard', false, e.message.slice(0, 120));
  }

  // Browser tests
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  await testPage(browser, `${BASE}/`, 'Landing page', async (page) => {
    const title = await page.title();
    log('Landing has title', title.length > 0, title.slice(0, 60));
  });

  await testPage(browser, `${BASE}/customer`, 'Customer app', async (page) => {
    // Wait for map or vendor list
    try {
      await page.waitForSelector('#map, .vendor-card, #live-n', { timeout: 10000 });
      log('Customer map/vendors render', true);
    } catch {
      log('Customer map/vendors render', false, 'timeout');
    }
  });

  await testPage(browser, `${BASE}/vendor`, 'Vendor login page', async (page) => {
    try {
      await page.waitForSelector('#i-email, input[type="email"]', { timeout: 8000 });
      log('Vendor login form renders', true);
    } catch {
      log('Vendor login form renders', false, 'no email input found');
    }
  });

  // Checkout URL validation test — verify our hardening
  await testPage(browser, `${BASE}/customer`, 'Checkout URL guard', async (page) => {
    const hasGuard = await page.evaluate(() => {
      return typeof imgFallback === 'function';
    });
    log('imgFallback XSS guard exists', hasGuard);
  });

  await browser.close();

  // Summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n=== RESULTS: ${passed} PASS, ${failed} FAIL out of ${results.length} ===\n`);

  if (failed > 0) {
    console.log('FAILURES:');
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}: ${r.detail || 'no detail'}`));
  }

  process.exit(failed > 0 ? 1 : 0);
})();
