> History: this file starts with the v6 review (24 Oct). The v7 review follows; v8 changes and their tests (83 in total) are in V8-DESIGN.md and STUDIO.md turns 26-28.

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

---

# v7 review (27 Oct 2026)

Scope: AuctionHouse v7 and LotVault v7 as written by Arc Studio in turn 23, against the spec V7-DESIGN.md. Method: line-by-line review, 59 Foundry tests (6 written by me to attack the findings), Slither, and real-chain scenarios on testnet.

| # | Severity | Finding | Status |
|---|---|---|---|
| C1 | **Critical** | Leftover `releaseBondAfterTimeout`: anyone could strand an off-chain sale's escrowed payment forever after 7 days | Fixed: function removed (test 54) |
| H1 | High | Arbiter timeout counted from the sale, not the dispute | Fixed: `disputedAt` (test 55) |
| M1 | Medium | USYC is permissioned; the vault is not an eligible holder, so listings would revert | Not allowlisted; removed from the UI |
| L1 | Low | The vault accepted any stray ERC-721 via safe transfer | Fixed: only Gavel lot NFTs (test 57) |
| L2 | Low | `BondHeld` emitted for bond-free lots | Fixed |

Threats checked and holding:
- **Fee-on-transfer and rebasing tokens:** blocked by the allowlist plus the exact balance-increase check.
- **Malicious token refusing transfer out:** blocked by the allowlist.
- **Blocklisted or permissioned recipient:** the claim can go to any address.
- **ERC-1155 hooks and reentrancy:** `nonReentrant` everywhere, plus a flag that only accepts ERC-1155 deposits during a listing.
- **Double claim:** per-lot flag.
- **Listing an asset you don't own:** the transfer reverts.
- **Double payment from escrow:** a single state machine (NONE / HELD / DISPUTED / CLOSED).
- **Dust in the 50/50 split:** buyer gets `floor(x/2)`, seller gets the rest.

Residual risks:
- Allowlisted tokens are upgradeable by their issuers (EURC is a Circle proxy).
- The block proposer orders transactions within a block.
- A seller can shill from a second wallet.
- The owner can pause, cancel lots with no bids, and arbitrate. The owner cannot move funds, and arbitration times out to a 50/50 split.
