# Project Research Summary

**Project:** WYA — Venue/Organizer Role, Booking Marketplace, Outbox Hardening
**Domain:** Brownfield hyperlocal vendor marketplace expansion (food trucks, pop-ups, mobile vendors)
**Researched:** 2026-07-31
**Confidence:** HIGH

## Executive Summary

WYA is a brownfield Express.js + SQLite marketplace (10,279 lines, 44 tables, 270+ endpoints) that already has vendor and customer roles, Stripe Connect, push notifications, and a working outbox pattern. This milestone adds a third role (venue/organizer accounts), a complete booking transaction chain with deposit hold and deferred vendor payout, and hardens the existing outbox for financial reliability. The competitive field (StreetFoodFinder, Roaming Hunger, Best Food Trucks, Vamo Host) shows that successful food-truck marketplaces require supply-first launch sequencing, a working deposit-escrow-payout chain, and explicit dispute handling — all of which are buildable on the existing stack with zero new services.

The recommended approach is additive and strictly brownfield: one new npm package (node-cron), three new database tables (organizers/organizer_sessions, marketplace_transactions, booking_state_log), schema migrations to two existing tables, and a refactored outbox with idempotency keys and atomic enqueue. The entire booking state machine is a single synchronous SQLite transaction function. No new PM2 services, no Redis, no ORMs — all changes go into the existing wya-app process at port 3422 in compliance with the ARCH FREEZE constraint.

The primary risk is financial data integrity: the outbox lives in a separate SQLite file from the business database, which means a process crash between a deposit capture and the outbox enqueue produces silent revenue leakage. This must be addressed first, before any Stripe deposit flows are activated. The secondary risk is marketplace cold start failure — venues must not be invited until at least 5 Stripe-Connect-onboarded vendors cover 3+ cuisine categories in Santa Barbara. The managed catering desk model (Sergio manually matches vendors for the first 30-60 days) is the correct hedge to achieve initial liquidity without premature automation.

---

## Key Findings

### Recommended Stack

The existing stack requires no structural changes. The only new package is `node-cron@^4.6.0` (zero dependencies, 7KB) for readable daily reconciliation crons. Everything else — bcrypt auth, better-sqlite3 transactions, Stripe Connect, web-push — is already installed and proven in the codebase. The organizer auth system is a direct copy of the vendor auth pattern (same session table shape, same `getByToken()` helper, same bcrypt version).

For Stripe, the existing destination-charge model (used for vendor orders) is intentionally NOT extended to venue deposits. Venue deposits require Separate Charges and Transfers: platform collects on its own account, holds funds, then transfers to vendor post-event minus a 10-15% platform fee. This allows refunds from the platform account without requiring a transfer reversal from the vendor's Connect balance. Stripe idempotency keys must be added to all Stripe mutating calls using the pattern `{action}-{bookingId}`.

**Core technologies:**
- `express@^4.22.2`: All new endpoints go into the existing single-process server at port 3422 — no new PM2 service
- `better-sqlite3@^12.10.0`: State machine transitions are synchronous SQLite transactions; WAL mode handles all expected concurrency
- `stripe@^22.1.1`: Separate Charges + Transfers for venue deposits; existing destination charges for vendor orders remain unchanged
- `node-cron@^4.6.0` (NEW): Daily reconciliation crons for dead-letter outbox and booking expiry — replaces 86400000ms setInterval magic numbers
- `web-push@^3.6.7`: Extend existing push subscription handler to accept `user_type='organizer'` for venue notifications
- `CustomerSync / Outbox (shared lib)`: Add `wya-organizer` as a third product instance alongside existing `wya` and `wya-vendor`

### Expected Features

See `/root/universoul-ecosystem/wya-app/.planning/research/FEATURES.md` for full feature table with complexity ratings and dependencies.

**Must have (table stakes):**
- Organizer role + account type with authenticated login (replaces the current anonymous `organizer_email` pattern)
- Location/spot management with address pins and capacity notes
- Vendor application intake with approve/decline and push notification
- Catering request broadcast to N qualified vendors (by cuisine, proximity, availability)
- Vendor proposal submission with structured fields
- Booking confirmation record (plain HTML, no PDF in v1)
- Deposit hold via Stripe Checkout — organizer pays deposit at booking confirmation
- Post-event vendor payout with 48-hour dispute window before automatic release
- Cancellation tiers: >30 days = full refund, 14-30 days = 50%, <14 days = no refund
- Booking status dashboards for both host and vendor

**Should have (competitive differentiators):**
- Booth/spot fee collection at application stage (organizer charges vendors; WYA holds until event)
- Platform dispute window with admin-mediated resolution
- No-show protection for host (full refund if vendor doesn't appear)
- SB compliance pre-check for organizer-published locations (4hr/500ft ordinance)
- Founding vendor designation (badge, permanent free tier, priority placement)
- Marketplace health email (weekly internal digest: match rate, fill rate, deposit volume)
- Liquidity dashboard (admin-only: match rate, slot fill rate, open requests aging)

**Defer to later milestones:**
- Auto-fill suggestion from waitlist (needs cancellation history volume)
- Vendor density map (needs 30+ active vendors)
- Referral loop for organizer-referrals (requires ambassador system extension)
- AI-generated vendor recommendations (no booking history to train on at launch)
- Multi-organizer team accounts / staff roles (premature at SB scale)
- Consumer-facing launch before liquidity threshold (10 vendors, 2 organizers, 1 completed booking)

### Architecture Approach

All new code lives in the existing wya-app Express process. The component structure is additive: new tables are created in the existing `db.exec()` migration array, new routes are appended to the existing Express router, and the outbox is hardened in-place by adding an `enqueueAtomic()` method to `shared/outbox.js`. The booking state machine is implemented as a single `transitionBooking()` function that writes both the `marketplace_transactions` state update and a `booking_state_log` audit entry inside one better-sqlite3 transaction. Hub integration stays fire-and-forget (Hub is not in the critical payment path) but is extended to cover all transaction chain events.

See `/root/universoul-ecosystem/wya-app/.planning/research/ARCHITECTURE.md` for full schema DDL, state machine code pattern, build order, and data flow diagram.

**Major components:**
1. **Auth Layer** — New `organizers` + `organizer_sessions` tables; `requireOrganizer` middleware; distinct `x-organizer-token` header to prevent cross-role access
2. **Marketplace Transactions** — `marketplace_transactions` table as the authoritative state record; `booking_state_log` for audit trail; `transitionBooking()` helper enforces valid state transitions atomically
3. **Outbox (hardened)** — `enqueueAtomic()` method in `shared/outbox.js`; `idempotency_key` column with UNIQUE index; retention cleanup every 6h; dead-letter admin endpoints
4. **Stripe Deposit Flow** — Separate Charges + Transfers pattern for venue deposits only; `processed_stripe_events` deduplication table; idempotency keys on all mutations
5. **Hub Integration** — Extended `notifyHub()` function covering all booking state events; `GET /api/admin/marketplace/transactions` for Hub product health card
6. **Admin / Analytics** — `GET /api/admin/marketplace/metrics` for liquidity KPIs; managed catering desk endpoints; founding vendor tooling

### Critical Pitfalls

See `/root/universoul-ecosystem/wya-app/.planning/research/PITFALLS.md` for full analysis with code line references.

1. **Outbox lives in a separate DB from business data (C1)** — A crash between a deposit capture and the outbox enqueue produces silent revenue leakage with no alert. Prevention: add a startup + 15-minute reconciliation query that scans for paid orders/bookings with no matching outbox completion record, then re-enqueues. Build this before wiring any Stripe deposit flows.

2. **Cross-role token leakage on third auth role (C2)** — The 270 existing endpoints match on `x-auth-token` (vendor) or `x-cust-token` (customer). If organizer tokens share either header, venue users silently authenticate as vendors and access earnings dashboards or payout flows. Prevention: use a distinct `x-organizer-token` header and a separate `organizer_sessions` table. Write a smoke test before launch.

3. **Booking cancelled before deposit webhook fires (C3)** — The existing 24h order expiry cron can cancel a booking that has an open Stripe Checkout session. When the webhook fires, the deposit is captured but the booking is in `cancelled` state. Prevention: extend the expiry cron to skip bookings with an active `stripe_checkout_session_id`; webhook handler must verify booking status and immediately refund if cancelled.

4. **Destination charges break venue refund path (C4)** — The existing Stripe model uses destination charges (transfer at payment time). For multi-vendor deposits where a vendor may cancel after payment, reversing a destination charge requires funds to be in the vendor's Connect balance — which may be empty. Prevention: use Separate Charges and Transfers for all venue deposit flows. Do not change the existing order flow.

5. **Venue supply before vendor supply kills liquidity (M7)** — Recruiting venues before vendors creates unfillable events and kills early trust. Prevention: require 5 Stripe-Connect-onboarded vendors across 3+ cuisine categories before sending any venue invitation emails. Track `stripe_connect_onboarded=1` count daily as a launch gate.

---

## Implications for Roadmap

Based on combined research, the following phase structure is recommended. The order is dictated by financial risk (outbox must be safe before money flows), auth isolation (organizer identity must exist before any transaction can be owned), and the state machine backbone (transactions table must exist before Stripe is wired). Launch operations are last because they require all infrastructure to be validated first.

### Phase 1: Foundation — Outbox Hardening + Organizer Auth

**Rationale:** The outbox atomicity gap (C1) is a silent financial risk that affects every payment, not just the new venue deposits. Hardening it first means every subsequent Stripe integration is safe from day one. Organizer auth is the prerequisite for every other milestone feature — venue events, deposit flows, and Hub visibility all require an authenticated organizer identity. These two work together: the organizer registration itself needs the hardened outbox for reliable EMS sync.

**Delivers:** Production-grade event reliability; authenticated organizer role with registration, login, logout, and profile management; admin visibility into outbox health

**Addresses features from FEATURES.md:** Organizer role/account type (table stakes); organizer public profile; admin visibility

**Avoids pitfalls:** C1 (outbox atomicity), C2 (cross-role token leakage), M2 (password reset third role), M3 (anonymous organizer collision — define the sunset/upgrade path here), M4 (push subscriptions for organizers), M5 (outbox retention), N1 (admin venue visibility), N3 (founding venue protection column), N4 (session cleanup for organizer sessions)

**Research flag:** Standard patterns — mirrors existing vendor auth, no new research needed during planning

---

### Phase 2: Booking State Machine + Stripe Deposit Flow

**Rationale:** The `marketplace_transactions` table and `transitionBooking()` state machine are the backbone that Hub reads, EMS syncs against, and Stripe webhooks update. Building the backbone before wiring Stripe means every payment has a record from the first transaction. This phase is the highest-risk engineering work in the milestone — the Stripe Separate Charges + Transfers model diverges from the existing order flow and must be tested with Stripe CLI before any real money flows.

**Delivers:** Full booking state machine (initiated → vendor_applied → vendor_approved → deposit_pending → deposit_paid → confirmed → in_progress → completed); organizer deposit payment via Stripe Checkout; webhook handler extension with deduplication; `booking_state_log` audit trail; cancellation tiers with refund logic

**Addresses features from FEATURES.md:** Catering request deposit wiring; deposit hold (escrow-like); vendor application intake + approve/decline; booking confirmation record; final balance collection; post-event vendor payout; cancellation tiers

**Avoids pitfalls:** C3 (booking cancelled before webhook fires), C4 (destination charges for venue deposits), M1 (migration silent failures — use health assertion after schema changes)

**Research flag:** Needs focused pre-build review of Stripe Separate Charges + Transfers against the existing webhook handler (lines 8914+) to confirm no existing branch conflicts. Use `stripe listen --forward-to localhost:3422/api/stripe/webhook` during development.

---

### Phase 3: Venue Slot System + Vendor Matching

**Rationale:** With auth and money flows solid, the marketplace-side features can be built confidently. Venue location and slot management is the demand-generation engine. Vendor application intake and multi-vendor broadcast are the supply-side response. Together these create the first complete request-to-match cycle that the managed catering desk can observe and validate before automation.

**Delivers:** Location/spot management with named spots and address pins; recurring slot publishing; vendor application intake with cuisine/type filtering; host proposal review and accept; 48-hour dispute window; booking status dashboards for both host and vendor

**Addresses features from FEATURES.md:** Recurring slot publishing; vendor type/cuisine filtering for slots; duplicate prevention per slot; multi-vendor broadcast; vendor proposal submission; host proposal review + accept/counter; dispute window; platform dispute window; no-show protection framework

**Avoids pitfalls:** M8 (catering vs marketplace confusion — explicit copy and dashboard boundary), M6 (Hub transaction type differentiation)

**Research flag:** Standard patterns — slot management mirrors existing vendor schedule system. Dispute window logic is new but straightforward: a cron checks `completed_at + 48h` and triggers payout if no dispute flag.

---

### Phase 4: Hub Visibility + Marketplace Analytics

**Rationale:** The north star metric from PROJECT.md is "Hub records the full chain." This phase makes that verifiable. It also adds the instrumentation needed to measure whether the marketplace is achieving liquidity — without metrics, the managed catering desk is flying blind. Build this before launch operations so Sergio has data to act on.

**Delivers:** Enhanced `notifyHub()` covering all booking state events; `GET /api/admin/marketplace/transactions` transaction chain view; `GET /api/admin/marketplace/metrics` liquidity dashboard (match rate, fill rate, deposit volume, conversion rate); outbox-backed Hub notifications for financial events; marketplace health weekly email via Soul email infrastructure (port 3380)

**Addresses features from FEATURES.md:** Liquidity dashboard (admin); marketplace health email; booking status dashboard; vendor analytics extension; Hub WYA product health card

**Avoids pitfalls:** N5 (Hub fire-and-forget has no retry — route financial events through outbox-backed emsBillingRecord)

**Research flag:** Standard patterns — Hub notification pattern and EMS billing pattern both already exist in codebase. Extension is mechanical.

---

### Phase 5: Launch Operations + Marketplace Activation

**Rationale:** Last because it requires all infrastructure to be validated. Launch operations are primarily process, not code, but the tooling (founding vendor badges, managed catering desk admin endpoints, organizer outreach drip via n8n/EMS) enables Sergio to execute the supply-first activation strategy manually before automating anything.

**Delivers:** Founding vendor badge + permanent free tier flag; managed catering desk admin endpoints (`POST /api/admin/catering/:id/manage`); organizer anchor recruitment tooling; first-booking fee incentive for hosts; `POST /api/organizer/events/:id/complete` to trigger vendor payout; organizer outreach drip via n8n (not new wya-app code); SB compliance pre-check for organizer-published locations

**Addresses features from FEATURES.md:** Founding vendor designation; managed catering desk (process); organizer anchor seeding (process); first booking incentive; WYA Verified organizer badge; SB compliance pre-check

**Avoids pitfalls:** M7 (venue supply before vendor supply — enforce 5 Stripe-Connect-onboarded vendor gate before venue invites go out)

**Research flag:** Launch sequencing is well-documented from marketplace cold-start research (a16z, FORKOFF, Airdev). No deep research needed during planning — execution is the risk, not architecture.

---

### Phase Ordering Rationale

- **Outbox before Stripe:** The C1 pitfall (silent revenue leakage from split-DB outbox) affects all downstream payment flows. Fix once, protect everything.
- **Auth before transactions:** Every `marketplace_transactions` row requires an `organizer_id` FK. Organizer table must exist first.
- **State machine before Stripe webhook:** The webhook handler extension adds a new metadata branch to the existing handler. The `marketplace_transactions` table must exist for that branch to write to. Building in wrong order means a Stripe webhook fires with no record to update.
- **Analytics before launch:** Sergio needs data to act on. Building metrics before launch operations ensures the managed catering desk has visibility from the first real booking.
- **Launch operations last:** Cannot activate before infrastructure is validated with at least one test booking end-to-end.

### Research Flags

Phases likely needing deeper pre-build research during planning:
- **Phase 2 (Stripe deposit flow):** Review Stripe CLI test sequence for Separate Charges + Transfers against the existing webhook handler. Confirm idempotency key convention does not collide with existing `order-${orderId}` keys already in use at line 8950.

Phases with standard patterns (can skip `/gsd-research-phase` during planning):
- **Phase 1 (Outbox hardening + organizer auth):** Mirrors existing vendor auth pattern exactly. Outbox hardening pattern fully specified in ARCHITECTURE.md.
- **Phase 3 (Venue slot system):** Mirrors existing vendor schedule system. State machine function is fully specified.
- **Phase 4 (Hub visibility):** Hub notify pattern and EMS billing pattern exist — extension is mechanical.
- **Phase 5 (Launch operations):** Process-heavy, not architecture-heavy. Cold-start playbook is well-researched.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified against stripe-node source (Context7), npm registry, and existing codebase patterns. One new package (node-cron) confirmed at 4.6.0 with zero deps. |
| Features | HIGH | Cross-referenced against 6+ competitive platforms (StreetFoodFinder, Roaming Hunger, BFT, Marketspread, Vamo, MyCurbSpot). Priority order validated against PROJECT.md north star. |
| Architecture | HIGH | Derived from direct codebase analysis of index.js (10,279 lines) and shared/outbox.js. All schema DDL and state machine patterns are implementation-ready, not speculative. |
| Pitfalls | HIGH | All critical pitfalls (C1-C4) are verified with exact line references in the codebase. Not theoretical — these are existing code gaps confirmed by inspection. |

**Overall confidence:** HIGH

### Gaps to Address

- **7-day authorization window (MEDIUM confidence):** Stripe auth hold window varies by card brand (Visa ~5 days, others 7). The recommended approach (capture deposit immediately on booking confirmation rather than holding as open authorization) sidesteps this entirely. No action needed in planning, but document the capture-immediately decision in implementation notes.

- **EMS billing `category` field (MEDIUM confidence):** The Hub visibility pitfall (M6) requires differentiating venue deposit revenue from vendor order revenue in EMS. It is not confirmed whether the EMS billing endpoint supports a `category` or `type` field. Check the EMS endpoint spec during Phase 4 planning. Fallback is the `description` string convention.

- **Organizer anonymous-to-authenticated migration path (MEDIUM confidence):** The system has existing events created via the public `POST /api/events/request` endpoint with `organizer_email` as identity. The upgrade path (email link to "claim" the event as an authenticated organizer account) is the correct approach but the UX flow is not yet defined. Define in Phase 1 requirements before building.

- **Booth fee escrow via manual payout delay (HIGH complexity, not fully specced):** Charging vendors a booth fee at application time (FEATURES.md differentiator) requires Stripe Connect to hold the booth fee until event completion. The mechanism is Stripe's manual payout schedule on the platform account, not a true escrow license. This was identified as HIGH complexity in FEATURES.md and is correctly deferred from the MVP to a later pass within this milestone or a follow-on milestone.

---

## Sources

### Primary (HIGH confidence — verified against official docs and codebase)
- `/root/universoul-ecosystem/wya-app/index.js` (10,279 lines — direct codebase analysis)
- `/root/universoul-ecosystem/shared/outbox.js` — outbox implementation
- `/root/universoul-ecosystem/lib/customer-sync.js` — CustomerSync implementation
- `/root/universoul-ecosystem/ems/index.js` — EMS WYA integration (lines 104-1567)
- stripe-node SDK source (Context7 `/stripe/stripe-node`) — idempotency, separate charges, manual capture
- [Stripe Connect Separate Charges and Transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)
- [Stripe Place a Hold on a Payment Method](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)
- [Stripe Idempotent Requests](https://stripe.com/docs/api/idempotent_requests)
- [node-cron npm registry](https://www.npmjs.com/package/node-cron)

### Secondary (MEDIUM confidence — multiple sources agree)
- [StreetFoodFinder](https://streetfoodfinder.com) — organizer account feature set
- [Roaming Hunger catering FAQ](https://roaminghunger.com/catering/questions-and-answers/) — deposit model, escrow mechanics
- [Marketspread events platform](https://marketspread.com/manage/events/) — application fees, slot management
- [Best Food Trucks catering marketplace](https://www.bestfoodtrucks.com/blog/best-food-trucks-food-truck-catering-marketplace) — multi-vendor matching
- [My Curb Spot platform comparison](https://www.mycurbspot.com/guides/best-food-truck-booking-platforms-2025) — fee model comparison
- [Vamo Host](https://hellovamo.app/) — direct competitor, September 2026 launch
- [Transactional Outbox Pattern — microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)
- [Marketplace Supply Strategy — a16z](https://a16z.com/marketplace-supply-strategy-comprehensive-exclusive-or-curated/)

### Tertiary (MEDIUM confidence — useful for activation strategy)
- [Two-Sided Marketplace Cold Start 2026 — FORKOFF](https://forkoff.xyz/blog/founder-growth/two-sided-marketplace-cold-start-2026) — atomic network seed, 14-day first transaction rule
- [Marketplace Liquidity Metrics — Sharetribe](https://www.sharetribe.com/academy/measure-your-success-key-marketplace-metrics/) — match rate, fill rate, utilization
- [Why Two-Sided Marketplaces Fail After Launch — Raftlabs](https://www.raftlabs.com/blog/two-sided-marketplace-failure-rate) — cold start inversion failure mode

---
*Research completed: 2026-07-31*
*Ready for roadmap: yes*
