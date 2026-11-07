/**
 * WYA App Store Screenshot Generator
 * Generates iPhone 6.7" (1290 x 2796) screenshots for App Store submission
 */
const { chromium } = require('playwright');
const path = require('path');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const BASE_URL = 'http://localhost:3422';

// iPhone 15 Pro Max dimensions (6.7")
const VIEWPORT = { width: 430, height: 932 };
const DEVICE_SCALE = 3; // 3x for retina = 1290 x 2796

async function generateScreenshots() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  });

  const page = await context.newPage();

  try {
    // 1. Customer map view with vendor pins
    console.log('1. Capturing customer map view...');
    await page.goto(`${BASE_URL}/map`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000); // Wait for map to render
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-map-view.png`,
      fullPage: false
    });
    console.log('   ✓ Map view saved');

    // 2. Vendor card detail view
    console.log('2. Capturing vendor detail...');
    await page.goto(`${BASE_URL}/v/WHITECAPS-001`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-vendor-detail.png`,
      fullPage: false
    });
    console.log('   ✓ Vendor detail saved');

    // 3. App landing/home screen
    console.log('3. Capturing home screen...');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-home.png`,
      fullPage: false
    });
    console.log('   ✓ Home screen saved');

    // 4. Vendor list view
    console.log('4. Capturing vendor list...');
    await page.goto(`${BASE_URL}/vendors`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-vendor-list.png`,
      fullPage: false
    });
    console.log('   ✓ Vendor list saved');

    // 5. Vendor dashboard
    console.log('5. Capturing vendor dashboard...');
    await page.goto(`${BASE_URL}/vendor`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-vendor-dashboard.png`,
      fullPage: false
    });
    console.log('   ✓ Vendor dashboard saved');

    console.log('\n✓ All screenshots generated in:', SCREENSHOT_DIR);

  } catch (error) {
    console.error('Screenshot error:', error.message);
  } finally {
    await browser.close();
  }
}

generateScreenshots().catch(console.error);
