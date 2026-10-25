# WYA E2E Human Testing Guide
## Status: BLOCKING — Must pass before App Store submission
## Created: 2026-10-23

---

## Pre-Test Verification

```bash
# Check services are online
pm2 list | grep wya

# Check live vendors endpoint
curl -s http://localhost:3422/api/vendors/live | jq '.count, .vendors[].last_seen'

# Expected: count: 2, last_seen: null (no real GPS data yet)
```

---

## Phase A: Vendor Flow (Test with Sergio as founding vendor)

### A1. Vendor Registration
1. Open https://wya.digisigns.link/vendor
2. Click "Get Started" / Register
3. Fill in business details:
   - Name: "Test Food Truck"
   - Category: food_truck
   - Description: Test vendor
4. Complete registration
5. **Checkpoint**: Can access vendor dashboard

### A2. Profile Setup
1. Add business hours
2. Upload profile photo
3. Add 3+ menu items with prices
4. **Checkpoint**: Profile marked as "complete" in dashboard

### A3. GPS Live Tracking (CRITICAL)
1. On mobile device, open vendor dashboard
2. Enable location permission when prompted
3. Click "Go Live" button
4. Wait 15-30 seconds
5. **Checkpoint**: See "GPS Live" indicator
6. **Verify in database**:
```bash
sqlite3 /root/universoul-ecosystem/wya-app/data/wya.db \
  "SELECT id, name, lat, lng, last_seen, is_open FROM vendors WHERE last_seen IS NOT NULL;"
```

### A4. Movement Test
1. While live, physically move 20-50 feet
2. Wait 15-30 seconds for next GPS push
3. **Checkpoint**: Coordinates updated in database

---

## Phase B: Customer Flow

### B1. Customer Registration
1. Open https://wya.digisigns.link (customer site)
2. Create account with email
3. **Checkpoint**: Can access customer dashboard

### B2. Find Vendor on Map
1. Allow location permission
2. View map centered on current location
3. See vendor markers on map
4. **Checkpoint**: Live vendor (from Phase A) appears on map with pin

### B3. Menu & Cart
1. Click on vendor marker
2. View vendor profile + menu
3. Add 2-3 items to cart
4. **Checkpoint**: Cart shows correct items and total

### B4. Order & Payment
1. Proceed to checkout
2. Enter delivery/pickup details
3. Complete Stripe payment
4. **Checkpoint**: Order confirmation received

### B5. Order Status
1. View order in "My Orders"
2. See real-time status updates
3. **Checkpoint**: Status changes (pending -> confirmed -> preparing)

---

## Phase C: Cross-Verify GPS

### Setup
- Mobile: Open vendor dashboard on phone (ProBook 100.95.83.27 VNC or real phone)
- Desktop: Open customer map at https://wya.digisigns.link

### C1. Go Live Test
1. [Mobile] Go live as vendor
2. [Desktop] Refresh map
3. **Checkpoint**: Vendor appears on map within 15 seconds

### C2. Movement Tracking
1. [Mobile] Walk/drive while live
2. [Desktop] Watch vendor marker
3. **Checkpoint**: Pin moves as device moves

### C3. Go Offline Test
1. [Mobile] Click "Go Offline"
2. [Desktop] Refresh map
3. **Checkpoint**: Vendor disappears from live list (or shows as offline)

---

## Success Criteria Checklist

| Test | Status |
|------|--------|
| Vendor registration completes | [ ] |
| Menu items added successfully | [ ] |
| GPS pushes location every 15s | [ ] |
| last_seen timestamp updates | [ ] |
| Customer sees vendor on map | [ ] |
| Order placement with Stripe succeeds | [ ] |
| Order status updates propagate | [ ] |
| Vendor pin moves when device moves | [ ] |
| Vendor disappears when offline | [ ] |

---

## Verification Queries

```bash
# Check for real GPS data
sqlite3 /root/universoul-ecosystem/wya-app/data/wya.db \
  "SELECT COUNT(*) as updates FROM activity_log WHERE action='location_update' AND created_at > datetime('now', '-1 hour');"

# Check orders
sqlite3 /root/universoul-ecosystem/wya-app/data/wya.db \
  "SELECT COUNT(*) as orders_today FROM orders WHERE created_at > datetime('now', '-24 hours');"

# Check live vendors with timestamps
curl -s http://localhost:3422/api/vendors/live | jq '.vendors[] | {name, last_seen, lat, lng}'
```

---

## Post-Test Actions

If ALL tests pass:
1. Update APP_STORE_CHECKLIST.md
2. Mark E2E testing as COMPLETE
3. Proceed to design refresh and App Store submission

If ANY test fails:
1. Document failure in TASK_BOARD.md
2. Fix before proceeding
3. Re-run failed test

---

## Notes

- Use real devices for GPS testing (simulators may not push accurate location)
- Stripe is in LIVE mode — use real card or Sergio's test Stripe dashboard
- All test data can be cleaned up after: `DELETE FROM orders WHERE vendor_id='TEST-VENDOR-001'`
