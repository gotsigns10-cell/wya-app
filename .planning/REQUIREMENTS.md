# Requirements: WYA Revenue Activation

**Defined:** 2026-08-01
**Core Value:** Vendors get discovered, booked, and paid through WYA. Every feature exists to increase the number, value, or repeat rate of real vendor transactions.

## v1 Requirements

Requirements for milestone v1.0. Each maps to roadmap phases.

### Foundation

- [ ] **FNDTN-01**: Outbox enqueue runs inside the same SQLite transaction as the business write (atomic commit)
- [ ] **FNDTN-02**: Every outbox record includes a unique idempotency key
- [ ] **FNDTN-03**: Dead letter reconciliation cron retries permanently failed outbox items daily
- [ ] **FNDTN-04**: Stripe webhook handler deduplicates events via processed_stripe_events table
- [ ] **FNDTN-05**: Outbox completed rows auto-archive after 30 days

### Venue/Organizer

- [ ] **VENUE-01**: Organizer can register with email and password (distinct from vendor/customer)
- [ ] **VENUE-02**: Organizer authenticates via x-venue-token header (isolated from vendor auth)
- [ ] **VENUE-03**: Organizer can create and manage a profile (business name, type, description, logo)
- [ ] **VENUE-04**: Organizer can add multiple locations with address, capacity, and amenities
- [ ] **VENUE-05**: Organizer can publish available dates with vendor slot counts per location
- [ ] **VENUE-06**: Organizer can set recurring schedules (weekly vendor rotation)
- [ ] **VENUE-07**: Vendor can browse and apply to open venue slots
- [ ] **VENUE-08**: Organizer can approve, decline, or waitlist vendor applications
- [ ] **VENUE-09**: Existing anonymous organizer events migrate to authenticated accounts on first login
- [ ] **VENUE-10**: Organizer can message accepted vendors through existing messaging system

### Booking Marketplace

- [ ] **BOOK-01**: Customer or organizer can submit a booking request (date, time, location, headcount, budget, category, dietary needs)
- [ ] **BOOK-02**: System broadcasts request to matching qualified vendors
- [ ] **BOOK-03**: Vendor can submit a proposal (availability, menu, quoted price)
- [ ] **BOOK-04**: Requestor can compare and accept a vendor proposal
- [ ] **BOOK-05**: Accepted booking triggers Stripe deposit (Separate Charges + Transfers pattern)
- [ ] **BOOK-06**: Booking state machine tracks: requested > matched > proposed > accepted > deposited > confirmed > completed > paid_out > reviewed
- [ ] **BOOK-07**: Vendor receives Stripe Connect payout after completion confirmation
- [ ] **BOOK-08**: Requestor can review vendor after booking completion
- [ ] **BOOK-09**: Tiered cancellation policy (full refund >7 days, 50% 3-7 days, no refund <3 days)
- [ ] **BOOK-10**: 48-hour dispute window after event before final payout
- [ ] **BOOK-11**: marketplace_transactions table records the full chain for every booking

### Hub Visibility

- [ ] **HUB-01**: Hub can read marketplace_transactions to display the full booking chain
- [ ] **HUB-02**: WYA sends structured notifications to Hub on booking state transitions
- [ ] **HUB-03**: EMS billing records distinguish venue booking deposits from food orders

### Launch Operations

- [ ] **LAUNCH-01**: Founding vendor onboarding flow (guided profile completion + Stripe Connect setup)
- [ ] **LAUNCH-02**: Liquidity dashboard shows active vendors, live hours, searches, zero-results, bookings
- [ ] **LAUNCH-03**: Admin managed catering desk (manually match requests to vendors for first 30-60 bookings)
- [ ] **LAUNCH-04**: Supply-first launch gate (minimum 5 Stripe-Connect-onboarded vendors before venue invites)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Venue Operations

- **VENUE-V2-01**: Organizer can collect booth/participation fees from vendors
- **VENUE-V2-02**: Organizer can track vendor insurance and permit documentation
- **VENUE-V2-03**: Organizer can publish event performance reports
- **VENUE-V2-04**: Vendor rotation rules (fair scheduling across weekly slots)

### Booking Advanced

- **BOOK-V2-01**: Replacement vendor matching when a confirmed vendor cancels
- **BOOK-V2-02**: Signed digital agreements/contracts for bookings
- **BOOK-V2-03**: Chargeback evidence generation for disputed payments
- **BOOK-V2-04**: Booth fee escrow for multi-vendor events

### Distribution

- **DIST-V2-01**: Native iOS app shell wrapping PWA
- **DIST-V2-02**: Native Android app shell wrapping PWA
- **DIST-V2-03**: Home-screen widget for followed vendors

## Out of Scope

| Feature | Reason |
|---------|--------|
| Native mobile apps | PWA sufficient for marketplace validation; defer until proven |
| Multi-city expansion | Prove Santa Barbara first |
| AI-generated vendor content | Focus on real vendor data |
| Booth fee escrow | HIGH complexity per research; defer to v2 |
| Signed digital contracts | Legal complexity; manual for first 60 bookings |
| Real-time video/streaming | Not core to vendor discovery |
| New PM2 services | ARCH FREEZE — all work within existing services |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FNDTN-01 | Phase 1 | Pending |
| FNDTN-02 | Phase 1 | Pending |
| FNDTN-03 | Phase 1 | Pending |
| FNDTN-04 | Phase 1 | Pending |
| FNDTN-05 | Phase 1 | Pending |
| VENUE-01 | Phase 1 | Pending |
| VENUE-02 | Phase 1 | Pending |
| VENUE-03 | Phase 1 | Pending |
| VENUE-09 | Phase 1 | Pending |
| BOOK-01 | Phase 2 | Pending |
| BOOK-02 | Phase 2 | Pending |
| BOOK-03 | Phase 2 | Pending |
| BOOK-04 | Phase 2 | Pending |
| BOOK-05 | Phase 2 | Pending |
| BOOK-06 | Phase 2 | Pending |
| BOOK-07 | Phase 2 | Pending |
| BOOK-09 | Phase 2 | Pending |
| BOOK-10 | Phase 2 | Pending |
| BOOK-11 | Phase 2 | Pending |
| VENUE-04 | Phase 3 | Pending |
| VENUE-05 | Phase 3 | Pending |
| VENUE-06 | Phase 3 | Pending |
| VENUE-07 | Phase 3 | Pending |
| VENUE-08 | Phase 3 | Pending |
| VENUE-10 | Phase 3 | Pending |
| BOOK-08 | Phase 3 | Pending |
| HUB-01 | Phase 4 | Pending |
| HUB-02 | Phase 4 | Pending |
| HUB-03 | Phase 4 | Pending |
| LAUNCH-01 | Phase 5 | Pending |
| LAUNCH-02 | Phase 5 | Pending |
| LAUNCH-03 | Phase 5 | Pending |
| LAUNCH-04 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 33 total (FNDTN: 5, VENUE: 10, BOOK: 11, HUB: 3, LAUNCH: 4)
- Mapped to phases: 33
- Unmapped: 0

---
*Requirements defined: 2026-08-01*
*Last updated: 2026-08-01 — traceability complete after roadmap creation*
