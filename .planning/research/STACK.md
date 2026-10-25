# Technology Stack

**Project:** WYA — Venue/Organizer Role, Booking Marketplace, Outbox Hardening
**Milestone:** v1.0 Revenue Activation (subsequent milestone — brownfield)
**Researched:** 2026-07-31
**Mode:** Additive only — existing stack is Express.js + SQLite (better-sqlite3) + Stripe + web-push

---

## Existing Stack (Validated — Do Not Re-research)

| Technology | Version | Purpose |
|------------|---------|---------|
| express | ^4.22.2 | HTTP server, 270+ endpoints on port 3422 |
| better-sqlite3 | ^12.10.0 | Primary database, WAL mode, 44 tables |
| stripe | ^22.1.1 | Payments + Stripe Connect vendor payouts |
| web-push | ^3.6.7 | VAPID push notifications |
| bcrypt | ^6.0.0 | Password hashing |
| multer | ^2.1.1 | File/photo uploads |
| qrcode | ^1.5.4 | QR code generation |
| express-rate-limit | ^8.3.1 | Rate limiting |
| CustomerSync / Outbox | shared lib | SQLite-backed outbox for EMS sync |

**What the Outbox already does:** Enqueues HTTP calls to EMS with 5-attempt exponential backoff (1s→5s→30s→5m→30m). Status column: pending/completed/failed. No idempotency key. No dead-letter reconciliation.

---

## New Capabilities Required

### 1. Venue/Organizer Accounts (3rd Role)

**What the current code has:** `organizer_name/email/phone` fields are loose text on `vendor_events` — no authenticated organizer account, no session, no stripe connect, no login.

**What is needed:** A proper `organizers` table (id, email, password_hash, name, business_name, stripe_connect_id, stripe_connect_onboarded, tier, created_at) with bcrypt auth, session tokens, and its own API routes. Mirrors the vendors table structure closely.

**New library needed:** None. bcrypt, better-sqlite3, and express sessions already exist. Copy the vendor auth pattern.

**Why not a separate auth library:** Adding passport.js or similar is scope creep. The existing bcrypt + session token pattern in vendors is battle-tested in this codebase and handles all three roles (vendor, customer, organizer) identically.

---

### 2. Booking Marketplace Transaction Chain

The full chain is: **Request → Match → Multi-Vendor Response → Deposit → Contract → Completion → Payout → Review → Dispute**

This maps to a SQLite state machine on a new `booking_requests` table:

```
status: draft → posted → matched → deposit_held → contracted →
        in_progress → completed → payout_sent → closed
        (or: cancelled | disputed at any step after deposit_held)
```

**Stripe pattern to use:** Separate Charges and Transfers (not destination charges).

**Why separate charges over destination charges:**
- Deposit is collected on the *platform* account first (venue/host pays)
- Transfer to vendor(s) happens *after* completion, not at payment time
- A single booking may involve multiple vendors (multi-vendor response)
- Allows withholding payout during dispute window without complex refund flows
- `source_transaction` on the transfer links payout to the original charge for clean reconciliation
- WYA retains application fee from the spread (deposit amount vs. vendor payout amount)

**Key Stripe API calls — no new library needed, stripe@22.x already installed:**

```javascript
// Step 1: Authorize deposit (hold only, do not capture immediately)
const pi = await stripe.paymentIntents.create({
  amount: depositCents,
  currency: 'usd',
  capture_method: 'manual',           // hold, do not charge yet
  transfer_group: `booking_${bookingId}`,
  metadata: { booking_id: bookingId, organizer_id: organizerId }
}, { idempotencyKey: `deposit-${bookingId}` });

// Step 2: Capture on completion (within 7 days for most cards)
const captured = await stripe.paymentIntents.capture(pi.id, {
  amount_to_capture: depositCents
}, { idempotencyKey: `capture-${bookingId}` });

// Step 3: Transfer to vendor after completion (minus WYA fee)
await stripe.transfers.create({
  amount: vendorPayoutCents,
  currency: 'usd',
  destination: vendor.stripe_connect_id,
  source_transaction: captured.latest_charge,  // links to captured charge
  transfer_group: `booking_${bookingId}`,
  metadata: { booking_id: bookingId, vendor_id: vendorId }
}, { idempotencyKey: `payout-${bookingId}-${vendorId}` });
```

**Authorization expiry constraint:** Stripe holds a manual-capture PaymentIntent for 7 days (Visa: ~5 days, Mastercard/Amex/Discover: 7 days). For events further out, capture the deposit on booking confirmation, not on event date. Refund if cancelled before event. Do not attempt to hold authorization for weeks — it will expire silently.

**Recommendation:** Capture the deposit immediately on booking confirmation (not on event completion). Hold the *funds* in WYA's Stripe balance, not as an open authorization. Release to vendor via transfer post-completion. This is simpler and avoids authorization expiry edge cases.

---

### 3. Idempotency Keys in Stripe Calls

**Problem with current code:** Stripe calls in `index.js` pass no `idempotencyKey` option. If a webhook fires twice or a request retries after a timeout, duplicate charges or transfers can be created.

**Fix:** Pass `{ idempotencyKey: 'deterministic-string' }` as the second argument to every Stripe mutating call. The key must be deterministic from local state (not random UUID on each call).

**Pattern — no new library needed:**

```javascript
// Deterministic from booking + action type
const ikey = `${action}-${bookingId}`;

// Or for webhook-driven actions, use Stripe event ID
const ikey = `webhook-${stripeEvent.id}-${action}`;

await stripe.transfers.create(params, { idempotencyKey: ikey });
```

**Stripe deduplication window:** 24 hours. Within that window, identical idempotency key + same endpoint = same response returned, no duplicate action taken. HIGH confidence from stripe-node source and official docs.

---

### 4. Outbox Hardening

**Current gaps in `shared/outbox.js`:**

| Gap | Impact | Fix |
|-----|--------|-----|
| No idempotency key column | Retried EMS calls can create duplicate customer records | Add `idempotency_key TEXT UNIQUE` column; INSERT OR IGNORE on duplicate |
| No atomic enqueue | If the main DB write succeeds but process crashes before enqueue, event is lost | Use `db.transaction()` to wrap both the business write and outbox INSERT in one atomic call |
| `status='failed'` rows never re-queued | Permanent failures silently drop without alerting | Add dead-letter table + scheduled reconciliation |
| Outbox processes 10 rows/tick globally | All products share one loop | Already product-scoped per CustomerSync instance — acceptable for this scale |

**Fix pattern — no new library needed, better-sqlite3 `db.transaction()` is synchronous:**

```javascript
// Atomic: business write + outbox enqueue in one SQLite transaction
const enqueueBookingEvent = db.transaction((booking, eventType) => {
  db.prepare('INSERT INTO booking_requests ...').run(booking);
  db.prepare(`INSERT OR IGNORE INTO outbox
    (url, method, headers, body, idempotency_key, next_retry_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(url, 'POST', headers, body, `${eventType}-${booking.id}`, Date.now());
});
enqueueBookingEvent(booking, 'booking.created');
```

**Dead letter reconciliation pattern:**

```javascript
// In outbox.js: after MAX_ATTEMPTS exhausted, move to dead_letter table
// Add a /api/admin/outbox/dead-letter endpoint to list + manual retry
// Run reconciliation check on startup and daily cron
```

**New column migration (add to index.js migrations array):**
```sql
ALTER TABLE outbox ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_ikey ON outbox(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

---

### 5. Scheduled Jobs for Booking Lifecycle

**Needed for:**
- Expire booking requests that get no vendor response in N hours
- Send reminder notifications before event date
- Re-check stale deposit holds
- Dead-letter reconciliation scan

**Current approach:** WYA uses `setInterval` inline (vendor trial expiry, VAPID refresh). This works at current scale.

**Recommendation for new booking lifecycle jobs:** Continue with `setInterval` for sub-1-hour intervals. For daily reconciliation (dead-letter scan, booking expiry), add `node-cron` to keep intent readable without adding complexity.

**New library:** `node-cron` ^4.x (latest: 4.6.0 as of mid-2026). Zero dependencies, TypeScript types included, no build step.

```bash
npm install node-cron@^4.6.0
```

**Why node-cron over setInterval for daily jobs:**
- Cron expression is self-documenting (`0 2 * * *` = 2am daily vs `setInterval(fn, 86400000)`)
- Prevents drift — `setInterval(fn, 86400000)` drifts based on startup time
- node-cron prevents overlapping runs (protection against slow jobs)
- 0 production dependencies, 7KB

**Why not a job queue (Bull, BullMQ, pg-boss):** ARCH FREEZE prohibits new PM2 services. These require Redis or Postgres. WYA's job volume (a handful of daily crons) does not justify an external queue — node-cron + SQLite outbox is sufficient and follows existing patterns.

---

### 6. Webhook Event Deduplication Table

**Problem:** The existing Stripe webhook handler at `/api/stripe/webhook` processes events but has no deduplication. Stripe will retry webhooks for up to 72 hours. A retry on `checkout.session.completed` currently risks double-processing an order.

**Fix:** Add a `processed_stripe_events` table (event_id TEXT PRIMARY KEY, processed_at TEXT). Check before processing, insert after. No new library needed.

```sql
CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT,
  processed_at TEXT DEFAULT (datetime('now'))
);
```

Pattern in the webhook handler:
```javascript
const existing = db.prepare('SELECT 1 FROM processed_stripe_events WHERE event_id=?').get(event.id);
if (existing) return res.json({ received: true, skipped: true });
// ... process event ...
db.prepare('INSERT OR IGNORE INTO processed_stripe_events (event_id, event_type) VALUES (?, ?)').run(event.id, event.type);
```

---

### 7. Dispute Handling

**Stripe events to handle (add to existing webhook switch):**
- `charge.dispute.created` — log to `booking_disputes` table, flag booking status as `disputed`, notify both organizer and vendor
- `charge.dispute.funds_withdrawn` — record funds withdrawn, update booking ledger
- `charge.dispute.closed` — record outcome, trigger payout or refund accordingly

**New table needed:** `booking_disputes` (id, booking_id, stripe_dispute_id, status, amount_cents, reason, outcome, created_at, resolved_at)

**No new library needed.** All dispute interactions use existing `stripe@22.x` API.

---

## Summary: What to Add

| Addition | Type | Package | Version | Rationale |
|----------|------|---------|---------|-----------|
| `node-cron` | npm dependency | `node-cron` | ^4.6.0 | Daily reconciliation crons, readable syntax, 0 deps |
| Idempotency key column on outbox | Schema migration | — | — | Deduplication for EMS calls |
| `processed_stripe_events` table | Schema migration | — | — | Stripe webhook deduplication |
| `booking_requests` table | Schema migration | — | — | Booking marketplace state machine |
| `organizers` table | Schema migration | — | — | 3rd role (venue/organizer accounts) |
| `booking_disputes` table | Schema migration | — | — | Dispute tracking |
| Stripe idempotency keys | Code change | — | — | Pass `{ idempotencyKey }` to all Stripe mutations |
| Atomic outbox enqueue | Code change | — | — | `db.transaction()` wrapping business write + outbox INSERT |

**Total new npm packages: 1 (`node-cron`).**

Everything else is additive schema changes and code patterns on existing dependencies.

---

## What NOT to Add

| Rejected Addition | Why Rejected |
|-------------------|-------------|
| Redis / BullMQ / pg-boss | ARCH FREEZE: no new PM2 services; job volume doesn't justify Redis |
| Passport.js | Vendor auth pattern already exists in codebase; copy it for organizers |
| Temporal.io | Overkill for SQLite-backed state machine at SB-scale |
| Prisma / TypeORM | Codebase uses raw better-sqlite3 prepared statements throughout; ORM would create two patterns |
| PostgreSQL migration | ARCH FREEZE: SQLite spine is non-negotiable per PROJECT.md |
| Webhooks library (svix, etc.) | Stripe's built-in `stripe.webhooks.constructEvent` is already used |
| Separate PM2 service for booking | ARCH FREEZE: everything goes into existing wya-app at port 3422 |

---

## Integration Points

### Existing CustomerSync / Outbox
The new organizer role should get its own CustomerSync instance: `new CustomerSync('wya-organizer')`. Add `'wya-organizer'` to the `VALID_PRODUCTS` set in `customer-sync.js`. This mirrors the existing vendor/customer split.

### Hub Visibility
Booking transaction chain events (deposit captured, payout sent, dispute opened) should emit to the existing Brain Write endpoint at `localhost:3350/write` using the same fire-and-forget pattern already used for crash reporting. Hub reads from there. No new integration needed.

### EMS Auth Bridge
Organizer sessions should go through `requireEMSAuth` if organizers need cross-product SSO. For MVP, session tokens can follow the vendor pattern (opaque token in `organizer_sessions` table) and add EMS bridge later.

---

## Installation

```bash
# From /root/universoul-ecosystem/wya-app/
npm install node-cron@^4.6.0
```

No other package installs required.

---

## Confidence Assessment

| Area | Confidence | Basis |
|------|------------|-------|
| Stripe separate charges + transfers | HIGH | Verified against stripe-node source (Context7) + official docs |
| Stripe idempotency key API | HIGH | Verified in stripe-node RequestOptions interface (Context7) |
| Manual capture / hold pattern | HIGH | Verified against Stripe docs + stripe-node TypeScript types |
| 7-day authorization window | MEDIUM | Multiple sources confirm, but exact window varies by card brand and network |
| node-cron version 4.6.0 | HIGH | npm registry confirms as latest, zero deps |
| better-sqlite3 `db.transaction()` atomicity | HIGH | Known synchronous API, SQLite ACID guarantees, search-verified |
| Outbox idempotency via UNIQUE index | HIGH | Verified pattern from distributed systems research |
| Dead-letter pattern | MEDIUM | Architectural best practice, no pre-built lib needed at this scale |

---

## Sources

- Stripe Node SDK source (stripe-node, Context7 /stripe/stripe-node)
- [Stripe Connect Separate Charges and Transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)
- [Stripe Place a Hold on a Payment Method](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)
- [Stripe Capture a PaymentIntent](https://docs.stripe.com/api/payment_intents/capture)
- [Stripe Disputes API](https://docs.stripe.com/api/disputes)
- [Stripe Build a Marketplace](https://docs.stripe.com/connect/marketplace)
- [Stripe Idempotent Requests](https://stripe.com/docs/api/idempotent_requests)
- [node-cron npm](https://www.npmjs.com/package/node-cron)
- [Venue Booking Service LLD — techinterview.org](https://www.techinterview.org/post/3233470563/lld-venue-booking/)
- [Transactional Outbox Pattern — theburningmonk.com](https://theburningmonk.com/2026/05/inbox-outbox-patterns-for-reliable-event-processing/)
- [Stripe Connect Authorize-Then-Capture — stumason.dev](https://stumason.dev/articles/stripe-connect-authorize-then-capture)
- [Handling Payment Webhooks Reliably — Medium](https://medium.com/@sohail_saifii/handling-payment-webhooks-reliably-idempotency-retries-validation-69b762720bf5)
