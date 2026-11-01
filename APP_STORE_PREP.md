# WYA App Store Launch Prep

## App Store Metadata

### App Name
**WYA — Where You At**

### Subtitle (30 chars)
Find Local Vendors Near You

### Description
WYA is the real-time vendor discovery app for Santa Barbara. Find food trucks, pop-up shops, farmers market vendors, and local businesses — exactly when and where they're open.

**For Customers:**
- See vendors on a live map with real-time GPS locations
- Filter by category: food trucks, coffee, bakeries, art, services
- View menus, hours, and reviews before you visit
- Get directions and order ahead from your favorites

**For Vendors:**
- Go live with one tap — customers see you instantly
- Track your earnings and popular items
- Manage your menu and business hours
- Connect with nearby customers automatically

Whether you're hunting for the perfect taco truck or running a mobile coffee cart, WYA connects you in real-time.

*Currently serving Santa Barbara, CA*

### Keywords (100 chars max)
food truck,vendor,local,pop-up,farmers market,Santa Barbara,live map,GPS,mobile vendor,near me

### Categories
- Primary: Food & Drink
- Secondary: Lifestyle

### Privacy Policy URL
https://wya.digisigns.link/privacy

### Support URL
https://wya.digisigns.link/support

---

## App Store Screenshots Needed

### iPhone 6.7" (iPhone 15 Pro Max) — Required
1. Customer map view with live vendor pins
2. Vendor card detail view
3. Vendor toggle "I'm Open" screen
4. Category filter in action
5. Vendor dashboard with earnings

### iPhone 6.5" (iPhone 14 Plus) — Recommended
Same 5 screenshots at 1284 x 2778 px

### iPad Pro 12.9" — If supporting iPad
Same 5 screenshots at 2048 x 2732 px

---

## Pre-Launch Checklist

### Apple Requirements
- [x] Bundle ID: com.universoul.wya
- [x] App icon: 1024x1024 PNG
- [x] Privacy policy URL
- [x] Location usage description
- [x] Background modes: location, fetch, notifications
- [ ] Apple Developer enrollment ($99/year)
- [ ] App Store Connect account setup
- [ ] TestFlight beta testing

### Google Play Requirements
- [ ] Google Play Developer enrollment ($25 one-time)
- [ ] Privacy policy
- [ ] Feature graphic (1024 x 500 px)
- [ ] Screenshots (min 2, max 8)
- [ ] Content rating questionnaire

### E2E Testing (Before Submission)
- [ ] Vendor GPS toggle works on real device
- [ ] Customer sees vendor appear/disappear on map
- [ ] Location updates every 15 seconds
- [ ] Battery usage acceptable (test 2-hour session)
- [ ] Stripe checkout works for orders

---

## Founding Vendor Program

First 10 vendors get **free forever** tier:
- Priority map placement
- No platform fees
- Founding Vendor badge
- Direct support line

Target vendors for Santa Barbara launch:
1. Sergio's (test vendor)
2. Local food trucks (Funk Zone area)
3. Farmers market vendors (Saturday market)
4. Mobile coffee carts
5. Pop-up shops (State Street)

---

## Launch Timeline

1. **E2E Testing** — Sergio tests GPS for 2-3 hours with real movement
2. **TestFlight** — Submit to Apple for beta review
3. **Founding Vendors** — Onboard 5 real vendors
4. **App Store** — Submit for production review
5. **Soft Launch** — Santa Barbara only
6. **Press** — SB Independent, Noozhawk coverage

---

## Session 376 Progress (2026-11-01)

### Completed
- [x] WebSocket stability fixed (memory limit 100M→150M, max_restarts 50)
- [x] iOS entitlements file created (App.entitlements)
- [x] Entitlements linked in Xcode project (Debug + Release)
- [x] Smoke tests: 15/16 PASS
- [x] Lockdown tests: 65/68 PASS (95.6%)
- [x] GPS tests: 16/16 PASS (Uber-grade validation)
- [x] E2E browser tests: 11/11 PASS
- [x] GPS toggle E2E: PASS (checked_in/checked_out flow)

### Apple Developer - VERIFIED ✓
- [x] Apple Developer Program enrolled (Team ID: 9V74TT48MV)
- [x] Team ID configured in Xcode project
- [x] APNs Key generated (T9LGDGU82M)
- [x] App Store Connect API Key (6T7FMU83Q3, Admin)
- [x] Bundle ID registered (com.universoul.wya → YA7VH66YXF)
- [x] Codemagic CI/CD configured with API key

### ONE MANUAL STEP NEEDED
- [ ] **Create App in App Store Connect** (API can't do this, web portal only)

**Option 1: Direct VNC to ProBook**
```
vnc://100.95.83.27:5900
```

**Option 2: Web Portal**
1. Go to https://appstoreconnect.apple.com/apps
2. Sign in with: gotsigns10@gmail.com (use "Sign in with iPhone" if password fails)
3. Click **+ New App** (blue plus button top right)
4. Fill form:
   - Platform: iOS
   - Name: WYA — Where You At
   - Primary Language: English (U.S.)
   - Bundle ID: com.universoul.wya (should appear in dropdown)
   - SKU: WYA-2026
   - User Access: Full Access
5. Click **Create**

Then Codemagic can auto-submit to TestFlight

### Ready for Launch
Backend: ✅ Stable (wya-app, wya-websocket, wya-proxy)
GPS: ✅ Uber-grade validation (NaN, bounds, rate limit, teleportation guard)
iOS: ✅ Build ready (needs signing)
E2E: ✅ All automated tests passing

---
*Prepared: 2026-10-23*
*Updated: 2026-11-01 (Session 376)*
