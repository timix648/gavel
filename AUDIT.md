# GAVEL contract review (pre-mainnet), 24 Oct 2026

Scope: onchain/contracts/AuctionHouse.sol, LotVault.sol, GavelLot.sol, ReputationWriter.sol.
Method: line-by-line manual review, Foundry suite (37/37 pass, arc-forge), Slither 0.x (76 detectors).
This is an internal review, not a third-party audit.

## Fixed

| # | Severity | Issue | Fix | Test |
|---|----------|-------|-----|------|
| 1 | High | Seller could bid on their own lot (shill bidding), directly or via gasless relay. Seen live on testnet lot #115. | `_bidCore`: `require(bidder != lot.seller)` covers `bid` and `bidWithAuthorization`. UI shows "This is your lot" instead of the Bid button. | test_29, test_34 |
| 2 | Medium | Winner that is a contract without `onERC721Received` made `settle()` revert forever, locking the seller's proceeds and bond. | `LotVault.release` uses `transferFrom` instead of `safeTransferFrom`. | test_36 |
| 3 | Low | A 0-USDC bid on a 0-reserve lot won for free and blocked `cancel()`. | `require(amount > 0)`. | test_35 |

New invariant test test_37 replays lot #115's numbers (0.70 / 0.98 / 1.26) and checks every USDC leaves the contract: house balance 0 afterwards.

## Accepted / by design (disclose)

- Sock-puppet shill bids from a second wallet cannot be blocked on-chain by any auction contract. Mitigation: bond = reserve, public bid history.
- Reputation farming: a seller can win their own lots from a second wallet to reach 3 "clean sales" and halve future bonds. Impact is capped (bond <= 2.5 USDC saved). Consider removing the discount for mainnet.
- If a seller never delivers, the winner recovers the bond (= reserve) via dispute, not the full price. The UI and write-up must say so.
- Owner powers: pause list/bid, cancel no-bid lots, arbitrate disputes (14-day permissionless fallback). Owner cannot move user funds.
- Slither: `timestamp` (intentional, auction deadlines), `reentrancy-benign` in `list` (nonReentrant, trusted GavelLot), `missing-zero-check` on `setReputationWriter` (address(0) intentionally disables it). No medium/high detectors.

## Before mainnet

1. Redeploy v6 to testnet with these fixes; update app, relayer, keeper addresses; re-run e2e.
2. Confirm the USDC ERC-20 interface address on Arc mainnet equals 0x3600...0000 (hardcoded in the constructor).
3. Owner = a wallet the user controls (ideally a multisig), never the relayer key.
