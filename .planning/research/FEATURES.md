# Feature Landscape: WYA Venue/Organizer Marketplace

**Domain:** Hyperlocal vendor discovery + booking marketplace (food trucks, pop-ups, mobile vendors)
**Researched:** 2026-07-31
**Scope:** NEW capabilities only — venue/organizer role, booking marketplace transactions, marketplace activation
**Existing WYA features are out of scope** (see PROJECT.md for the full validated list)

---

## Area 1: Venue/Organizer Accounts

### Table Stakes

Features venues/organizers expect. Missing = product feels unusable as an organizer.

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Organizer role/account type | Third distinct role alongside vendor + customer; all competitive platforms have it (StreetFoodFinder, Vamo Host, Marketspread) | Low | Existing auth system — add `role: organizer` column |
| Location/spot management | Organizers manage named physical spots (e.g., "Parking Lot A", "Main Stage Area") with address, capacity, power/utilities notes | Medium | Existing geolocation infrastructure |
| Recurring slot publishing | Organizer publishes repeating weekly slots (e.g., "Friday 11am–2pm at State Street Lot") that vendors can book against | Medium | Existing recurring schedule system on vendor side |
| Vendor application intake | Vendors apply to open slots; organizer sees applicant list with vendor profile, menu, and ratings | Medium | Existing vendor profile + review data |
| Application approve/decline | Organizer reviews and acts on applications; vendor gets notified; slot marked filled | Low | Existing push notification + messaging infrastructure |
| Slot calendar view | Organizer sees all their locations with filled/open slots by date | Medium | No direct equivalent exists — new UI |
| Organizer public profile | Public page showing organizer's venues, upcoming events, participating vendors | Low | Existing vendor profile pattern |

### Differentiators

Features that set WYA apart from Vamo Host (September 2026 launch) and My Curb Spot (commission-free, payment offloaded to parties).

| Feature | Value Proposition | Complexity | Depends On |
|---------|-------------------|------------|------------|
| Booth/spot fee collection at application | Organizer can charge vendors a booth fee ($25–$200) during application; WYA holds until event | High | Stripe Connect — charge organizer-set amounts; escrow via manual payout delay |
| Duplicate prevention per slot | System prevents same vendor applying to overlapping slots at same location | Low | New slot overlap check logic |
| Vendor type/cuisine filtering for slots | Organizer specifies cuisine mix they want (e.g., "one dessert, one savory, one drinks") and system enforces it | Medium | Existing menu category data |
| Insurance/permit document collection | Organizer requires specific docs before approval (health permit, liability insurance); vendor uploads; organizer marks verified | High | New document upload/storage flow |
| Bulk communication to slot vendors | Organizer sends message blast to all vendors at a given location/event ("rain date moved to Saturday") | Low | Existing messaging infrastructure |
| Auto-fill suggestion | When a vendor cancels, WYA surfaces the top-rated waitlisted applicants for that slot | Medium | Existing review/rating data + waitlist state |

### Anti-Features

Do NOT build these for organizers in this milestone.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full venue management (floor plans, seating maps) | Enterprise venue software complexity (Marketspread, ConventionSuite). Not what food truck parks need. | Stick to named spots with text descriptions and address pins |
| Organizer-facing POS / in-person payments | Hardware dependency, out of scope. Vendors handle their own POS already. | Organizer only handles booth fees, not end-consumer sales |
| Multi-organizer team accounts / staff roles | Premature. Single organizer per account is sufficient for Santa Barbara scale. | Revisit after 5+ active organizer accounts |
| AI-generated vendor recommendations | Requires booking history volume that doesn't exist at launch. | Manual curation / waitlist surfacing |
| Venue CRM with full contact history | Overbuilt. Messaging thread per booking covers the need. | Use existing vendor-customer messaging adapted for organizer-vendor |

---

## Area 2: Complete Booking Marketplace Transaction Chain

### Table Stakes

The full transaction lifecycle from request to payout. Incomplete chains mean money stays off-platform or disputes are unresolvable.

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Catering/event request upgrade | Existing catering request system (already built) needs deposit collection wired in — submit request triggers Stripe PaymentIntent for deposit amount | High | Existing catering request system + Stripe Connect already wired |
| Deposit hold (escrow-like) | Industry standard: 25–50% deposit at booking confirmation. Stripe manual payouts implement this without a true escrow license. Roaming Hunger uses $500 deposit; Best Food Trucks uses 25–50%. | High | Stripe Connect `manual` payout schedule — already have Connect |
| Multi-vendor matching / vendor broadcast | When a host submits a catering request, WYA broadcasts to N qualified vendors (by cuisine, proximity, availability) and collects proposals | High | Existing vendor schedule + geolocation data; new proposal state machine |
| Vendor proposal submission | Vendor receives a booking lead, submits a formal proposal: price, menu, headcount capacity, setup time | Medium | Existing catering quote system — extend with structured fields |
| Host proposal review + accept/counter | Host sees all proposals side-by-side, accepts one, others auto-notified | Medium | New comparison UI; existing messaging for negotiation |
| Digital booking agreement | On acceptance, platform generates summary document (date, location, service hours, headcount, price, cancellation terms). Both parties confirm in-app. Not a full contract — a booking confirmation record. | Medium | New confirmation record — no need for PDF generation in v1; plain HTML printable |
| Final balance collection | Remaining balance (50–75%) due before event. Stripe PaymentIntent for balance, triggered by timer or manual organizer action. | Medium | Existing Stripe integration |
| Post-event vendor payout | After event date passes without dispute, platform releases funds to vendor via Stripe Connect transfer. WYA retains platform fee (10–15%). | High | Existing Stripe Connect payouts — need manual transfer trigger |
| Cancellation tiers with refund logic | Tiered policy: >30 days = full deposit refund; 14–30 days = 50% deposit refund; <14 days = no refund. Configurable at platform level. | Medium | New cancellation state + Stripe refund API |
| Booking status dashboard (host) | Host sees all their bookings by status: pending, confirmed, in-escrow, completed, disputed, refunded | Low | New query + UI; reuses existing admin dashboard patterns |
| Booking status dashboard (vendor) | Vendor sees incoming leads, active bookings, pending payouts | Low | Extend existing vendor analytics dashboard |

### Differentiators

What moves WYA above "just a contact form" into a real marketplace.

| Feature | Value Proposition | Complexity | Depends On |
|---------|-------------------|------------|------------|
| Platform dispute window | 48-hour post-event window during which host can flag a dispute before funds release. No dispute = auto-payout. | Medium | New dispute_flag table + payout delay logic |
| Dispute resolution workflow | Host submits evidence (photos, messages). Vendor responds. WYA admin mediates. Platform decision is binding. | High | Admin dashboard extension; existing messaging as evidence trail |
| No-show protection for host | If vendor doesn't show: full refund to host, vendor flagged in system, payout withheld | Medium | Geolocation check-in signal + dispute flag |
| Minimum guarantee enforcement | Platform enforces minimum order floor (e.g., $500 for 2-hour event) at proposal stage so vendors don't accept loss-leaders | Low | Validation at proposal submission |
| Force majeure / weather clause | Documented policy: weather cancellations treated as no-fault, deposit returned minus 5% admin fee | Low | Policy text + cancellation flow branch |
| Booking confirmation PDF export | Host can download booking summary as PDF for their records / venue management | Medium | HTML-to-PDF; puppeteer already available in ecosystem |
| Marketplace fee transparency | Platform fee shown explicitly in confirmation: "WYA retains $X (12% marketplace fee)" | Low | Fee calculation at Stripe charge time |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full legal contract generation | Legal liability, requires attorney review, overkill for $500–$5k events | Generate a booking confirmation summary; recommend parties use their own contracts for large events |
| Real-time bid auction / reverse auction | High cognitive load, complex UX, not the pattern vendors expect | Sequential proposal review by host is sufficient |
| Automated dispute AI judgment | Cannot automate binding financial decisions. | Human admin mediation — Sergio handles manually until volume justifies tooling |
| Multi-currency support | Santa Barbara only. Single currency. | USD only |
| Installment plans for hosts | Complex accounting, edge cases. | Deposit + balance = two payments max |

---

## Area 3: Marketplace Activation

### Table Stakes

Actions required to generate liquidity. A platform with no active vendors or no active bookers is worse than no platform (stale maps erode trust).

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Founding vendor designation | First 10–20 vendors get "Founding Vendor" badge, permanent free tier, priority placement. Reduces acquisition friction. Industry standard: Marketspread uses free onboarding; BFT uses profile SEO as incentive. | Low | Existing subscription tier system — add founding_vendor flag |
| Managed catering desk (manual first) | Sergio manually matches catering requests to vendors via WYA admin for the first 30–60 days BEFORE automating broadcast. Validates workflow. PROJECT.md explicitly calls this out. | Low (process, not code) | Existing admin dashboard + catering request view |
| Organizer anchor seeding | Recruit 2–3 high-traffic Santa Barbara locations (farmers market, State Street Fridays, a brewery) before opening to public. One active organizer creates recurring demand that pulls in vendors. | Low (process, not code) | Organizer account creation |
| Vendor onboarding call + profile completion assist | First-transaction-within-14-days retention rate drives platform health. Personal outreach closes this. Not a feature — a process. | Low (process) | Existing vendor checklist |
| Liquidity dashboard (internal only) | Admin view: match rate, fill rate (slots with at least one confirmed vendor / total published slots), open catering requests aging | Medium | New admin analytics queries; no frontend dependency |
| Marketplace health email (weekly) | Weekly internal email to Sergio: X new vendors, Y catering requests, Z confirmed bookings, fill rate, payout volume | Low | Existing Soul email infrastructure (port 3380) |

### Differentiators

What WYA can do for activation that competitors don't (because they're national platforms optimizing for scale, not Santa Barbara specifically).

| Feature | Value Proposition | Complexity | Depends On |
|---------|-------------------|------------|------------|
| SB compliance pre-check for organizers | When organizer publishes a public location, WYA checks the 4hr/500ft ordinance compliance for vendor slots at that location. Unique to WYA. | Low | Existing SB compliance checker |
| Vendor density map (internal tool) | Admin map showing where WYA vendor coverage is thin by neighborhood — guides Sergio's outreach priorities | Medium | Existing geolocation data + admin dashboard |
| First booking incentive for hosts | First catering request through WYA gets 50% off platform fee (up to $50 value). Creates urgency, removes hesitation. | Low | Fee discount logic at checkout |
| Referral loop: vendor invites venue | Vendor earns credit when they refer a venue/organizer that creates a paid booking. | Medium | Existing ambassador/referral system — extend to organizer-referrals |
| "WYA Verified" organizer badge | Organizers who complete profile, add 3+ spots, and have one confirmed booking get a badge. Signals trust to vendors. | Low | New badge state on organizer profile |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Paid vendor acquisition (ads) | Budget doesn't exist; direct outreach costs nothing and builds relationships that matter for a hyperlocal platform | Personal outreach by Sergio, SFF/Vamo listed vendors as targets |
| Consumer-facing "coming soon" page | Creates expectation without supply; erodes trust. Vamo's own research shows stale maps are worse than no platform. | Soft-launch: only market to vendors + organizers until liquidity threshold (10 vendors, 2 organizers, 1 completed booking) |
| City expansion before Santa Barbara liquidity | Premature. Roaming Hunger, SFF both started in one city. | Lock in 20 active vendors and 5 active organizers before considering expansion |
| Automated SEO content about SB vendors | Low-quality AI content damages brand; vendors notice when their profile is described inaccurately | Vendor-completed profiles only |

---

## Feature Dependencies

```
Organizer account (role)
  → Location management
    → Slot publishing
      → Vendor application intake
        → Application fees (booth fees)
          → Stripe deposit hold
            → Post-event payout

Catering request (existing)
  → Multi-vendor broadcast (new)
    → Vendor proposal submission
      → Host accept/counter
        → Booking confirmation record
          → Deposit collection (existing Stripe + new hold logic)
            → Final balance collection
              → Dispute window
                → Vendor payout OR dispute resolution

Founding vendor designation
  → Profile completion assist (process)
    → First booking within 14 days
      → Liquidity dashboard signal

Organizer anchor (process)
  → Recurring slot demand
    → Vendor fill rate signal
      → Marketplace health email
```

---

## MVP Recommendation

**Priority 1 — Unlock the North Star transaction** (from PROJECT.md: one venue, one vendor, deposit paid, event completed, payout released):
1. Organizer role + basic location + slot publishing
2. Vendor application intake + approve/decline + notify
3. Catering request broadcast to N vendors
4. Proposal submission + host accept
5. Booking confirmation record
6. Deposit hold (Stripe manual payout)
7. Post-event payout with 48h dispute window
8. Cancellation tiers + refund logic

**Priority 2 — Marketplace instrumentation** (prove it's working):
1. Liquidity dashboard (admin)
2. Founding vendor badge + fee waiver
3. Marketplace health email
4. First booking incentive for hosts

**Priority 3 — Protection and trust** (required before broader promotion):
1. Dispute resolution workflow (admin-mediated)
2. No-show protection
3. Vendor application document collection (insurance/permits)
4. Booking confirmation PDF export

**Defer to later milestones:**
- Auto-fill suggestion (needs cancellation history)
- Vendor density map (needs 30+ vendors)
- Referral loop for organizer-referrals (needs ambassador system extension)
- Duplicate cuisine prevention for slots (needs slot fill history)
- Force majeure / weather clause (add to policy text, no code needed in v1)

---

## Complexity Summary

| Area | Low Complexity | Medium Complexity | High Complexity |
|------|---------------|-------------------|-----------------|
| Venue/Organizer Accounts | Role creation, approve/decline, notifications, profile, bulk message | Slot calendar UI, location management, recurring slots, cuisine filtering | Document collection/storage, booth fee escrow |
| Booking Marketplace | Booking status dashboards, confirmation record, minimum guarantee, fee transparency | Multi-vendor broadcast logic, proposal UI, cancellation tiers, PDF export, dispute window | Deposit hold/release, multi-vendor matching state machine, dispute resolution workflow, no-show protection |
| Marketplace Activation | Founding badge, managed catering desk (process), anchor organizer (process), health email | Liquidity dashboard, vendor density map | None — activation is mostly process, not code |

**Single-developer brownfield reality:** Prioritize the state machine for booking (deposit → escrow → payout → dispute) above all else. This is the riskiest piece of new code in a brownfield system. Everything else layers on top of existing WYA infrastructure.

---

## Sources

- [StreetFoodFinder](https://streetfoodfinder.com) — organizer accounts, largest US platform
- [Roaming Hunger catering FAQ](https://roaminghunger.com/catering/questions-and-answers/) — deposit model, escrow, vendor-pays-nothing structure
- [Marketspread events platform](https://marketspread.com/manage/events/) — application fees, slot management, document collection, digital signatures
- [Best Food Trucks catering marketplace](https://www.bestfoodtrucks.com/blog/best-food-trucks-food-truck-catering-marketplace) — multi-vendor matching, corporate recurring programs
- [My Curb Spot platform comparison](https://www.mycurbspot.com/guides/best-food-truck-booking-platforms-2025) — fee model comparison across platforms
- [How to Build a Food Truck Marketplace — lowcode.agency](https://www.lowcode.agency/blog/how-to-build-a-food-truck-marketplace) — commission-first, deposit mechanics, cold start
- [Vamo Host](https://hellovamo.app/) — dual-app model, group chat, vendor applications, September 2026 launch (direct competitor)
- [Essential Food Truck Catering Contracts — PricingLink](https://pricinglink.com/knowledge-base/food-truck-catering/essential-contracts-for-food-truck-catering/) — contract elements, deposit, cancellation
- [Marketplace cold start — Airdev](https://www.airdev.co/marketplaces/guide/launch-strategies) — constrain geography, supply-first, activation KPIs
- [Two-Sided Marketplace Cold Start 2026 — FORKOFF](https://forkoff.xyz/blog/founder-growth/two-sided-marketplace-cold-start-2026) — atomic network seed, 14-day first transaction rule
- [Marketplace Supply Strategy — a16z](https://a16z.com/marketplace-supply-strategy-comprehensive-exclusive-or-curated/) — curated vs comprehensive launch
- [Stripe Connect manual payouts](https://docs.stripe.com/connect/manual-payouts) — escrow-like hold/release, up to 90 days
- [Marketplace Liquidity Metrics — Sharetribe](https://www.sharetribe.com/academy/measure-your-success-key-marketplace-metrics/) — match rate, fill rate, utilization instrumentation
