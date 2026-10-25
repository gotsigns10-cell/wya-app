# Architecture Patterns

**Domain:** Hyperlocal vendor marketplace — adding venue/organizer accounts, full booking transaction lifecycle, Outbox hardening, and Hub visibility
**Researched:** 2026-07-31
**Source:** Direct codebase analysis of index.js (10,279 lines), shared/outbox.js, lib/customer-sync.js, ems/index.js

---

## Existing Architecture Baseline

Before designing anything new, the actual state of the system must be understood precisely.

### What Already Exists

**Three role namespaces already present in the database:**
- `vendors` table — full auth stack (sessions, password_hash, bcrypt)
- `customers` table — full auth stack (customer_sessions, password_hash, bcrypt)
- Organizers — NO auth table. Currently identified only by `organizer_email` field in `vendor_events`. No login, no session, no password. They are glorified form-filler accounts.

**Event system already partially built:**
- `vendor_events` table with `event_type = 'organizer'` discriminator
- `event_bookings` table handles both customer RSVPs (`user_type = 'customer'`) and vendor applications (`user_type = 'vendor'`)
- `POST /api/events/request` — unauthenticated organizer event creation (no auth)
- `POST /api/events/:id/apply` — vendor applies to organizer event
- Paid event bookings exist for customers (Stripe checkout, webhook confirmation, EMS billing sync)

**Stripe Connect already wired for vendors:**
- `stripe_connect_id`, `stripe_connect_onboarded` columns on vendors
- Transfer endpoint: `POST /api/vendor/connect/transfer`
- Event ticket payout at webhook line 9095 (fire-and-forget, not idempotent)

**Outbox pattern:**
- `Outbox` class in `shared/outbox.js` — SQLite-backed per-product
- `CustomerSync` wraps Outbox for EMS customer upsert + billing record
- Two instances in wya-app: `_customerSyncWya` (product: 'wya') and `_customerSyncVendor` (product: 'wya-vendor')
- Current gap: `enqueue()` is NOT wrapped in a transaction with the parent business operation. The business row commits, then `enqueue()` runs as a separate SQLite statement. If the process crashes between the two, the outbox entry is lost.

**Hub integration (current pattern):**
- Fire-and-forget HTTP POST to `localhost:3700/api/internal/notify`
- Payload: `{ tenant_user_id, type, title, message, action_url }`
- Only triggered for order paid events (line 6013). No booking events, no catering events, no vendor application events.

---

## Recommended Architecture

### Component Map

```
wya-app (port 3422 — single Express process)
│
├── AUTH LAYER
│   ├── vendors table + sessions          [EXISTING]
│   ├── customers table + customer_sessions [EXISTING]
│   └── organizers table + organizer_sessions [NEW — mirrors vendor auth pattern]
│
├── EVENT MARKETPLACE
│   ├── vendor_events table              [EXISTING — extend]
│   ├── event_bookings table             [EXISTING — extend]
│   ├── booking_state_log table          [NEW — audit trail for state machine]
│   └── marketplace_transactions table   [NEW — full lifecycle record]
│
├── OUTBOX (hardened)
│   ├── shared/outbox.js                 [MODIFY — add idempotency_key, atomic helper]
│   ├── outbox-wya.db                    [EXISTING]
│   └── outbox-wya-vendor.db             [EXISTING]
│
├── SYNC LAYER
│   ├── CustomerSync (EMS)               [EXISTING — add organizer product]
│   └── Hub notify (fire-and-forget)     [EXTEND — add booking + venue events]
│
└── ADMIN / ANALYTICS
    ├── /api/admin/*                     [EXISTING — extend with venue/booking views]
    └── /api/internal/stats              [EXISTING — extend with booking metrics]
```

---

## 1. Database Schema Design

### 1a. Organizer Auth (New Tables)

These mirror the vendor auth pattern exactly. Do NOT reuse vendor tables — roles must stay separate for auth middleware, rate limiting, and Hub visibility.

```sql
-- organizers table: mirrors vendors structure, simplified
CREATE TABLE IF NOT EXISTS organizers (
  id TEXT PRIMARY KEY,                    -- 'ORG-' + nanoid(8)
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT DEFAULT '',
  description TEXT DEFAULT '',
  photo_url TEXT DEFAULT '',
  website TEXT DEFAULT '',
  instagram TEXT DEFAULT '',
  stripe_customer_id TEXT,
  password_version INTEGER DEFAULT 2,     -- bcrypt from day 1
  email_verified INTEGER DEFAULT 0,
  verification_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen TEXT
);

CREATE INDEX IF NOT EXISTS idx_organizers_email ON organizers(email);

-- organizer_sessions table: mirrors sessions/customer_sessions pattern
CREATE TABLE IF NOT EXISTS organizer_sessions (
  token TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_organizer_sessions_organizer ON organizer_sessions(organizer_id);
CREATE INDEX IF NOT EXISTS idx_organizer_sessions_expires ON organizer_sessions(expires_at);
```

**Migration path:** The existing `vendor_events.organizer_email` field becomes a linking field during transition. After an organizer registers with the same email, link their `organizer_id` to existing events via a migration:

```sql
-- Migration: link existing events to organizer accounts after registration
ALTER TABLE vendor_events ADD COLUMN organizer_id TEXT REFERENCES organizers(id);
CREATE INDEX IF NOT EXISTS idx_vendor_events_organizer ON vendor_events(organizer_id);
```

### 1b. Booking State Log (New Table)

The existing `event_bookings` table has a `status` field but no history. The booking state machine requires an audit trail.

```sql
CREATE TABLE IF NOT EXISTS booking_state_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES event_bookings(id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  actor_type TEXT NOT NULL,               -- 'organizer', 'vendor', 'customer', 'stripe', 'system'
  actor_id TEXT,
  note TEXT DEFAULT '',
  ts TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bsl_booking ON booking_state_log(booking_id, ts DESC);
```

### 1c. Marketplace Transactions (New Table)

This is the primary record for Hub visibility. Every complete booking transaction — from organizer request through vendor payout — needs a single row that Hub can query. This avoids Hub needing to join across vendor_events + event_bookings + vendor_commissions.

```sql
CREATE TABLE IF NOT EXISTS marketplace_transactions (
  id TEXT PRIMARY KEY,                    -- 'MKT-' + nanoid(10)
  transaction_type TEXT NOT NULL,         -- 'venue_booking', 'catering_contract', 'event_ticket'
  state TEXT NOT NULL DEFAULT 'initiated', -- full state machine (see below)

  -- Parties
  organizer_id TEXT REFERENCES organizers(id),
  organizer_email TEXT DEFAULT '',        -- fallback for pre-auth organizers
  vendor_id TEXT REFERENCES vendors(id),
  customer_id TEXT REFERENCES customers(id),

  -- Event reference
  event_id INTEGER REFERENCES vendor_events(id),
  booking_id INTEGER REFERENCES event_bookings(id),
  catering_request_id INTEGER REFERENCES catering_requests(id),

  -- Financials
  gross_amount_cents INTEGER DEFAULT 0,
  deposit_amount_cents INTEGER DEFAULT 0,
  platform_fee_cents INTEGER DEFAULT 0,   -- WYA commission
  vendor_payout_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'usd',

  -- Stripe
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_transfer_id TEXT,

  -- Outbox idempotency
  outbox_key TEXT UNIQUE,                 -- prevents duplicate EMS syncs

  -- Metadata
  hub_notified_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mkt_state ON marketplace_transactions(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_vendor ON marketplace_transactions(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_organizer ON marketplace_transactions(organizer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_event ON marketplace_transactions(event_id);
CREATE INDEX IF NOT EXISTS idx_mkt_outbox_key ON marketplace_transactions(outbox_key);
```

### 1d. Catering Request Extension

The existing `catering_requests` table needs a deposit mechanism and marketplace_transaction link:

```sql
-- Add via idempotent migration pattern (matches existing migration[] array)
"ALTER TABLE catering_requests ADD COLUMN organizer_id TEXT REFERENCES organizers(id)"
"ALTER TABLE catering_requests ADD COLUMN deposit_amount_cents INTEGER DEFAULT 0"
"ALTER TABLE catering_requests ADD COLUMN deposit_paid_at TEXT"
"ALTER TABLE catering_requests ADD COLUMN marketplace_transaction_id TEXT"
"ALTER TABLE catering_requests ADD COLUMN stripe_checkout_session_id TEXT"
```

---

## 2. Booking State Machine

### 2a. State Definitions for `venue_booking` (Organizer-initiated)

```
STATES:
  initiated          — Organizer posted event, no vendor committed
  vendor_applied     — One or more vendors applied (event_bookings status='pending')
  vendor_approved    — Organizer approved specific vendor(s) (event_bookings status='approved')
  deposit_pending    — Stripe checkout session created for organizer deposit
  deposit_paid       — Stripe webhook confirmed deposit (marketplace_transactions.deposit_amount_cents > 0)
  confirmed          — Both parties confirmed, deposit cleared, vendors notified
  in_progress        — Event date reached
  completed          — Event finished, vendor payout triggered
  cancelled          — Cancelled before completion (refund logic varies)
  disputed           — Payment dispute opened

VALID TRANSITIONS (enforced in a single helper function):
  initiated       → vendor_applied   (vendor submits application)
  vendor_applied  → vendor_approved  (organizer approves vendor)
  vendor_applied  → initiated        (organizer rejects all, reopens)
  vendor_approved → deposit_pending  (organizer initiates deposit payment)
  deposit_pending → deposit_paid     (Stripe webhook: checkout.session.completed)
  deposit_pending → vendor_approved  (Stripe session expired, back to approved)
  deposit_paid    → confirmed        (system auto-confirms on deposit receipt)
  confirmed       → in_progress      (event date reached — daily cron or on-demand)
  in_progress     → completed        (organizer or system marks complete)
  completed       → (terminal)
  any non-terminal → cancelled
  confirmed       → disputed         (Stripe dispute opened)
```

### 2b. State Machine Implementation Pattern

Do NOT build a state machine framework. Use a single synchronous function that validates the transition and writes both the state update and the audit log inside a better-sqlite3 transaction:

```javascript
/**
 * Transition a marketplace_transaction to a new state.
 * Atomically updates state + writes booking_state_log entry.
 * Returns { ok: true } or throws with reason.
 *
 * Call this wherever state changes happen — Stripe webhook, vendor approval, etc.
 */
const VALID_TRANSITIONS = {
  'initiated':       new Set(['vendor_applied', 'cancelled']),
  'vendor_applied':  new Set(['vendor_approved', 'initiated', 'cancelled']),
  'vendor_approved': new Set(['deposit_pending', 'cancelled']),
  'deposit_pending': new Set(['deposit_paid', 'vendor_approved', 'cancelled']),
  'deposit_paid':    new Set(['confirmed']),
  'confirmed':       new Set(['in_progress', 'cancelled', 'disputed']),
  'in_progress':     new Set(['completed', 'cancelled', 'disputed']),
};

function transitionBooking(db, txnId, toState, actorType, actorId, note = '') {
  const updateTxn = db.transaction(() => {
    const txn = db.prepare('SELECT id, state, booking_id FROM marketplace_transactions WHERE id=?').get(txnId);
    if (!txn) throw new Error(`Transaction ${txnId} not found`);

    const allowed = VALID_TRANSITIONS[txn.state];
    if (!allowed || !allowed.has(toState)) {
      throw new Error(`Invalid transition: ${txn.state} → ${toState}`);
    }

    db.prepare(
      `UPDATE marketplace_transactions SET state=?, updated_at=datetime('now') WHERE id=?`
    ).run(toState, txnId);

    if (txn.booking_id) {
      db.prepare(
        `INSERT INTO booking_state_log (booking_id, old_status, new_status, actor_type, actor_id, note)
         VALUES (?,?,?,?,?,?)`
      ).run(txn.booking_id, txn.state, toState, actorType, actorId, note);
    }

    return txn;
  });

  return updateTxn();
}
```

### 2c. State Machine for `catering_contract`

```
STATES:
  requested      — Customer/organizer submitted catering inquiry
  quoted         — Vendor responded with price
  deposit_pending — Stripe checkout for deposit (50% of quoted amount)
  deposit_paid   — Deposit confirmed
  confirmed      — Catering contract confirmed
  completed      — Event happened, final payment cleared
  declined       — Vendor declined
  cancelled      — Either party cancelled
```

This reuses the same `transitionBooking()` function with a different `VALID_TRANSITIONS` map. The catering path maps to existing `catering_requests` status field — the marketplace_transactions row becomes the authoritative state record; catering_requests is updated as a side effect.

---

## 3. Outbox Hardening

### 3a. Current Gaps (from code analysis)

1. **Non-atomic enqueue:** `enqueue()` runs after the business INSERT commits. A crash between them drops the event.
2. **No idempotency key:** `outbox` table has no deduplication. If the same business event triggers twice (e.g., Stripe webhook retry), a second entry is inserted.
3. **No dead-letter visibility:** Failed items (`status = 'failed'`) sit silently in the database with no alert or admin endpoint.
4. **No retention/cleanup:** `outbox` tables grow indefinitely. `completed` rows are never pruned.
5. **No cross-product outbox key:** `marketplace_transactions.outbox_key` cannot currently be checked before enqueuing.

### 3b. Atomic Enqueue Helper (Modify shared/outbox.js)

Add a method that accepts an existing SQLite transaction function, running the enqueue inside the caller's transaction:

```javascript
/**
 * enqueueAtomic — enqueue inside an existing db.transaction() context.
 * The caller MUST be inside a better-sqlite3 transaction already.
 * This inserts the outbox row in the same WAL checkpoint as the business row.
 *
 * Usage:
 *   const insertOrder = db.transaction(() => {
 *     db.prepare('INSERT INTO orders ...').run(...);
 *     outbox.enqueueAtomic(db, url, { body });
 *   });
 *   insertOrder();
 */
enqueueAtomic(db, url, { method = 'POST', headers = {}, body = null, idempotencyKey = null } = {}) {
  // If idempotency key provided, skip if already queued or completed
  if (idempotencyKey) {
    const existing = db.prepare(
      `SELECT id, status FROM outbox WHERE idempotency_key = ? AND status IN ('pending', 'completed')`
    ).get(idempotencyKey);
    if (existing) return existing.id; // already in flight or done
  }

  const result = db.prepare(
    `INSERT INTO outbox (url, method, headers, body, next_retry_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    url,
    method,
    JSON.stringify(headers),
    body ? JSON.stringify(body) : null,
    Date.now(),
    idempotencyKey || null
  );
  return result.lastInsertRowid;
}
```

The `outbox` table also needs the `idempotency_key` column:

```sql
-- Add to Outbox constructor schema
ALTER TABLE outbox ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_ikey ON outbox(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

### 3c. Dead Letter Reconciliation

Add a reconciliation endpoint to the admin API. This is NOT a new service — it's a new route in the existing admin block:

```
GET  /api/admin/outbox/stats        — counts per product outbox (pending/failed/completed)
GET  /api/admin/outbox/failed       — list failed items with last_error, url, attempts
POST /api/admin/outbox/retry/:id    — manually reset status='pending', next_retry_at=now
POST /api/admin/outbox/purge-failed — bulk delete failed items older than N days
```

The admin endpoints read directly from the outbox SQLite files (same process, different db handles).

### 3d. Retention Cleanup

Add a scheduled cleanup alongside the existing profile_views cleanup (line 9708):

```javascript
// Outbox retention — purge completed rows older than 30 days
// Prevents outbox-*.db files from growing unbounded
setInterval(() => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    _customerSyncWya._outbox.db.prepare(
      `DELETE FROM outbox WHERE status = 'completed' AND completed_at < ?`
    ).run(cutoff);
    _customerSyncVendor._outbox.db.prepare(
      `DELETE FROM outbox WHERE status = 'completed' AND completed_at < ?`
    ).run(cutoff);
  } catch (e) {
    console.error('[OUTBOX-CLEANUP]', e.message);
  }
}, 6 * 60 * 60 * 1000); // every 6h
```

### 3e. Idempotency Key Convention

Use the pattern `{product}:{entity_type}:{entity_id}:{event_type}` for all new outbox enqueues:

```
wya:order:ORD-abc123:payment_completed
wya:booking:MKT-xyz456:deposit_paid
wya:catering:88:quoted
wya-vendor:vendor:VENDOR-001:subscription_activated
```

This makes deduplication deterministic across Stripe webhook retries.

---

## 4. Hub Integration Pattern

### 4a. Current State

The only Hub notification in wya-app is a fire-and-forget HTTP POST in the order flow (line 6013). It sends a generic notification. Hub sees WYA as "last order amount" only — there is no transaction chain visibility.

### 4b. Target: Full Transaction Chain Visibility

Hub needs to show the complete marketplace lifecycle. The integration pattern stays fire-and-forget (Hub is not in the critical path), but the events must be structured enough for Hub to build a timeline.

**Enhanced Hub notification payload:**

```javascript
function notifyHub(eventType, payload) {
  // Fire-and-forget — never blocks the request
  try {
    const body = JSON.stringify({
      source: 'wya',
      event_type: eventType,         // 'order.paid', 'booking.deposit_paid', 'booking.completed', etc.
      tenant_user_id: payload.tenant_user_id || 'sergio',
      title: payload.title,
      message: payload.message,
      action_url: payload.action_url || '/my/wya',
      metadata: payload.metadata || {},  // { transaction_id, amount_cents, vendor_name, organizer_name }
      ts: new Date().toISOString()
    });
    const req = http.request({
      hostname: '127.0.0.1', port: 3700,
      path: '/api/internal/notify',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000
    }, () => {});
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}
```

**Events to notify Hub on:**

| WYA Event | Hub event_type | Notify Who |
|-----------|---------------|------------|
| Order placed | `order.created` | Vendor's Hub account |
| Order paid (Stripe webhook) | `order.paid` | Vendor + admin |
| Vendor applied to event | `booking.vendor_applied` | Organizer (if they have Hub) + admin |
| Organizer approved vendor | `booking.vendor_approved` | Vendor |
| Deposit paid (Stripe webhook) | `booking.deposit_paid` | Vendor + organizer + admin |
| Booking confirmed | `booking.confirmed` | All parties |
| Booking completed | `booking.completed` | All parties + EMS billing |
| Catering quoted | `catering.quoted` | Requester |
| Catering deposit paid | `catering.deposit_paid` | Vendor + admin |

**Hub transaction chain endpoint (new, in wya-app admin block):**

```
GET /api/admin/marketplace/transactions
  ?state=confirmed&vendor_id=X&organizer_id=Y&limit=50&offset=0

Response:
{
  transactions: [{
    id, state, transaction_type,
    vendor_name, organizer_name,
    gross_amount_cents, deposit_amount_cents, platform_fee_cents,
    event_title, event_date,
    created_at, completed_at
  }],
  totals: { count, gross_amount_cents, platform_fee_cents }
}
```

Hub can poll this endpoint (or EMS can proxy it) for the WYA product health card.

### 4c. EMS Integration for Organizer Accounts

Add `'wya-organizer'` as a valid product in CustomerSync's VALID_PRODUCTS set and instantiate a third CustomerSync:

```javascript
// In wya-app index.js — alongside existing _customerSyncWya/_customerSyncVendor
const _customerSyncOrganizer = new CustomerSync('wya-organizer');

function emsSyncOrganizer(email, name, phone) {
  _customerSyncOrganizer.syncCustomer({ email, name, phone });
}
```

The outbox key for organizer syncs follows the same convention. The organizer is treated as a third customer segment in EMS for marketing and lifecycle emails.

---

## 5. Build Order

The dependencies between features dictate this exact order. Each step is buildable without breaking the 270+ existing endpoints.

### Step 1: Outbox Hardening (No user-facing risk, pure infrastructure)

**Why first:** Every subsequent step relies on reliable event delivery to EMS and Hub. Hardening the outbox first means deposits, bookings, and organizer signups all get durable delivery from day one.

**What to build:**
1. Add `idempotency_key` column to outbox schema (idempotent migration)
2. Add `enqueueAtomic()` method to `Outbox` class
3. Add outbox retention cleanup interval
4. Add `GET /api/admin/outbox/stats` + `GET /api/admin/outbox/failed` + `POST /api/admin/outbox/retry/:id`
5. Add `CustomerSync` for `wya-organizer` product (prep for Step 2)

**Existing endpoints affected:** None — all additive.

### Step 2: Organizer Auth (Isolated new role, no existing endpoint changes)

**Why second:** Venue/organizer is the demand-side of the marketplace. Everything else (vendor applications, deposit payments) requires an authenticated organizer to own the transaction.

**What to build:**
1. Create `organizers` + `organizer_sessions` tables
2. `getOrganizerByToken()` helper — mirrors `getVendorByToken()` and `getCustomerByToken()` patterns
3. Auth endpoints:
   - `POST /api/organizer/register` (bcrypt, email verify, EMS sync via outbox)
   - `POST /api/organizer/login`
   - `POST /api/organizer/logout`
   - `GET /api/organizer/profile`
   - `PUT /api/organizer/profile`
4. `requireOrganizer` middleware — same pattern as existing vendor middleware
5. Migration: `ALTER TABLE vendor_events ADD COLUMN organizer_id`
6. `emsSyncOrganizer()` call in register flow (using `_customerSyncOrganizer`)

**Existing endpoints affected:** None — pure addition.

### Step 3: Marketplace Transactions Table + State Machine

**Why third:** The transaction table is the backbone Hub needs. Build it before wiring any Stripe flows so every payment has a record from the start.

**What to build:**
1. Create `marketplace_transactions` + `booking_state_log` tables
2. `transitionBooking()` helper function
3. `POST /api/organizer/events` — authenticated organizer event creation (replaces public `POST /api/events/request` for organizers)
4. Seed `marketplace_transactions` row when organizer posts an event (`state = 'initiated'`)
5. Upgrade `POST /api/events/:id/apply` to write to `booking_state_log` + transition transaction to `vendor_applied`
6. `POST /api/organizer/events/:id/approve/:bookingId` — approve vendor, transition to `vendor_approved`

**Existing endpoints affected:**
- `POST /api/events/request` — keep as public alias, but wire it to create a marketplace_transaction and optionally link to organizer_id after Step 2 auth exists.
- `POST /api/events/:id/apply` — add booking_state_log write (additive).

### Step 4: Deposit Payment (Stripe integration for bookings)

**Why fourth:** Requires marketplace_transactions from Step 3. This is the "host pays" model — organizer pays a deposit to confirm the booking.

**What to build:**
1. Catering request deposit fields (idempotent migrations)
2. `POST /api/organizer/bookings/:txnId/deposit` — create Stripe checkout for deposit
   - `metadata: { marketplace_transaction_id, transaction_type: 'venue_booking' }`
   - `enqueueAtomic()` outbox entry inside transaction (idempotency key: `wya:booking:{txnId}:deposit_initiated`)
3. Stripe webhook handler extension:
   - New `else if (meta.marketplace_transaction_id)` branch in `checkout.session.completed`
   - Call `transitionBooking()` to `deposit_paid` then `confirmed`
   - EMS billing sync via atomic outbox enqueue (idempotency key: `wya:booking:{txnId}:deposit_paid`)
   - Hub notification via `notifyHub('booking.deposit_paid', ...)`
4. `POST /api/organizer/catering/:id/deposit` — same pattern for catering contracts

**Existing endpoints affected:**
- Stripe webhook handler (lines 8914+) — add new `metadata.marketplace_transaction_id` branch. Existing branches (`meta.order_id`, `meta.vendor_id`, `meta.event_booking_id`) remain untouched.

### Step 5: Hub Visibility + Admin Transaction View

**Why fifth:** Requires transactions (Step 3) and deposits (Step 4) to have data worth showing.

**What to build:**
1. Enhanced `notifyHub()` function (replace fire-and-forget one-liner)
2. Wire Hub notifications for all booking state transitions
3. `GET /api/admin/marketplace/transactions` — transaction chain view
4. `GET /api/admin/marketplace/metrics` — liquidity metrics (conversion rates, avg deposit, fill rate)
5. `GET /api/organizer/bookings` — organizer's own transaction history
6. Wire EMS billing for completed bookings via `emsBillingRecord()` with atomic outbox

**Existing endpoints affected:**
- `GET /api/admin/stats` (line 4504) — add marketplace metrics to response (additive)

### Step 6: Launch Operations

**Why last:** Requires all the infrastructure above to be validated first.

**What to build:**
1. Founding vendor invitation flow improvements
2. Managed catering desk admin endpoints (`POST /api/admin/catering/:id/manage`)
3. Marketplace liquidity dashboard (`GET /api/admin/marketplace/liquidity`)
4. Organizer outreach drip (via n8n + EMS, not new code in wya-app)
5. `POST /api/organizer/events/:id/complete` — mark event done, trigger vendor payout

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: New Auth Table Per Micro-Entity

**What:** Creating separate "venue" and "organizer" tables as distinct roles.
**Why bad:** Multiplies auth middleware, session cleanup, and EMS sync paths.
**Instead:** One `organizers` table covers both venue owners and event organizers. The distinction is in the event type (`event_type = 'venue'` vs `event_type = 'community'`), not the account type.

### Anti-Pattern 2: Rebuilding the Outbox as a Queue Service

**What:** Spinning up a separate Redis/BullMQ/RabbitMQ service for Outbox hardening.
**Why bad:** Violates ARCH FREEZE (no new PM2 services). SQLite WAL handles single-process concurrency fine. wya-app is a single process with a single db connection.
**Instead:** Atomic enqueue with better-sqlite3 transactions. The process never has more than one Outbox consumer (the `setInterval`), so there is no concurrency problem to solve.

### Anti-Pattern 3: State Machine in Application State (not DB)

**What:** Tracking booking state in memory/Redis, writing to DB asynchronously.
**Why bad:** Process restart loses in-flight state. Stripe webhooks arrive out of order.
**Instead:** DB is always the source of truth. Every state transition is a synchronous SQLite write inside a better-sqlite3 transaction. Memory state is only a cache.

### Anti-Pattern 4: Stripe Webhook as the Only State Driver

**What:** Allowing state transitions ONLY when Stripe fires a webhook.
**Why bad:** Stripe webhooks can be delayed 5-60 minutes. Organizers need immediate feedback.
**Instead:** Create the `deposit_pending` state immediately on checkout session creation. Drive the state to `deposit_paid` in the webhook. Expose `GET /api/organizer/bookings/:txnId/status` for polling.

### Anti-Pattern 5: Reusing `vendor_events.organizer_email` as the Sole Organizer Identity

**What:** Keeping organizer as a nameless email address, not building auth.
**Why bad:** StreetFoodFinder's moat is venue/organizer relationships. An email address cannot own a dashboard, see transaction history, or receive notifications reliably.
**Instead:** Migrate to `organizer_id` FK after Step 2. Keep `organizer_email` as fallback for legacy events only.

### Anti-Pattern 6: Hub Notification in the Critical Path

**What:** Making Hub `POST /api/internal/notify` a required step in the Stripe webhook handler.
**Why bad:** Hub going down would cause Stripe webhook handler to fail, blocking order processing.
**Instead:** Keep Hub notifications fire-and-forget with 3-second timeout. Hub reads transaction data from `marketplace_transactions` table directly via `GET /api/admin/marketplace/transactions` for its dashboard; notifications are advisory only.

---

## Scalability Considerations

| Concern | Current (10 vendors) | After launch (100 venues) | Notes |
|---------|---------------------|--------------------------|-------|
| SQLite WAL write throughput | Fine | Fine | Single writer, sequential writes, WAL checkpoint every 1000 pages |
| marketplace_transactions table | 0 rows | ~5,000/year | Trivial for SQLite with indexes |
| booking_state_log | 0 rows | ~25,000/year | Append-only, indexed by booking_id |
| Outbox DB size | Small | ~50MB/year if not cleaned | Retention cleanup every 6h handles this |
| Hub notification latency | 3s timeout | 3s timeout | Fire-and-forget, not blocking |
| Stripe webhook delivery | 1/event | Multiple retries | Idempotency key prevents double-processing |

SQLite is the correct choice for this scale. The ecosystem is explicitly SQLite-spine. Migration to Postgres would require a full rewrite and violates the constraints.

---

## Component Boundaries: New vs Modified

| Component | Status | File Change | Risk |
|-----------|--------|-------------|------|
| `organizers` + `organizer_sessions` tables | NEW | index.js: new db.exec() block | None |
| `booking_state_log` table | NEW | index.js: new db.exec() block | None |
| `marketplace_transactions` table | NEW | index.js: new db.exec() block | None |
| `transitionBooking()` helper | NEW | index.js: new function | None |
| `enqueueAtomic()` method | NEW | shared/outbox.js: add method | Low |
| `idempotency_key` column | NEW | shared/outbox.js: schema change | Low — additive migration |
| Organizer auth endpoints | NEW | index.js: ~10 new routes | None |
| `POST /api/events/request` | MODIFY | index.js: add txn creation | Low |
| `POST /api/events/:id/apply` | MODIFY | index.js: add state log write | Low |
| Stripe webhook handler | MODIFY | index.js line 8914+: new branch | Medium — test with Stripe CLI |
| Hub `notifyHub()` | MODIFY | index.js: refactor one-liner | Low |
| CustomerSync | MODIFY | lib/customer-sync.js: add wya-organizer to VALID_PRODUCTS | Trivial |
| EMS | NONE | No changes needed | — |
| Hub (port 3700) | NONE | Hub reads from wya-app endpoints, no Hub code changes | — |
| any new PM2 service | BLOCKED | ARCH FREEZE | — |

---

## Data Flow: Full Booking Transaction Chain

```
1. Organizer registers (POST /api/organizer/register)
   → organizers row created
   → organizer_sessions token issued
   → [OUTBOX ATOMIC] EMS upsert: wya-organizer product

2. Organizer posts event (POST /api/organizer/events)
   → vendor_events row (event_type='organizer', organizer_id=X)
   → marketplace_transactions row (state='initiated')
   → Push notify: active vendors in area
   → Hub notify: 'booking.initiated'

3. Vendor applies (POST /api/events/:id/apply)
   → event_bookings row (status='pending')
   → booking_state_log entry (initiated → vendor_applied)
   → marketplace_transactions.state = 'vendor_applied'
   → Email: organizer notified of application

4. Organizer approves (POST /api/organizer/events/:id/approve/:bookingId)
   → event_bookings status = 'approved'
   → booking_state_log entry (vendor_applied → vendor_approved)
   → marketplace_transactions.state = 'vendor_approved'
   → Push/Email: vendor notified of approval

5. Organizer pays deposit (POST /api/organizer/bookings/:txnId/deposit)
   → Stripe checkout session created
   → marketplace_transactions.stripe_checkout_session_id = session.id
   → marketplace_transactions.state = 'deposit_pending'
   → [OUTBOX ATOMIC] EMS note: deposit_pending
   → Redirect organizer to Stripe hosted page

6. Stripe webhook: checkout.session.completed (metadata.marketplace_transaction_id)
   → transitionBooking(db, txnId, 'deposit_paid', 'stripe', session.id)
   → transitionBooking(db, txnId, 'confirmed', 'system', 'auto')
   → [OUTBOX ATOMIC] EMS billing: wya:booking:{txnId}:deposit_paid
   → Hub notify: 'booking.deposit_paid'
   → Push: vendor — "Booking confirmed, deposit received"
   → Email: organizer receipt + vendor schedule confirmation

7. Event completes (POST /api/organizer/events/:id/complete OR daily cron)
   → marketplace_transactions.state = 'completed', completed_at = now
   → Stripe Connect transfer: vendor payout (gross - platform_fee)
   → marketplace_transactions.stripe_transfer_id = transfer.id
   → [OUTBOX ATOMIC] EMS billing: wya:booking:{txnId}:completed
   → Hub notify: 'booking.completed'
   → vendor_commissions row created for accounting

8. Hub reads chain (GET /api/admin/marketplace/transactions)
   → Single query across marketplace_transactions + vendor_events + vendors + organizers
   → Returns structured timeline for Hub WYA product card
```

---

## Sources

- Direct code analysis: `/root/universoul-ecosystem/wya-app/index.js` (lines 500–10279)
- Outbox implementation: `/root/universoul-ecosystem/shared/outbox.js`
- CustomerSync implementation: `/root/universoul-ecosystem/lib/customer-sync.js`
- EMS WYA integration: `/root/universoul-ecosystem/ems/index.js` (lines 104–1567)
- Project constraints: `.planning/PROJECT.md`
- Stripe Connect payout pattern: index.js lines 9095–9113 (existing event ticket payout)
- Stripe idempotency pattern: index.js lines 8950–8954 (existing order dedup)
- Hub notification pattern: index.js line 6013 (existing fire-and-forget)
- Migration pattern: index.js lines 543–644 (existing `migrations[]` array)
