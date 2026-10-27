# Gavel v7: any Arc asset, escrow on both sides, no refusals

Status: design, 27 Oct 2026. It replaces the v6 rules where they conflict.

## 1. What changes and why

| v6 | v7 | Reason |
|---|---|---|
| Only a Gavel-minted "lot NFT" that stands for an off-chain item | Four lot kinds: **OFFCHAIN**, **ERC721**, **ERC1155**, **ERC20** | Real assets live on Arc: EURC, USYC, ERC-8004 agent identities, NFTs and tokenized RWAs. Auctioning them makes delivery trustless. |
| Off-chain sale: the seller is paid at the hammer and the buyer is protected only by a bond (= reserve) | Off-chain sale: the **winning bid stays in escrow** until delivery is confirmed or the delivery window ends, and the bond is kept as a deterrent | With v6, a winner who never received the item recovered only the bond. |
| Reserve <= 5 USDC, step <= 1 USDC | Reserve <= **1,000 USDC** (configurable by the owner, never above 100,000), **no cap on the step**, no cap on bids | The step cap was arbitrary. The reserve cap stays as a safety limit while the code is unaudited. |
| Soft close stops after 30 extensions | `MAX_EXTENSIONS = 500` | After 30 extensions, a final-second snipe became possible again. Every extension still needs a real, higher bid that locks real USDC, so spam is expensive. |

Unchanged from v6: pull payments, the seller-bid block (direct and gasless), the zero-bid block, one-signature gasless bids with the bound nonce, Memo settlement, pause, and disabled `renounceOwnership`.

## 2. Lot kinds

```
enum Kind { OFFCHAIN, ERC721, ERC1155, ERC20 }
list(Kind kind, address asset, uint256 id, uint256 amount, string lotURI,
     uint256 reserve, uint256 durationSecs, uint256 minIncrement)
```

| Kind | At listing | At settle (sold) | At settle (unsold) | Bond |
|---|---|---|---|---|
| OFFCHAIN | mints a Gavel lot NFT into the vault, as in v6 | NFT moves to the winner. **Payment goes into escrow**, not to the seller. | NFT goes back to the seller; the bond becomes claimable by the seller | = reserve |
| ERC721 | `transferFrom(seller, vault, id)`, then `ownerOf(id) == vault` is checked | the winner gets an **asset claim**; the seller is credited the payment | the seller gets an asset claim | 0 |
| ERC1155 | `safeTransferFrom(seller, vault, id, amount)`; the vault implements `onERC1155Received` and checks the balance increase | asset claim to the winner; payment to the seller | asset claim to the seller | 0 |
| ERC20 | `transferFrom(seller, vault, amount)`; **the balance increase must equal `amount` exactly**, otherwise the listing reverts | asset claim to the winner; payment to the seller | asset claim to the seller | 0 |

`claimLotAsset(lotId, to)`: the entitled party (the winner, or the seller if unsold or cancelled) pulls the asset to **any address they choose**. This matters because:
- **Blocklisted winner (EURC):** the push would revert; the winner can send to another address.
- **Permissioned token (USYC):** only allowlisted addresses can hold it, so the winner directs it to their eligible wallet.
- **ERC1155 sent to a contract without a receiver hook:** the winner picks a receiving address.
- **Atomic in accounting:** in the settle transaction, ownership of the asset and the payment flip together. Settle never calls the asset contract, so a hostile or broken token cannot block settlement or the seller's payout.

## 3. Asset allowlist (the main loss-of-funds defence)

A malicious token contract can accept the deposit at listing and then refuse to transfer out to the winner. The winner would have paid and receive nothing. Pull-based claiming cannot fix that, because the asset contract itself is hostile.

- `allowedAsset[address] -> Kind` is set by the owner with `setAllowedAsset(asset, kind, bool)`.
- `list` with `kind != OFFCHAIN` requires `allowedAsset[asset] == kind`.
- Removing an asset from the list only blocks *new* listings. Existing lots keep working.
- Initial mainnet list, each checked on-chain before adding:
  - EURC `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` (ERC20)
  - ERC-8004 IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (ERC721)
  - USYC `0x8a5D989Bbb96929F689B0200f435f53dA42bF490` (ERC20, permissioned; the UI warns that only eligible wallets can receive it)
- Never allowed: USDC itself, GavelLot, and the AuctionHouse or vault.
- Every new token is reviewed before it's added: no fee-on-transfer, no rebasing, no transfer hooks that call back unexpectedly, no admin pull rights over holders' balances.

## 4. Refusals: who can stall, and the default if they do

| Situation | Can it happen? | Handling |
|---|---|---|
| Buyer won but refuses to pay | **No** | Every bid is escrowed when it is placed. |
| Seller refuses to hand over an on-chain asset | **No** | The asset is escrowed at listing. |
| Nobody calls settle | Harmless | Anyone can call `settle()` after the deadline. |
| Winner never claims the asset | Harmless to the seller | The seller was paid at settle. The asset waits for the winner forever. |
| OFF-CHAIN: seller never delivers | Buyer protected | Within the **delivery window (7 days)**, the winner opens a dispute. The seller can `refundBuyer()` at any time, which returns the payment to the buyer and the bond to the seller. Otherwise arbitration (below). |
| OFF-CHAIN: buyer received the item but stays silent | Seller protected | When the 7-day window ends with no dispute, **anyone** can call `releaseEscrow()`, which pays the seller the payment and the bond. |
| OFF-CHAIN: buyer falsely disputes | Seller protected | The arbiter (the owner) rules. If the seller is not at fault, the seller receives the payment and the bond. |
| OFF-CHAIN: the arbiter never rules | Neither side stuck | After **14 days from the dispute**, anyone can call `resolveDisputeTimeout()`. The payment is **split 50/50**, and the bond goes back to the seller. Neither side can win by stalling, and an absent arbiter can't lock funds. |
| Arbiter rules seller at fault | Buyer made whole | Buyer receives the payment **and** the seller's bond. |
| Arbiter rules seller not at fault | Seller paid | Seller receives the payment and the bond. |

Every outcome is a credit to `claimable` (pull), so no single blocked address can freeze it.

## 5. Sniping and MEV

- **Soft close:** a bid with under 10 seconds left extends the deadline to now + 10 s, up to 500 times. A last-second bid always gives everyone else 10 seconds to answer.
- **No public mempool:** Arc has no public mempool in the Ethereum sense, so bots cannot watch pending bids. A block proposer (an institutional validator) still orders transactions; that is documented as a residual risk.
- **Gasless bids cannot be redirected:** the nonce binds lot, amount, chain and contract.
- **Bid floor:** every bid must exceed the last by at least the seller's step, so spam bids cost real, locked USDC.
- **No sealed bids in v7:** commit-reveal would hide bids from proposers but breaks the live-room experience. It's listed as future work.

## 6. Threat audit of the new flows

| # | Threat | Defence |
|---|---|---|
| T1 | Malicious or odd token at listing (fee-on-transfer, rebasing, fake balance) | Allowlist; exact balance-increase check for ERC20; `ownerOf` check for ERC721; balance check for ERC1155 |
| T2 | Token blocks transfer out to the winner | Allowlist, plus pull to any address chosen by the claimant |
| T3 | Reentrancy through ERC1155 or ERC777-style hooks during list or claim | `nonReentrant` everywhere, and checks-effects-interactions: claim flags are cleared before the transfer |
| T4 | Double claim of an asset | A per-lot `assetClaimed` flag, set before the transfer |
| T5 | Seller lists an asset they don't own | The transfer into the vault reverts |
| T6 | Same ERC721 listed twice | The second transfer reverts because the vault already owns it |
| T7 | Seller cancels after bids | `cancel` requires no bids, as in v6 |
| T8 | Escrowed payment double-paid (release plus refund) | One `escrowState` enum: NONE, HELD, DISPUTED, CLOSED. Each exit moves it to CLOSED first. |
| T9 | Dispute after the window | `dispute` requires `now < settledAt + DELIVERY_WINDOW` |
| T10 | `releaseEscrow` during a dispute | It requires the HELD state |
| T11 | Odd payment in the 50/50 split | The buyer gets `floor(x/2)` and the seller gets the rest, so the sum is exact and no dust is stranded |
| T12 | Owner removes an allowlisted asset mid-auction | Only new listings are blocked |
| T13 | ERC1155 `onERC1155Received` called by an arbitrary contract to fake a deposit | The vault accepts only during an active `list` call (a transient `_expectingDeposit` flag set by the AuctionHouse), and the balance is checked |
| T14 | Accounting invariant | The vault's USDC equals all claimables + live highest bids + held bonds + escrowed payments. The vault's asset balance per lot equals unclaimed lots. |

## 7. Tests required (on top of the 37 in v6)

- ERC721, ERC1155 and ERC20 lots: list, bid, settle, the winner claims to another address, the unsold seller reclaims, cancel returns the asset.
- ERC20 fee-on-transfer mock: listing reverts. A non-allowlisted asset: listing reverts. A blocklisting mock: the winner claims to an alternative address.
- An ERC1155 receiver-less winner claims to an EOA. An unsolicited `onERC1155Received` is rejected.
- Double-claim reverts. A non-entitled claim reverts.
- OFFCHAIN escrow: confirm → seller paid; window passes → `releaseEscrow`; `refundBuyer`; dispute → seller at fault (buyer gets payment + bond); dispute → not at fault; arbiter timeout → 50/50 split with an odd amount.
- `releaseEscrow` while disputed reverts; dispute after the window reverts.
- Soft close: 100 extensions still work (cap 500); no step cap; reserve cap enforced and owner-adjustable within bounds.
- Funds-conservation invariant across all kinds.
