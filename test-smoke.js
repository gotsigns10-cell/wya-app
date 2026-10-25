#!/usr/bin/env node
/**
 * WYA Smoke Tests — runs against the live local service
 * Tests core API endpoints without requiring Stripe or auth tokens
 * Usage: node test-smoke.js
 */

const BASE = process.env.WYA_BASE || 'http://localhost:3422';
let pass = 0, fail = 0;

function log(name, ok, detail) {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}

async function test(name, url, validate) {
  try {
    const resp = await fetch(`${BASE}${url}`);
    const body = await resp.text();
    let data;
    try { data = JSON.parse(body); } catch { data = body; }
    validate(resp, data);
  } catch (e) {
    log(name, false, e.message);
  }
}

async function testPost(name, url, body, validate) {
  try {
    const resp = await fetch(`${BASE}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    validate(resp, data);
  } catch (e) {
    log(name, false, e.message);
  }
}

(async () => {
  console.log(`\n=== WYA Smoke Tests — ${new Date().toISOString()} ===`);
  console.log(`Base: ${BASE}\n`);

  // 1. Health / status
  await test('Health endpoint', '/health', (resp, data) => {
    log('Health endpoint', resp.status === 200 && data.status === 'ok', `status=${data.status}, live=${data.vendors_live}`);
  });

  // 2. Vendor discovery — live vendors list
  await test('Vendors live', '/api/vendors/live', (resp, data) => {
    log('Vendors live', data.ok && typeof data.count === 'number', `${data.count} vendors`);
  });

  // 3. Categories
  await test('Categories', '/api/vendors/categories', (resp, data) => {
    const cats = data.categories ? Object.keys(data.categories) : [];
    log('Categories', resp.ok && cats.length >= 0, `${cats.length} categories`);
  });

  // 4. Stats
  await test('Stats', '/api/vendors/stats', (resp, data) => {
    log('Stats', resp.ok && typeof data.total_vendors === 'number', `total=${data.total_vendors}, live=${data.live_now}`);
  });

  // 5. Subscription tiers
  await test('Subscription tiers', '/api/subscription/tiers', (resp, data) => {
    const hasFree = data.tiers?.some(t => t.id === 'free');
    const hasPro = data.tiers?.some(t => t.id === 'pro');
    log('Subscription tiers', hasFree && hasPro, `${data.tiers?.length || 0} tiers`);
  });

  // 6. Nearby vendors (distance filtering)
  await test('Nearby vendors (SB coords)', '/api/customer/nearby-vendors?lat=34.4208&lng=-119.6982&radius=25', (resp, data) => {
    log('Nearby vendors', data.ok && Array.isArray(data.vendors), `${data.vendors?.length || 0} within 25mi of SB`);
  });

  // 7. Catering vendors list
  await test('Catering vendors', '/api/vendors/catering', (resp, data) => {
    log('Catering vendors', data.ok && Array.isArray(data.vendors), `${data.count} vendors accept catering`);
  });

  // 8. Catering request submission (to first vendor)
  await test('Get vendor list for catering test', '/api/vendors/live', async (resp, data) => {
    if (!data.ok || !data.vendors?.length) {
      log('Catering request', false, 'No vendors to test with');
      return;
    }
    const vendorId = data.vendors[0].id;
    await testPost('Catering request submission', `/api/vendors/${vendorId}/catering-request`, {
      name: 'Smoke Test',
      email: 'smoke-test@example.com',
      event_date: '2026-12-31',
      guest_count: 50,
      budget_range: '$500-$1000',
      event_type: 'corporate',
      message: 'Smoke test — please ignore'
    }, (resp, data) => {
      log('Catering request submission', data.ok && data.request_id, `request_id=${data.request_id}`);
    });
  });

  // 9. Catering request validation (missing fields)
  await testPost('Catering request validation', '/api/vendors/NONEXISTENT/catering-request', {
    name: 'Test',
    email: 'test@example.com',
    event_date: '2026-12-31'
  }, (resp, data) => {
    log('Catering request validation (404)', resp.status === 404, data.error);
  });

  await testPost('Catering request validation (missing email)', '/api/vendors/NONEXISTENT/catering-request', {
    name: 'Test',
    event_date: '2026-12-31'
  }, (resp, data) => {
    log('Catering request validation (400)', resp.status === 400, data.error);
  });

  // 10. Customer feed (with SB coords)
  await test('Customer feed', '/api/customer/feed?lat=34.4208&lng=-119.6982', (resp, data) => {
    log('Customer feed', data.ok || resp.status === 200, `sections: ${Object.keys(data).filter(k => k !== 'ok').length}`);
  });

  // 11. Events list
  await test('Events list', '/api/events', (resp, data) => {
    log('Events list', resp.ok, `${Array.isArray(data.events) ? data.events.length : '?'} events`);
  });

  // 12. Vendor register validation (should reject bad input)
  await testPost('Register validation', '/api/vendor/register', {
    name: '',
    email: 'not-an-email',
    password: '123'
  }, (resp, data) => {
    log('Register validation rejects bad input', resp.status >= 400, data.error || 'rejected');
  });

  // 13. Customer register validation
  await testPost('Customer register validation', '/api/customer/register', {
    name: '',
    email: 'bad',
    password: '1'
  }, (resp, data) => {
    log('Customer register validation', resp.status >= 400, data.error || 'rejected');
  });

  // 14. Auth endpoints reject unauthenticated
  await test('Vendor /me rejects no auth', '/api/vendor/me', (resp, data) => {
    log('Vendor /me rejects no auth', resp.status === 401, data.error);
  });

  // 15. Order without auth or items
  await testPost('Order validation', '/api/orders', {}, (resp, data) => {
    log('Order validation rejects empty', resp.status >= 400, data.error || 'rejected');
  });

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(fail > 0 ? 1 : 0);
})();
