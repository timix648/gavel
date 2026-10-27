# Gavel v8: top-up bids, direct refunds, evidence, delivery contact, dispute desk

Status: spec, 27 Oct 2026. It builds on v7 (mainnet `0x6102…3A2E`). Everything in v7 stays unless changed below.

## A. Contract changes (AuctionHouse v8)

### A1. Bids draw from your balance first (top-up bidding)
Problem: when outbid, your old bid sits in `claimable`, and a new bid locks the full amount again.

- **Direct `bid(lotId, amount)`:**
  - `credit = min(claimable[bidder], amount)`; `claimable[bidder] -= credit`.
  - Then pull only `amount - credit` with `transferFrom` (skipped if 0).
  - Emit `CreditUsed(lotId, bidder, credit)` when `credit > 0`.
- **Gasless `bidWithAuthorization(lotId, amount, topUp, from, validAfter, validBefore, salt, v, r, s)`:**
  - `nonce = keccak256(abi.encode(address(this), block.chainid, lotId, amount, topUp, salt))`, so lot, amount and top-up are all bound by the signature.
  - `credit = amount - topUp`; require `topUp <= amount`, `topUp > 0`, and `claimable[from] >= credit`.
  - Then `claimable[from] -= credit` and `receiveWithAuthorization(value = topUp)`.
  - A credit-only bid (`topUp == 0`) must be a direct `bid()`, because spending someone's balance needs their own transaction or signature.
- **Order (CEI):** run `_bidCore` (which credits the *previous* leader), then deduct the bidder's credit, then pull. Deduct after the previous leader is credited, so that a leader raising their own bid can reuse the bid they just got back.

### A2. Payouts go straight to the wallet, with a safe fallback
- New internal `_payOut(to, amount)`: `try usdc.transfer(to, amount) returns (bool ok)`. If it returns false or reverts (for example a blocklisted address), credit `claimable[to]` instead.
- Emit `PaidOut(to, amount, bool pushed)`.
- Used for: `refundBuyer`, `confirmDelivery`, `releaseEscrow`, `resolveDispute` and `resolveDisputeTimeout` (each party's share).
- **Not** used for outbid refunds or on-chain-asset sale proceeds. Those stay in `claimable`, so A1 can reuse them and one bad address can never block bidding or settlement.
- All of these functions are already `nonReentrant`, and state is set to CLOSED before any payout.

### A3. Refund reason
`refundBuyer(lotId, string reason)`: reason at most 280 bytes, emitted in `BuyerRefunded(lotId, buyer, amount, reason)`.

### A4. Evidence
- `submitEvidence(lotId, string text)`, callable by the buyer or the seller of an OFFCHAIN lot while the escrow is HELD or DISPUTED.
- Text at most 1,000 bytes; at most 10 submissions per party per lot.
- Emits `Evidence(lotId, party, text)`. It's a link or a short statement (tracking number, screenshot URL).

## B. App changes

1. **Bid button shows the split.** "Bid $1.50 · uses $1.25 from your balance + $0.25 top-up". For gasless, the user signs only the top-up. The relayer passes `topUp`. If the credit covers the full amount, use a direct bid; gasless isn't needed.
2. **Delivery contact.**
   - For OFFCHAIN lots, Create gets two fields: "How the winner contacts you" (required: Telegram, X, email…) and "Delivery instructions" (optional). They're stored in the lot metadata.
   - lotURI becomes `data:application/json;base64,…` with `{title, image, contact, delivery}`. Old plain-text URIs still display.
   - The UI warns that the contact is public on-chain.
   - The winner sees a "Contact the seller" card after the hammer.
3. **Image upload.**
   - Create gets "Upload image": compress in the browser to WebP, max 1200 px, under 300 KB, then POST to `/api/upload`, a Vercel Function using `@vercel/blob` `put()` (needs `BLOB_READ_WRITE_TOKEN`, which Vercel adds when a Blob store is connected). The returned URL goes in the metadata.
   - Image types only, max 300 KB server-side.
   - If no token is set, show "Paste an image URL instead".
4. **Refund with a reason.** The seller's Refund button opens a reason field. The buyer sees "Refunded: <reason>" and the USDC arrives in their wallet directly.
5. **Evidence panel** on disputed or held off-chain lots: both parties can add a note or link, shown newest first with timestamps.
6. **Admin desk** at `/admin`, rendered only if the connected wallet is `owner()`:
   - lists every lot with escrow DISPUTED: amount, bond, both addresses, all evidence, time since dispute, and the time left before the 14-day split;
   - buttons: "Seller at fault: refund buyer + bond" and "Not at fault: pay seller".
7. **Dispute email alerts.**
   - `/api/notify-dispute?lot=N`, called by the app after a dispute transaction confirms. Server-side it reads the chain and only emails if the lot is DISPUTED and was disputed in the last hour, so it can't be spammed.
   - It sends through the Resend HTTP API (`RESEND_API_KEY`) to `NOTIFY_EMAIL`. Both are env vars, never in the repo. The email has the lot link, amount and both parties.
   - Backup: `/api/cron-disputes`, a daily Vercel Cron in `vercel.json`, scans `Disputed` events from the last 2 days and emails any it finds.
   - With no env vars set, both endpoints return 204 and do nothing.
8. **Reputation button** only shows if the seller has a linked ERC-8004 identity (`sellerRegistered(seller)`), labelled "Optional: record this sale to your ERC-8004 reputation".
9. **Landing stats bug:** the count-up only ran once on scroll, so data that arrived later stayed at 0. It must re-animate when the target changes.
10. **Relayer stats:** compute from on-chain `RelayedBid` events (a count, and gas from receipts if cheap), not in-memory counters, which reset on serverless restarts. Or remove the gas figure.

## C. Tests (keep all 59, adapt signatures; add)
- Direct bid using full credit, partial credit and no credit; balances exact.
- Gasless top-up: wrong `topUp` reverts (signature mismatch); insufficient credit reverts; `topUp == 0` reverts.
- A leader raises their own bid, reusing the credit from their previous bid.
- `_payOut` push succeeds → wallet balance up and claimable unchanged. With a blocklisted recipient (extend MockUSDC to revert transfers to a blocked address) → falls back to claimable.
- `refundBuyer` with a reason emits the event; a reason over 280 bytes reverts.
- Evidence: only buyer or seller; only HELD or DISPUTED; length and count limits.
- Funds conservation across credit bids and pushed payouts (the house ends at 0).
