# Roadmap: WYA Revenue Activation

## Overview

WYA already has 270+ API endpoints, 44 database tables, and proven vendor/customer commerce. This milestone transforms it from a built product into a revenue-generating marketplace by adding a third role (organizer/venue), a complete booking transaction chain with deposit hold and deferred vendor payout, hardened financial event reliability, Hub visibility into the full chain, and the launch operations tooling needed for Sergio to manually activate the first vendor-venue transactions in Santa Barbara. Every phase delivers one coherent, verifiable capability that the next phase depends on.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation + Organizer Auth** - Harden outbox for financial integrity and establish authenticated organizer identity
- [ ] **Phase 2: Booking State Machine + Stripe Deposits** - Wire the full booking transaction chain from request to payout
- [ ] **Phase 3: Venue Slot System + Vendor Matching** - Build the demand/supply engine that creates a complete marketplace request cycle
- [ ] **Phase 4: Hub Visibility + Marketplace Analytics** - Instrument the full chain so Sergio can see every booking and measure liquidity
- [ ] **Phase 5: Launch Operations + Marketplace Activation** - Activate the supply-first launch strategy with founding vendor tooling and managed catering desk

## Phase Details

### Phase 1: Foundation + Organizer Auth
**Goal**: Every payment event is durably recorded with no silent leakage, and an authenticated organizer role exists as the identity backbone for all venue features
**Depends on**: Nothing (first phase)
**Requirements**: FNDTN-01, FNDTN-02, FNDTN-03, FNDTN-04, FNDTN-05, VENUE-01, VENUE-02, VENUE-03, VENUE-09
**Success Criteria** (what must be TRUE):
  1. A Stripe webhook event is never processed twice — the processed_stripe_events table deduplicates and returns 200 OK on replay
  2. A business write (order, booking) and its outbox record always commit together — killing the process mid-write never produces a paid order with no outbox entry
  3. An organizer can register with email/password, receive a session token in x-organizer-token, and access organizer endpoints without any access to vendor or customer data
  4. An organizer who previously created events via the anonymous flow can log in and claim those events via email match — no event data is lost
  5. Outbox health is visible to admin — dead letter count and last reconciliation timestamp are readable via API
**Plans**: TBD
**UI hint**: yes

### Phase 2: Booking State Machine + Stripe Deposits
**Goal**: A complete booking can move from request through vendor proposal, organizer acceptance, deposit payment, event completion, and vendor payout — with every state transition recorded and every Stripe call idempotent
**Depends on**: Phase 1
**Requirements**: BOOK-01, BOOK-02, BOOK-03, BOOK-04, BOOK-05, BOOK-06, BOOK-07, BOOK-09, BOOK-10, BOOK-11
**Success Criteria** (what must be TRUE):
  1. A requestor can submit a booking request (date, location, headcount, budget, category) and vendors matching the criteria receive a broadcast notification
  2. A vendor can submit a proposal against an open request, and the requestor can compare proposals and accept one
  3. Accepting a proposal triggers a Stripe Checkout session (Separate Charges + Transfers) — the organizer pays a deposit and the booking moves to deposited state
  4. After an event completes and the 48-hour dispute window passes, the vendor receives a Stripe Connect payout and the booking reaches paid_out state automatically
  5. A cancellation more than 7 days out triggers a full refund; 3-7 days triggers 50% refund; under 3 days triggers no refund — all via Stripe API with idempotency keys
  6. Every state transition is recorded in marketplace_transactions and booking_state_log with a timestamp and actor
**Plans**: TBD

### Phase 3: Venue Slot System + Vendor Matching
**Goal**: Organizers can publish venues with locations and available dates, vendors can discover and apply to open slots, and organizers can manage the full application lifecycle including messaging accepted vendors
**Depends on**: Phase 2
**Requirements**: VENUE-04, VENUE-05, VENUE-06, VENUE-07, VENUE-08, VENUE-10, BOOK-08
**Success Criteria** (what must be TRUE):
  1. An organizer can add a venue location (address, capacity, amenities) and publish available dates with vendor slot counts
  2. An organizer can set up a recurring weekly vendor rotation schedule — slots publish automatically for future dates
  3. A vendor can browse open slots filtered by date, location, and category, and submit an application to a specific slot
  4. An organizer can approve, decline, or waitlist a vendor application — approved vendors receive a push notification
  5. An organizer can send messages to accepted vendors through the existing WYA messaging system
  6. A requestor or vendor can submit a review after a booking reaches completed state
**Plans**: TBD
**UI hint**: yes

### Phase 4: Hub Visibility + Marketplace Analytics
**Goal**: Hub displays the full WYA booking chain, EMS billing distinguishes venue deposits from food orders, and Sergio has a liquidity dashboard showing whether the marketplace is achieving health
**Depends on**: Phase 3
**Requirements**: HUB-01, HUB-02, HUB-03
**Success Criteria** (what must be TRUE):
  1. Hub can read marketplace_transactions and display the full state chain (request → matched → proposed → accepted → deposited → confirmed → completed → paid_out → reviewed) for any booking
  2. WYA sends a structured notification to Hub on every booking state transition — Hub shows real-time booking activity without polling
  3. EMS billing records for venue booking deposits are distinguishable from food order charges by type/category field — revenue reporting does not conflate the two streams
**Plans**: TBD

### Phase 5: Launch Operations + Marketplace Activation
**Goal**: Sergio has the tooling to manually activate the marketplace: founding vendor onboarding, a managed catering desk for the first 30-60 bookings, a supply gate enforcing 5 Stripe-Connect vendors before venue invites, and a liquidity dashboard to measure health
**Depends on**: Phase 4
**Requirements**: LAUNCH-01, LAUNCH-02, LAUNCH-03, LAUNCH-04
**Success Criteria** (what must be TRUE):
  1. A founding vendor can complete a guided onboarding flow (profile completion + Stripe Connect setup) from a single admin-generated invite link — Stripe Connect onboarding status is tracked and visible to admin
  2. Admin can view a liquidity dashboard showing: active vendors, live hours, total searches, zero-result searches, open booking requests, and booked events — all in one screen
  3. Admin can use a managed catering desk interface to manually match a booking request to a specific vendor and advance the booking state on their behalf
  4. The supply-first gate is enforced: venue invitation emails cannot be sent until at least 5 vendors have Stripe Connect onboarded — gate status is visible in admin and blocks the invite action if not met
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation + Organizer Auth | 0/TBD | Not started | - |
| 2. Booking State Machine + Stripe Deposits | 0/TBD | Not started | - |
| 3. Venue Slot System + Vendor Matching | 0/TBD | Not started | - |
| 4. Hub Visibility + Marketplace Analytics | 0/TBD | Not started | - |
| 5. Launch Operations + Marketplace Activation | 0/TBD | Not started | - |
