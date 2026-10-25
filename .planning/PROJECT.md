# WYA (Where You At) — Hyperlocal Vendor Discovery Platform

## What This Is

WYA is a self-hosted hyperlocal commerce platform for Santa Barbara that lets customers discover live vendors, place orders, book catering, and follow their favorites — while giving vendors a complete business operating system including analytics, delivery, messaging, promotions, and Stripe-powered payments. Part of the Universoul ecosystem (Hub, DigiBook, DigiStore, DigiTap, SDC, Digital Signage).

## Core Value

**Vendors get discovered, booked, and paid through WYA. Every feature exists to increase the number, value, or repeat rate of real vendor transactions.**

## Requirements

### Validated

<!-- Shipped and confirmed in codebase. 270+ API endpoints, 44 database tables. -->

- [x] Vendor registration, login, profiles, onboarding checklist
- [x] Customer registration, login, profiles
- [x] Live geolocation with go-live/go-offline toggle and status logging
- [x] Geofencing with auto-checkin
- [x] Recurring vendor schedules (day-of-week, multiple locations)
- [x] Menu management with modifier groups, categories, pricing
- [x] Ordering system with payment tracking and status logging
- [x] Pickup and delivery infrastructure (zones, drivers, assignments, tracking)
- [x] Vendor-customer bidirectional messaging
- [x] Catering request system (submit, quote, accept/decline)
- [x] Event booking and RSVP system
- [x] iCalendar export (vendor + community events)
- [x] Reviews with profanity filtering and vendor responses
- [x] QR code generation with scan attribution tracking
- [x] Push notifications (web-push, VAPID, service worker)
- [x] Stripe integration (payments, checkout, subscriptions)
- [x] Stripe Connect (vendor payouts, commissions)
- [x] 30-day vendor trial system with expiration tracking
- [x] Subscription tiers (free, starter, pro, enterprise)
- [x] Loyalty points system
- [x] Ambassador/referral program with commission tracking
- [x] Promo codes with usage tracking
- [x] Social features (cards, sharing, broadcast, analytics)
- [x] Ad/premium placement system with impression/click tracking
- [x] Vendor analytics and earnings dashboard
- [x] Nearby vendor search with distance filtering
- [x] SB food truck compliance checking (4hr/500ft ordinance)
- [x] Admin dashboard (vendors, trials, revenue, orders, customers, events)
- [x] PWA support (service worker, offline caching, manifest)
- [x] Customer sync via Outbox pattern (CustomerSync class, SQLite-backed, retry logic)
- [x] Billing event sync to EMS
- [x] Rate limiting, security headers, crash reporting
- [x] 6 frontend interfaces (customer, vendor, admin, account, plans, landing)
- [x] Smoke, lockdown, and E2E test suites

### Active

<!-- Current scope: Milestone v1.0 — Revenue Activation -->

- [ ] Venue/organizer accounts as 3rd role
- [ ] Complete booking marketplace transaction chain
- [ ] Outbox hardening (idempotency, reconciliation, atomic commits)
- [ ] Hub visibility of full WYA transaction chain
- [ ] Launch operations (founding vendor onboarding, managed catering desk)
- [ ] Marketplace liquidity instrumentation

### Out of Scope

- Native iOS/Android app — PWA sufficient for launch, revisit after marketplace proven
- Home-screen widgets — Retention feature for after launch
- Real-time video/streaming — Not core to vendor discovery
- Multi-city expansion — Prove Santa Barbara first
- AI-generated vendor content — Focus on real vendor data

## Context

- **Ecosystem position:** WYA is the "Golden Revenue Tenant" — touches customer acquisition, vendor onboarding, payments, CRM, marketing, Hub analytics, and Soul automations
- **Competitive landscape:** Ahead of What's Open in business capability. Competitive with Vamo in feature breadth. Behind StreetFoodFinder and Roaming Hunger in organizer operations and marketplace density.
- **Primary gap:** Not feature breadth (88-93% complete). The gap is marketplace activation — no venue/organizer role, unproven live transactions, no active vendor network.
- **Architecture:** Express.js + SQLite (better-sqlite3) + Stripe + web-push. Single service at port 3422.
- **ARCH FREEZE active:** No new PM2 services. All work goes into existing wya-app and ecosystem services.
- **North star:** One real venue generates demand > WYA matches a real vendor > deposit is paid > event completes > Stripe Connect pays vendor > WYA retains fee > Hub records full chain > Soul follows up.

## Constraints

- **Architecture:** ARCH FREEZE — no new PM2 services, consolidate into existing
- **Infrastructure:** Single droplet (138.68.226.206), 45% memory usage, 55% disk
- **Payments:** Free-tier API keys only (DISABLE_PAID_AI=true)
- **Database:** SQLite spine — no MySQL migration for WYA
- **Auth:** Must integrate with ecosystem SSO via THE SOUL
- **Billing sync:** Must flow through CustomerSync Outbox to EMS

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SQLite for WYA database | Consistent with ecosystem spine, no extra infra | -- Pending |
| Outbox pattern for billing sync | Durable delivery, retry logic, survives restarts | -- Pending |
| Venue/organizer as 3rd role | StreetFoodFinder's moat, creates recurring demand | -- Pending |
| Free founding vendors | Remove vendor acquisition barrier, build density first | -- Pending |
| Host pays, not vendor | Roaming Hunger model — vendors join free, venues/hosts pay booking fees | -- Pending |
| Managed catering desk before automation | Learn real workflow manually, then automate | -- Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-31 after milestone v1.0 initialization (brownfield)*
