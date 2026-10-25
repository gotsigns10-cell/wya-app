# Domain Pitfalls — WYA Venue/Organizer Marketplace Milestone

**Domain:** Brownfield marketplace expansion on Express.js + SQLite
**Researched:** 2026-07-31
**Confidence:** HIGH — all pitfalls verified against actual codebase (10,279 lines, 44 tables, two outbox DBs)

---

## How to Read This File

Each pitfall includes:
- **Warning sign** — what you will see in the code or at runtime before it bites you
- **Prevention** — what to do instead
- **Phase** — which milestone phase carries this risk

Pitfalls are ordered by blast radius: Critical first, then Moderate, then Minor.

---

## Critical Pitfalls

Mistakes that cause double-charges, lost bookings, data corruption, or rewrites.

---

### Pitfall C1: Outbox Lives in a Separate Database from Business Data

**What goes wrong:**
The current `emsBillingRecord()` call happens *after* the business `db.prepare().run()` call, in a separate SQLite file (`outbox-wya.db` vs `wya.db`). There is no atomic guarantee spanning both databases. If the process crashes between the business write and the outbox enqueue, the payment is recorded in `wya.db` but the billing event is never sent to EMS/Hub. WYA thinks it collected money; Hub never sees it. For venue deposits (the core of this milestone), this is silent revenue leakage.

**Why it happens:**
The CustomerSync Outbox was built as a shared library across all ecosystem products, each with its own outbox file. This isolation was intentional for product separation, but it sacrifices the atomic commit that makes the Outbox pattern safe for financial data.

**Actual code evidence:**
```
// index.js line 8964 — these are two separate DB writes with no transaction wrapper
emsBillingRecord(billingEmail, obj.amount_total, obj.payment_intent, 'WYA order');
emsSyncCustomer(billingEmail, customer?.name || null, null, 'customer');
```
The business update (order status = paid) is in `wya.db`. The outbox enqueue goes to `outbox-wya.db`. A crash between them leaves the two DBs inconsistent.

**Consequences:**
- Hub shows $0 for a booking that succeeded in Stripe
- EMS MRR data is wrong
- No automated alert — the failure is silent
- Manual reconciliation required

**Prevention:**
Two options ranked by implementation cost:

Option A (low cost, phase-appropriate): Enqueue the outbox record *inside* the same SQLite transaction as the business write by using a SQLite ATTACH to bring the outbox table into the main DB transaction. Better-sqlite3 supports `ATTACH DATABASE` and cross-database transactions.

Option B (medium cost): Add a compensation query at startup and on a 15-minute cron that scans `wya.db` for `payment_status='paid'` orders with no corresponding outbox completion record, then re-enqueues the missing billing event.

Option B is the correct choice for the Outbox Hardening phase given ARCH FREEZE. It does not require changing the shared library, only adding a reconciler to `index.js`.

**Detection:**
```sql
-- Run on startup and every 15 min
SELECT o.id, o.stripe_payment_intent_id, o.total
FROM orders o
WHERE o.payment_status = 'paid'
  AND o.created_at > datetime('now', '-24 hours')
  AND o.stripe_payment_intent_id NOT IN (
    SELECT json_extract(body, '$.stripe_payment_id')
    FROM outbox WHERE status = 'completed'
  );
```

**Phase:** Outbox Hardening (Phase 2 or early Phase 3)

---

### Pitfall C2: Third Auth Role Reuses Existing Token Headers — Cross-Role Access

**What goes wrong:**
The current system uses two auth header conventions: `x-auth-token` (vendor) and `x-cust-token` (customer). If venue/organizer accounts are added as a third role but share a token header with either vendors or customers, any endpoint that calls `getVendorByToken()` or `getCustomerByToken()` will silently authenticate a venue user as a vendor or customer. That venue user can then read vendor analytics, trigger payout flows, or access customer order history.

**Why it happens:**
The 270 existing endpoints all pattern-match on `req.headers['x-auth-token']` or `req.headers['x-cust-token']`. There is no centralized RBAC middleware — each handler does its own `getVendorByToken()` call. When a new role is added without auditing every endpoint, endpoints that should be vendor-only silently become venue-accessible because the token lookup succeeds.

**Actual code evidence:**
```
// index.js line 2002 — vendor auth
const getVendorByToken = (token) => {
  const sess = db.prepare("SELECT * FROM sessions WHERE token=? AND ...").get(token);
  ...
};
// 150+ endpoints call getVendorByToken() — none verify the result is not a venue
```

**Consequences:**
- Venue account reads another vendor's earnings dashboard
- Venue account triggers a catering quote accept on behalf of a vendor
- Cross-tenant data breach without any visible error

**Prevention:**
1. Assign venue/organizer accounts a **distinct table** (`venues`) and a **distinct token header** (`x-venue-token`), not reusing `sessions` or `customer_sessions`.
2. Create a `getVenueByToken()` function that returns `null` when called with a vendor or customer token.
3. On all new venue endpoints, only call `getVenueByToken()` — never fall through to `getVendorByToken()`.
4. Do NOT retrofit existing endpoints. Accept that existing vendor-only endpoints are not venue-accessible by construction (separate header = separate trust boundary).

**Detection (before launch):**
Write a smoke test that: (a) registers a venue account, (b) takes its token, (c) sends it as `x-auth-token` to 5 vendor-only endpoints. All should return 401/403.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

### Pitfall C3: Venue Deposit Not Atomically Linked to Booking Record

**What goes wrong:**
The multi-party booking flow is: venue creates request → vendor accepts → deposit Stripe Checkout session is created → customer/venue pays → Stripe webhook fires → booking is confirmed. If the Stripe webhook fires but the `event_bookings` row has already been modified (e.g., cancelled by a timeout cron), the payment is captured but the booking is in an invalid state. Stripe has the money; WYA's database says the booking is cancelled.

**Why it happens:**
The existing order expiry cron (`index.js` line 9225) runs every 24 hours and cancels unpaid bookings. A deposit flow with multi-day payment windows will collide with this cron. Additionally, the current webhook handler does not verify the booking still exists before confirming and paying out. The partial idempotency checks (`Duplicate webhook for order`) cover order IDs but not booking IDs with state transitions.

**Actual code evidence:**
```
// index.js line 9225 — expires unpaid pending orders after 24h
// index.js line 9063 — idempotency check: "Duplicate event booking webhook — skipping"
// The skip is correct, but a cancelled-then-webhook sequence is not covered
```

**Consequences:**
- Money captured, venue has no booking, vendor expects to show up
- Refund must be manual via Stripe dashboard
- Potential chargeback if venue disputes the charge

**Prevention:**
1. When creating a deposit Stripe session, store `stripe_checkout_session_id` in the booking row immediately.
2. In the webhook handler, before confirming a booking from a payment event, verify the booking `status` is still in `('pending_payment', 'awaiting_deposit')`. If it is `cancelled`, immediately trigger a refund via `stripe.refunds.create()` and log to admin.
3. Extend the order expiry cron to skip bookings that have an active Stripe Checkout session (i.e., `stripe_checkout_session_id IS NOT NULL AND status != 'completed'`).
4. Add idempotency keys to all `stripe.checkout.sessions.create()` calls for booking deposits: `idempotency_key: 'deposit-booking-' + bookingId`.

**Phase:** Booking Marketplace Transaction Chain (Phase 1–2)

---

### Pitfall C4: Stripe Connect Destination Charges Do Not Cover Venue Refund Path

**What goes wrong:**
The current Stripe Connect integration uses `destination` charges (transfers to `vendor.stripe_connect_id` after capture). For simple orders this works. For a venue deposit model, the money may need to be partially refunded if a vendor cancels after deposit collection, or split between multiple vendors at a multi-vendor event. Destination charges do not support partial application fee refunds without manual platform intervention, and the refund path reverses the transfer, which can fail if the vendor's Connect account has insufficient balance.

**Why it happens:**
The existing `destination: vendor.stripe_connect_id` pattern (line 8642) was built for single-vendor, single-buyer orders. A venue deposit is a multi-party transaction where the platform holds money and disburses on event completion — that requires `on_behalf_of` + `transfer_group` or Stripe's separate charges and transfers model, not destination charges.

**Actual code evidence:**
```
// index.js line 8642
destination: vendor.stripe_connect_id,
```

**Consequences:**
- Refund on a destination charge tries to reverse the transfer from vendor's account
- Vendor's Connect account may have insufficient funds (they spent the money)
- Stripe returns a transfer reversal error; platform absorbs the cost
- No automated path; manual resolution required

**Prevention:**
For venue deposits specifically, use **separate charges and transfers** (not destination charges):
1. Charge to the platform account: `stripe.paymentIntents.create({ amount, currency })` — no `destination`.
2. Platform holds funds until event completes.
3. On completion, transfer to vendor: `stripe.transfers.create({ amount: net, destination: vendor.stripe_connect_id, transfer_group: 'event-' + eventId })`.
4. Platform refunds directly from platform account if needed — no transfer reversal required.

This is a different Stripe model from the existing order flow. **Do not change the existing order flow.** Only new venue deposit endpoints use separate charges and transfers.

**Phase:** Booking Marketplace Transaction Chain (Phase 2)

---

## Moderate Pitfalls

Mistakes that cause incorrect data, operational pain, or user confusion, but are recoverable.

---

### Pitfall M1: 10,200-Line Single File — Schema Migrations Break Silently

**What goes wrong:**
All 44 table definitions and ALTER TABLE migrations live as JavaScript arrays in `index.js`. When adding the `venues` table and associated columns, a developer adds the `CREATE TABLE` statement in one place but the ALTER TABLE guards in another. Or an existing migration (e.g., adding a column to `event_bookings` for venue deposits) runs on startup but fails silently because the column already exists from a prior manual intervention.

**Why it happens:**
The migration approach is a flat array of strings run once on startup (`db.exec()`). There is no migration versioning, no up/down tracking, and no record of which migrations ran. All migrations use `IF NOT EXISTS` or catch errors, which means a failed migration looks identical to a successful one in logs.

**Actual code evidence:**
```
// index.js line 555 — example migration
"ALTER TABLE vendors ADD COLUMN stripe_customer_id TEXT",
// These have no guard — if column exists, SQLite throws, caught, ignored
```

**Consequences:**
- Venue table added in dev but not in production after a rollback
- Schema drift between droplet and backup
- A new column used in an endpoint throws `no such column` in production

**Prevention:**
1. Add all new venue/organizer table DDL inside the existing pattern but use `CREATE TABLE IF NOT EXISTS` (not ALTER TABLE on critical columns).
2. For any new column on an existing table: wrap with a try/catch that logs explicitly `[MIGRATION] column already exists — skipping`.
3. After adding schema, add a startup health assertion: `db.prepare('SELECT venue_id FROM event_bookings LIMIT 1').get()` — if this throws, the migration failed.
4. Never run ALTER TABLE in production manually before deploying the code that expects it.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

### Pitfall M2: Password Reset Tokens Use `user_type` — Third Role Breaks the Lookup

**What goes wrong:**
The `password_reset_tokens` table has a `user_type` column that accepts `'vendor'` or `'customer'`. The reset flow checks `user_type` to know which table to update the password in. Venue accounts need password reset too. If venue accounts are implemented without updating this flow, venue users who forget their password will receive a reset email but the reset endpoint will 404 or update the wrong row.

**Actual code evidence:**
```
// index.js line 5455
const { email, user_type } = req.body;
const type = user_type === 'vendor' ? 'vendor' : 'customer'; // Default is 'customer'
// A venue user submitting user_type='venue' becomes 'customer'
```

**Consequences:**
- Venue user's password is "reset" on the `customers` table — no match found, reset silently fails
- Venue user cannot recover their account
- Support burden on day one of launch

**Prevention:**
Extend the reset flow to handle `'venue'` as a valid `user_type`. Map it to the `venues` table. Update the reset endpoint's table lookup switch. This is a 5-line change but easy to forget.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

### Pitfall M3: Organizer Email Pattern Is Already in Use — It Conflicts with Venue Accounts

**What goes wrong:**
The current system already has an "organizer" concept in `vendor_events` — with `organizer_name`, `organizer_email`, `organizer_phone` columns and `event_type='organizer'` events created via a public, no-auth endpoint. Venue accounts are the formal version of this. If Phase 1 adds formal venue accounts without migrating or deprecating the anonymous organizer pattern, you will have two organizer systems: anonymous (existing) and authenticated (new). Every venue-related endpoint must check which model applies.

**Actual code evidence:**
```
// index.js line 2638 — Organizer: Post event requesting vendors (public, no auth)
// index.js line 2666 — Organizer event image upload (uses organizer_email as ownership proof)
// No session, no account — just email as identity
```

**Consequences:**
- Venue accounts cannot claim/migrate events created under the anonymous organizer pattern
- Data model has two parallel event ownership concepts
- Admin dashboard shows anonymous organizer events with no account to bill

**Prevention:**
In Phase 1, explicitly decide: anonymous organizer endpoints are sunset in favor of venue accounts, OR they remain for "guest" organizers with a link to upgrade to a venue account. Document this decision in PROJECT.md. Do not leave both paths live without explicit ownership semantics. The recommended path is: anonymous organizer creates event, system sends email with "claim as venue account" link, venue account creation migrates the event ownership.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

### Pitfall M4: Push Notifications Are Fire-and-Forget — Venue Users Have No Subscription Table

**What goes wrong:**
The `push_subscriptions` table has a `user_type` column that accepts `'vendor'` or `'customer'`. Venue users registering for push notifications will fail silently unless `user_type='venue'` is explicitly handled. The `sendNotif()` helper at line 7538 does `db.prepare('SELECT * FROM push_subscriptions WHERE user_id=? AND user_type=?')` — a venue user will receive 0 subscriptions and no notification.

**Prevention:**
When building the venue dashboard, add `user_type='venue'` support to the push subscription endpoint (line 7508) and to `sendNotif()`. This is a two-line change but easily missed.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

### Pitfall M5: Outbox Has No Retention — Failed Records Accumulate Forever

**What goes wrong:**
The Outbox implementation marks records as `status='failed'` after 5 attempts and stops retrying. There is no cleanup job. Over time, `outbox-wya.db` and `outbox-wya-vendor.db` accumulate thousands of permanently-failed rows. The `stats()` method reports the count, but nothing alerts on it or cleans it up. When venue deposits start flowing through, any EMS downtime will spike the failed count. The accumulated records eventually slow the `processPending()` query (which scans the full table).

**Actual code evidence:**
```
// outbox.js — no DELETE from outbox WHERE status='completed' or status='failed'
// outbox.js line 67 — failed records just sit with status='failed' forever
```

**Prevention:**
Add to the existing session cleanup cron (line 1830):
```javascript
// Purge completed outbox records older than 7 days
// Purge failed outbox records older than 30 days (after manual review)
```
Also add an alert: if `outbox.stats().failed > 10`, log a `[OUTBOX ALERT]` that surfaced in PM2 logs and triggers a Soul notification.

**Phase:** Outbox Hardening (Phase 2)

---

### Pitfall M6: Hub Receives Billing Events But Has No Venue Transaction Type

**What goes wrong:**
The EMS billing record payload has a `event_type: 'payment'` field and a `product` field. Hub's analytics dashboard categorizes WYA transactions as order revenue. When venue deposits start flowing through `emsBillingRecord()`, Hub will show them as undifferentiated "WYA order revenue" — indistinguishable from food truck orders. Marketplace health metrics (deposit volume, event completion rate, venue GMV) will be invisible.

**Why it matters:**
The PROJECT.md north star is: "One real venue generates demand > WYA matches a real vendor > deposit is paid > event completes > Stripe Connect pays vendor > WYA retains fee > **Hub records full chain**." If Hub cannot distinguish the chain, the north star is unverifiable.

**Prevention:**
1. Extend the `emsBillingRecord()` call for venue deposits to include a `description` field that encodes the transaction type: `'WYA venue deposit — event_id:123'`.
2. Define a Hub query/filter convention for venue transactions early (before launch) so analytics are correct from the first real deposit.
3. If the EMS billing endpoint supports a `category` or `type` field, add it. If not, the `description` string pattern is the fallback.

**Phase:** Hub Visibility (Phase 3)

---

### Pitfall M7: Cold Start Asymmetry — Venue Supply Before Vendor Supply Kills Liquidity

**What goes wrong:**
The launch plan prioritizes onboarding venues/organizers (demand generators) before ensuring vendor supply is ready. A venue posts an event requesting 3 food trucks. Only 1 vendor is on WYA and available for that date. The event cannot be fulfilled. The venue has a bad experience and does not return. This is the "supply before demand" cold start inversion — the one documented marketplace post-mortem finding with a failure rate above 60%.

**Why it happens:**
It is easier to recruit venues (one point of contact, one event creates multiple vendor slots) than vendors (each vendor must onboard individually, set up Stripe Connect, build a menu). The asymmetry makes venues feel like the faster win.

**Consequences:**
- Venue posts unfilled events → loses confidence → leaves
- Vendors see no inbound booking requests → question value → leave
- Marketplace dies without ever having a working transaction

**Prevention:**
The founding vendor cohort must be confirmed and Stripe-Connect-onboarded before the first venue invitation goes out. Define a minimum supply threshold before venue recruitment begins (suggested: 5 Stripe-Connect-onboarded vendors covering at least 3 cuisine/service categories in Santa Barbara). The managed catering desk model is the correct hedge: Sergio manually matches vendors to venues while the marketplace achieves liquidity.

**Detection:** Track `stripe_connect_onboarded=1` count daily. Do not send venue invitation emails until count >= 5.

**Phase:** Launch Operations (Phase 4)

---

### Pitfall M8: Catering Request Upgrade Path Is Undefined

**What goes wrong:**
The existing `catering_requests` table is a direct vendor-to-customer inquiry system (customer submits, vendor responds with a quote). The new booking marketplace is a venue-to-vendor system (venue posts a slot, vendor applies, deposit is paid). These are parallel flows for similar use cases. If the catering request system is left unchanged while the marketplace is added, vendors will receive both catering requests and marketplace applications as separate UX flows with separate dashboards. Vendors will be confused about which to use for which scenario.

**Prevention:**
Define the boundary explicitly before building:
- `catering_requests` = direct customer inquiry to a specific vendor (existing, keep unchanged)
- Venue marketplace booking = open vendor slot posted by a venue (new)

Document this in vendor-facing copy and in the vendor dashboard UI. Do not try to merge the two into one flow — they have different actors and different payment models.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

## Minor Pitfalls

Mistakes that add technical debt or cause confusion but do not break transactions.

---

### Pitfall N1: Admin Dashboard Has No Venue Visibility

The admin dashboard at `/admin` counts vendors, customers, orders, and revenue. Venue accounts will be invisible from day one unless added explicitly. Admin needs to see: number of active venues, events posted, deposits pending, events completed.

**Prevention:** Add venue counts to the `/api/health` and admin stat endpoints in the same phase as venue accounts.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

### Pitfall N2: SQLite WAL Checkpointing Causes Read Spikes Under Venue Load

WAL mode allows concurrent readers and one writer. When the WAL file grows large (during a burst of deposit webhooks and booking confirmations), SQLite performs an automatic checkpoint that briefly requires an exclusive lock, blocking all readers. For a single-droplet deployment at 45% memory, this checkpoint spike can cause a 200–500ms pause visible to users.

**Prevention:** Configure `PRAGMA wal_autocheckpoint = 1000` (default is 1000 pages, approximately 4MB). This is already acceptable for the expected load. The real prevention is: do not perform long-running writes inside request handlers. The existing webhook handler at line 8914 is a synchronous `db.prepare().run()` inside an async Express handler — this is fine for current load but watch it if event throughput increases.

**Phase:** Outbox Hardening (Phase 2) — worth noting in `PRAGMA` setup

---

### Pitfall N3: Founding Vendor Protection Does Not Cover Venue Accounts

The `is_founding_vendor` column protects early vendors from subscription expiry. If venue accounts have a trial or subscription model, the same protection must be applied explicitly. Do not assume the vendor founding logic transfers.

**Prevention:** Add `is_founding_venue INTEGER DEFAULT 0` to the venues table at creation time, even if not used immediately. Grandfathering is much harder retroactively.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

### Pitfall N4: Session Cleanup Cron Does Not Know About Venue Sessions

The session cleanup cron (line 1830–1842) purges `sessions` (vendor) and `customer_sessions` (customer) tables. Venue sessions in a new `venue_sessions` table will never be cleaned up unless explicitly added to this cron.

**Prevention:** Add venue session cleanup to the same cron block when venue sessions are created.

**Phase:** Venue/Organizer Accounts (Phase 1)

---

### Pitfall N5: Hub Fire-and-Forget Notification Has No Retry

The Hub notification at line 6012 is explicitly labeled "fire-and-forget" in a comment. It is an HTTP call with no error handling, no retry, and no outbox backing. For order notifications this is acceptable (Hub is informational). For venue deposits and marketplace transaction chains, Hub needs reliable delivery so the north-star verification is possible.

**Prevention:** Route Hub transaction notifications through `emsBillingRecord()` (which has outbox backing) rather than a standalone fire-and-forget HTTP call.

**Phase:** Hub Visibility (Phase 3)

---

## Phase-Specific Warning Table

| Phase | Topic | Likely Pitfall | Mitigation |
|-------|-------|---------------|------------|
| 1 | Venue account creation | Cross-role token leakage (C2) | Separate `x-venue-token` header, separate `venues` table |
| 1 | Anonymous organizer collision | Two parallel organizer systems (M3) | Explicit deprecation decision before writing venue code |
| 1 | Password reset | Third role breaks reset flow (M2) | Extend `user_type` switch to `'venue'` |
| 1 | Admin visibility | Venues invisible in dashboard (N1) | Add venue counts to health endpoint |
| 1 | Founding protection | No `is_founding_venue` column (N3) | Add column at table creation, even if unused |
| 2 | Deposit payment | Booking cancelled before webhook fires (C3) | Webhook verifies booking status, refunds if cancelled |
| 2 | Stripe model | Destination charges can't handle venue refunds (C4) | Use separate charges + transfers for deposits |
| 2 | Outbox atomicity | Business DB and outbox DB are separate (C1) | Startup + 15-min reconciliation query |
| 2 | Outbox growth | Failed records accumulate forever (M5) | Retention cleanup in existing session cron |
| 3 | Hub visibility | No venue transaction type in EMS (M6) | Description convention + EMS category field |
| 3 | Hub reliability | Hub notification is fire-and-forget (N5) | Route through outbox-backed emsBillingRecord |
| 4 | Launch | Venue supply before vendor supply (M7) | 5 Stripe-Connect-onboarded vendors before venue invites |
| 4 | UX | Catering vs marketplace confusion (M8) | Explicit boundary in copy and vendor dashboard |

---

## Sources

- Codebase analysis: `/root/universoul-ecosystem/wya-app/index.js` (10,279 lines, direct inspection)
- Outbox implementation: `/root/universoul-ecosystem/shared/outbox.js` (direct inspection)
- CustomerSync: `/root/universoul-ecosystem/lib/customer-sync.js` (direct inspection)
- [Transactional Outbox Pattern — microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)
- [Outbox Pattern and the Two-Stage Commit Problem — Medium](https://medium.com/@robert_84835/outbox-pattern-and-the-two-stage-commit-problem-7bcff6118ea8)
- [SQLite Concurrent Writes and "database is locked" errors](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/)
- [Stripe Connect — application fee amount docs](https://docs.stripe.com/connect/marketplace/tasks/app-fees)
- [Why Two-Sided Marketplaces Fail After Launch — Raftlabs](https://www.raftlabs.com/blog/two-sided-marketplace-failure-rate)
- [Two-Sided Marketplace Cold Start 2026 Playbook — FORKOFF](https://forkoff.xyz/blog/founder-growth/two-sided-marketplace-cold-start-2026)
- [Stripe Payment Intents — Idempotency Keys](https://docs.stripe.com/payments/payment-intents)
- [Marketplace Payment Reconciliation — Unicommerce](https://unicommerce.com/blog/how-marketplace-payment-reconciliation-helps-ecommerce-business/)
