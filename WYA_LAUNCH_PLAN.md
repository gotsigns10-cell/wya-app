# WYA Launch Plan — Unified Action Document
## Created: 2026-10-23 | Target: App Store in 2-3 weeks

---

## Executive Summary

**WYA = "Where You At"** — Real-time food vendor discovery app for Santa Barbara.

**Current Reality:**
- Features: 88-93% complete (270+ endpoints, 44 tables)
- GPS tracking: Implemented but NEVER tested live
- Real usage: **ZERO** (0 orders, 0 real GPS pushes)
- iOS project: Structure ready, needs Mac build

**Blocking Issues:**
1. No human has ever gone live as a vendor with GPS tracking
2. Design is "cluttered and cartoony" (needs refresh)
3. Apple Developer enrollment not started ($99/year)

---

## Three Parallel Workstreams

### Workstream 1: E2E Human Testing (BLOCKING)
**Status:** NOT STARTED
**Guide:** `/wya-app/E2E_TEST_GUIDE.md`

Tests Required:
1. Vendor registration + profile setup
2. Go Live with GPS (verify 15s pushes)
3. Customer order flow with Stripe payment
4. Cross-device GPS tracking verification

**Who:** Sergio as founding vendor
**Time:** 2-3 hours total
**Must pass before:** Design refresh or App Store submission

---

### Workstream 2: Design Refresh
**Status:** Brief created
**Brief:** `/wya-app/DESIGN_BRIEF.md`

Issues to Fix:
| Issue | Count | Target |
|-------|-------|--------|
| Emojis | 79 | 0 (SVG icons) |
| Gradients | 31 | 3-4 |
| Border-radius variants | 18 | 4 |
| Keyframe animations | 21 | 5-6 |
| Visible tabs (vendor) | 13 | 5 + overflow |

**Who:** Internal design work (Claude or designer)
**Time:** 3-5 days
**Deliverables:** Token system, icon set, component redesigns

---

### Workstream 3: App Store Deployment
**Status:** iOS project ready, awaiting enrollment
**Checklist:** `/wya-proxy/APP_STORE_CHECKLIST.md`

Already Complete:
- [x] iOS project structure (`/wya-ios/`)
- [x] App icon (1024x1024)
- [x] App Store metadata
- [x] Legal docs (Privacy, Terms, EULA)
- [x] Stripe integration (3 tiers)

Not Started:
- [ ] Apple Developer enrollment ($99/year)
- [ ] Screenshots (specs ready, need to generate)
- [ ] TestFlight build
- [ ] App Store submission

**Who:** Sergio (enrollment), Claude (technical setup)
**Time:** 7-10 days after enrollment
**Budget:** $99 (Apple) + $25 (Google Play) = $124

---

## Immediate Actions (Today)

### For Sergio (User)
1. **Apple Developer Enrollment**
   - Go to https://developer.apple.com/enroll/
   - Sign in with Apple ID
   - Pay $99/year
   - Takes 24-48 hours for approval

2. **E2E Testing Session**
   - Open https://wya.digisigns.link/vendor on mobile
   - Follow `/wya-app/E2E_TEST_GUIDE.md`
   - Document any failures

### For Claude (System)
1. [x] Created E2E_TEST_GUIDE.md
2. [x] Created DESIGN_BRIEF.md
3. [x] Updated APP_STORE_CHECKLIST.md
4. [ ] Can assist with design refresh when ready
5. [ ] Can generate screenshots via VNC when design is final

---

## Verification Commands

```bash
# Check GPS pushes in last hour
sqlite3 /root/universoul-ecosystem/wya-app/data/wya.db \
  "SELECT COUNT(*) FROM activity_log WHERE action='location_update' AND created_at > datetime('now', '-1 hour');"

# Check for real orders
sqlite3 /root/universoul-ecosystem/wya-app/data/wya.db \
  "SELECT COUNT(*) FROM orders WHERE created_at > datetime('now', '-7 days');"

# Check live vendors with GPS
curl -s http://localhost:3422/api/vendors/live | jq '.vendors[] | {name, last_seen}'
```

---

## Success Criteria

| Milestone | Target Date | Verification |
|-----------|-------------|--------------|
| E2E tests pass | Day 1-2 | Database has real GPS + order data |
| Design refresh complete | Day 5-7 | VNC visual audit passes |
| TestFlight build | Day 8-10 | Install works on real iPhone |
| App Store live | Day 14-17 | App searchable in App Store |

---

## Revenue Model

Already built (Stripe live):
- Growth: $29.99/mo
- Pro: $49.99/mo
- Enterprise: $99.99/mo

Gap is **activation** not features:
1. Real vendors must go live
2. Real customers must order
3. App Store presence drives discovery

**Strategy:** Sergio as founding vendor, verify full flow, then onboard 5 local SB vendors.

---

## Files Created This Session

1. `/wya-app/E2E_TEST_GUIDE.md` — Human testing checklist
2. `/wya-app/DESIGN_BRIEF.md` — Design refresh specifications
3. `/wya-app/WYA_LAUNCH_PLAN.md` — This unified plan
4. Updated `/wya-proxy/APP_STORE_CHECKLIST.md` — Added blockers section
