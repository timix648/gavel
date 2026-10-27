# Turn 24 — Audit sync review

Reviewer: Arc Studio  
Date: 2026-10-27  
Scope: four audit fixes applied outside Studio to AuctionHouse.sol, LotVault.sol, AuctionHouse.t.sol, AuctionRoom.tsx, Create.tsx, chain.ts, relayer/handler.ts, keeper/index.ts

---

## Verdict

All four fixes are correct and complete. No additional fund-loss paths were found in the uploaded code.  
Tests: **59/59 passing**. Lint + typecheck: **0 errors, 9 pre-existing warnings**.

---

## Fix-by-fix analysis

### C1 — `releaseBondAfterTimeout` removed (critical, correct)

The removed function let any caller claim the seller's bond 7 days after `settledAt`, regardless of escrow state. On an OFFCHAIN sold lot the flow was:

1. `settle()` → escrow = HELD, `bondReleased = false`
2. Attacker calls `releaseBondAfterTimeout()` at day 7 → sets `bondReleased = true`, pays only the bond to the seller
3. `releaseEscrow / confirmDelivery / refundBuyer / dispute` all guard on `!bondReleased` → revert for every call
4. The winning bid (the largest amount) is permanently locked in the contract

The fix is complete. The three legitimate no-bond-released exits for OFFCHAIN lots — `confirmDelivery`, `releaseEscrow` (after 7 days, no dispute), and `refundBuyer` — all remain. There is no code path left that sets `bondReleased = true` without simultaneously moving the payment out of the contract.

One correctness note worth recording: `releaseEscrow` uses `settledAt + DELIVERY_WINDOW` as its timer, which is correct. The v7 spec says the 7-day window runs from settlement for the delivery path, and from the dispute for the arbitration path. Both now use their own independent start times (`settledAt` for delivery, `_disputedAt[lotId]` for arbitration). That alignment is verified by tests 55 and 58.

### H1 — `_disputedAt` starts at the dispute, not at `settledAt` (correct)

Before the fix, `resolveDisputeTimeout` used `lot.settledAt + DISPUTE_RESOLVE_TIMEOUT`. A buyer who disputes on day 6 would see the 14-day arbitration window expire on day 20 from settlement — only 14 days total from settlement, meaning the arbiter gets only 8 days from the dispute. In extreme cases (dispute at the last second of the 7-day delivery window) the arbiter gets seconds, not days.

The fix stores `_disputedAt[lotId] = block.timestamp` inside `dispute()` and checks `_disputedAt[lotId] + DISPUTE_RESOLVE_TIMEOUT` inside `resolveDisputeTimeout`. The view `disputedAt(uint256 lotId)` is also exposed, allowing the frontend to render the remaining arbitration window accurately.

The `dispute()` function still correctly guards `block.timestamp < lot.settledAt + DELIVERY_WINDOW` to ensure disputes can only be raised within the delivery window. That check is on the right variable (`settledAt`) and was not changed.

Test 55 verifies the fix end-to-end: disputes on day 6, confirms timeout still reverts at day 14 from settlement (only day 8 from dispute), and succeeds at day 14 from the dispute.

The AuctionRoom.tsx line `const disputeTimedOut = disputeOpenedAt > 0n && chainNowSec >= Number(disputeOpenedAt) + 14 * 86400` is correct — it gates the timeout button on `disputedAt`, not on `settledAt`.

### M1 — USYC removed from Create page dropdown (correct)

The comment in the uploaded Create.tsx is accurate: USYC is a permissioned token whose `transfer` and `transferFrom` will revert unless the recipient is on USYC's allowlist. LotVault is not on that allowlist, so listing USYC would cause the ERC20 `safeTransferFrom` in `list()` to revert before the lot is created. Even if the deposit succeeded in a future world where LotVault was added to the allowlist, releasing to an arbitrary buyer address would then fail at `claimLotAsset` — locking both the USYC and the winning bid permanently.

The fix is the right level: remove USYC from the UI allowlist while leaving the `USYC_ADDRESS` and `USYC_WARNING` constants in `chain.ts` for reference and for the informational warning already shown in AuctionRoom when the asset is USYC (which can still appear on mainnet lots listed via direct contract calls if the owner allowlists it in the future).

### L1/L2 — `onERC721Received` source-check; `BondHeld` OFFCHAIN-only (correct)

**L1 — `onERC721Received`**: The vault now rejects any ERC721 `safeTransfer` that does not originate from the GavelLot contract. ERC721 asset lots use plain `transferFrom` (not `safeTransferFrom`), so they never trigger this hook. The only legitimate caller of this hook is `GavelLot.mint()`, which calls `_safeMint` → `_checkOnERC721Received`. The guard `require(msg.sender == _gavelLot(), ...)` is correct: `msg.sender` on this hook is the ERC721 contract making the callback, not the original transaction sender.

The `_gavelLot()` static-call pattern reads the address fresh each time. This is fine — the AuctionHouse stores `gavelLot` as a public immutable, so the static-call will always return the same value and cannot be manipulated.

Test 57 verifies that a third-party ERC721 `safeTransferFrom` to the vault reverts with "LotVault: unexpected ERC721".

**L2 — `BondHeld` OFFCHAIN-only**: `emit BondHeld(lotId, lot.bond)` now only fires inside the `kind == Kind.OFFCHAIN` branch of `settle()`. On-chain lots have `lot.bond == 0` (set at listing: `bondReleased: kind != Kind.OFFCHAIN`, `bond: 0` for non-OFFCHAIN). Emitting with `bond == 0` was harmless but misleading; the guard is correct.

---

## Remaining observations (no fund-loss risk; noted for completeness)

**Keeper still calls `releaseBondAfterTimeout`**: `keeper/index.ts` line 339 calls `releaseBondAfterTimeout` on the v7 contract, which no longer exists. This will revert on-chain and the keeper will log an error, but it will not lose funds or lock state — `sendTx` wraps in `withBackoff` which retries indefinitely, so the keeper will loop on this call forever for any lot that was settled pre-v7. The branch condition `settled && !bondReleased` will be true for old lots that had that state, and for any OFFCHAIN v7 lot that legitimately reached `bondReleased = false` post-settle (which is expected — all OFFCHAIN sold lots start with `bondReleased = false`). The keeper should remove this branch and its `SEVEN_DAYS` / `releaseBondAfterTimeout` references — the function does not exist on v7. This is an operational issue, not a security issue. The keeper has no custody of user funds.

**`_disputedAt` not reset on non-dispute**: A default value of 0 is correct. `disputeTimedOut` in AuctionRoom.tsx correctly guards on `disputeOpenedAt > 0n` before evaluating the timeout — so the button never appears unless a dispute was actually raised. No issue.

**`_lotAsset` returns `address(0)` for OFFCHAIN lots**: This is correct by design. The AuctionRoom.tsx correctly shows the asset line only when `isOnchainKind && lotAsset !== NULL_ADDR`.

**`refetchLotAsset` declared but only used indirectly**: `refetchLotAsset` is returned from `useReadContract` but not called anywhere in the component. It is harmless — the read-contract hook automatically refetches on block changes because `blockNumber: block?.blockNumber` is passed.

---

## Test and static analysis summary

| Check | Result |
|---|---|
| `forge test` | 59/59 passed, 0 failed |
| `bash scripts/check.sh` (oxlint + tsc) | 0 errors, 9 warnings (all pre-existing exhaustive-deps) |
