<div align="center">

# Gavel

### A live auction house where every bid is a USDC transaction on Arc mainnet

The auction ends when the bidding does. A bid in the last ten seconds adds ten seconds, the outbid
bidder's USDC is released in the same transaction, and at the hammer the lot and the payment change hands in one step.

[![Live on Arc mainnet](https://img.shields.io/badge/Live-Arc_mainnet-06b6d4?style=for-the-badge)](https://gavel-alpha.vercel.app)
[![For reviewers](https://img.shields.io/badge/For-reviewers-3ddc84?style=for-the-badge)](JUDGE.md)
[![Mainnet volume](https://img.shields.io/badge/Bid_volume-2%2C136_USDC-f97316?style=for-the-badge)](PROOF.md)
[![Bids](https://img.shields.io/badge/Bids-60_(47_gasless)-8b5cf6?style=for-the-badge)](PROOF.md)
[![Demo video](https://img.shields.io/badge/Demo-video-FF0000?style=for-the-badge)](VIDEO_URL)
[![Built in Arc Studio](https://img.shields.io/badge/Built_in-Arc_Studio-8b5cf6?style=for-the-badge)](https://studio.arc.io/app/d49aa346-328f-49aa-b5c9-62e187eca7ed)
[![AuctionHouse](https://img.shields.io/badge/AuctionHouse-0xA51A...dEa6-4ea1ff?style=for-the-badge)](https://explorer.arc.io/address/0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6)

![Arc](https://img.shields.io/badge/Arc-mainnet_5042-4ea1ff?style=flat)
![USDC-as-gas](https://img.shields.io/badge/gas-USDC-3ddc84?style=flat)
![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?style=flat&logo=solidity&logoColor=white)
![Foundry](https://img.shields.io/badge/Foundry-83_tests-3ddc84?style=flat)
![Sourcify](https://img.shields.io/badge/Sourcify-4_exact_matches-3ddc84?style=flat)
![EIP-3009](https://img.shields.io/badge/gasless-EIP--3009-06b6d4?style=flat)
![license](https://img.shields.io/badge/license-MIT-blue?style=flat)

</div>

## Track record on Arc mainnet

Every number below is recomputed from on-chain events by `audit.py` and shown live, with no wallet needed, at [/proof](https://gavel-alpha.vercel.app/proof).

| | |
|---|---|
| Bid volume | **2,136 USDC** |
| Bids | **60**, of which **47 gasless** (one signature, no gas) |
| Lots | **14** listed, **13** sold, across off-chain goods and escrowed EURC |
| Distinct bidder wallets | 6 |
| Bids funded by outbid credit (top-up) | 24 |
| Disputes | 0 |
| Left in the contract after every sale | **0 USDC, 0 EURC, 0 unclaimed** |

Some participants were funded by the author for testing; this is disclosed in [PROOF.md](PROOF.md).


---

**In three lines**

- **Problem:** online auctions either hand the money to a platform you have to trust, or, on-chain, cannot run a soft close. On a chain with 12-second blocks, a bid made in the last ten seconds lands after the auction has closed, and every bidder needs ETH for gas on top of the USDC they are bidding.
- **On Arc:** sub-second deterministic finality makes a 10-second soft close real. USDC is the only asset a bidder needs, and with a one-signature gasless bid not even gas. Settlement moves the lot NFT and the payment atomically, so neither side can back out.
- **Proof:** four contracts on Arc mainnet, all source-verified on Sourcify with exact matches. 83 Foundry tests, Slither, an internal review and an independent Arc Studio review. A bid costs about $0.003 and a gasless bid about $0.004. Every transaction hash is in [PROOF.md](PROOF.md), and the live `/proof` page reads the chain directly, with no wallet.

---

## Contents

1. [The problem](#the-problem)
2. [What Gavel does](#what-gavel-does)
   - [What you can auction](#what-you-can-auction)
   - [Built for real bidders (v8)](#built-for-real-bidders-v8)
3. [Why this needs Arc, and only Arc](#why-this-needs-arc-and-only-arc)
4. [Life of a lot, step by step](#life-of-a-lot-step-by-step)
5. [Architecture](#architecture)
6. [Smart contracts](#smart-contracts)
7. [Gasless bidding in one signature](#gasless-bidding-in-one-signature)
8. [Money flows and the accounting invariant](#money-flows-and-the-accounting-invariant)
9. [The web app](#the-web-app)
10. [The relayer](#the-relayer)
11. [Arc-specific engineering](#arc-specific-engineering)
12. [Proof on Arc mainnet](#proof-on-arc-mainnet)
13. [Measured gas and cost](#measured-gas-and-cost)
14. [Security](#security)
15. [Test suite](#test-suite)
16. [How it was built in Arc Studio](#how-it-was-built-in-arc-studio)
17. [What we got wrong](#what-we-got-wrong)
18. [Limitations](#limitations)
19. [What a microgrant would fund](#what-a-microgrant-would-fund)
20. [Run it yourself](#run-it-yourself)
21. [Project structure](#project-structure)
22. [FAQ](#faq)

---

## The problem

Auctions are one of the oldest ways to find a price, and online they still fail in two places.

**Trust.** On an auction website the operator holds the bidders' money, decides who won, and decides when the seller gets paid. The buyer trusts the operator to run the payment logic honestly; the seller trusts it to pay out. Every rule of the auction lives in a database nobody outside can inspect.

**Timing.** Anyone who has bid online knows *sniping*: a bid placed in the final second that nobody has time to answer. Serious auction houses fix it with a **soft close**: any bid near the end extends the clock, so the auction ends when the bidding stops rather than when a timer runs out.

Moving auctions on-chain should fix the trust problem, but on most chains it breaks the timing:

- With 12-second blocks, a "10-second soft close" is shorter than a single block. A bid sent with four seconds left is included in a block that arrives after the close, so the extension never happens. The auction becomes a handful of discrete rounds, not a live room.
- Finality is probabilistic. The winner is not really the winner until enough confirmations have passed.
- Bids sit in a public mempool, where a bot can see a winning bid and outbid it before it lands.
- Every bidder needs two assets: the stablecoin they are bidding and the native token for gas.

So on-chain auctions have mostly been slow, batch-style affairs (NFT drops with hour-long windows, Dutch auctions) rather than the live, competitive room that makes an auction an auction.

## What Gavel does

Gavel is a live English auction house where every action is a USDC transaction on Arc mainnet.

| Who | What happens |
|---|---|
| **Seller** | Lists a lot: what is being sold (an off-chain item or service, an NFT, an ERC-1155 position or an amount of an ERC-20 token), a reserve price (up to 1,000 USDC), a minimum bid step (any size), and a duration. Live auctions run 10, 15 or 30 minutes; timed listings run 1 hour, 2 hours, 6 hours, 24 hours, 3 days or 7 days. Listing mints a lot NFT straight into an escrow vault and posts a seller bond equal to the reserve. |
| **Bidder** | Sees one button showing the exact next valid bid, "Bid $X". Pays either with a normal USDC transaction or with a **gasless** bid: one signature, no transaction, no gas. |
| **Outbid bidder** | Their USDC becomes claimable in the same transaction as the bid that beat them. A banner says "You were outbid", and one **Withdraw** pulls everything they are owed across every auction. |
| **Anyone, in the last 10 seconds** | A bid with under 10 seconds left sets the deadline to now + 10 seconds, up to 500 times per lot, so every auction is guaranteed to end. The clock visibly jumps back. |
| **At the hammer** | Anyone can call `settle()`. In one transaction the lot NFT moves from the vault to the winner and the winning bid is credited to the seller. The app sends it through Arc's Memo contract, so the settlement carries a receipt tagged with the lot ID. |
| **After the sale** | The seller's bond stays locked. The winner releases it by confirming delivery, or it releases itself after 7 days. Before then the winner can open a dispute; the owner arbitrates, and if the owner does nothing for 14 days anyone can resolve it in the seller's favour, so a bond can never be locked forever. |
| **Seller viewing their own lot** | Sees "This is your lot" instead of a Bid button. The contract also rejects the bid, so shill bidding from the seller's own wallet is impossible. |

Every lot on mainnet is listed by a real seller. There are no automated or house auctions.

## What you can auction

| Kind | Examples on Arc mainnet | How delivery works | Can either side refuse? |
|---|---|---|---|
| **ERC-20 token** | EURC (allowlisted) | The amount is escrowed at listing; at the hammer the seller is paid and the winner claims the tokens to any address | No. Both sides are escrowed before the auction starts. |
| **ERC-721 NFT** | ERC-8004 AI-agent identities (allowlisted); NFT collections on request | The NFT is escrowed at listing and claimed by the winner | No |
| **ERC-1155** | Semi-fungible positions, editions | The amount is escrowed at listing and claimed by the winner | No |
| **Off-chain item or service** | A code review, a logo, a physical good | The seller posts a bond. The winning bid is **held in escrow** until the winner confirms delivery, the seller refunds, or 7 days pass with no dispute. | The buyer cannot stall: after 7 days anyone can release the escrow. The seller cannot keep the money without delivering: a dispute goes to the owner, the buyer gets payment + bond if the seller is at fault, and if nobody rules within 14 days the payment splits 50/50. |

Only allowlisted token contracts can be listed. A hostile token could accept a deposit and then refuse to hand it to the winner, so each contract is reviewed (no fee-on-transfer, no rebasing, no surprising hooks) before the owner adds it. USYC exists on Arc but is permissioned: the vault itself would need to be an eligible holder, so it is not allowlisted. Claims go to any address the winner chooses, so a blocklisted or ineligible wallet can redirect delivery.

## Built for real bidders (v8)

| Feature | What it does |
|---|---|
| **Outbid with just the extra** | When you are outbid, your bid comes back to your balance. Bidding again reuses it, so you only add the difference ("Outbid with $0.25 extra"). This works for gasless bids too: you sign only the extra. |
| **Money lands in your wallet** | Escrow releases, refunds and dispute rulings send USDC straight to the recipient's wallet. If a wallet can't receive (for example, a blocklisted address), the money waits safely in their Gavel balance instead. |
| **Refunds with a reason** | A seller who can't deliver refunds the buyer in one click with a reason stored on-chain ("Item out of stock"). |
| **Evidence and a dispute desk** | Buyer and seller can each post short evidence notes or links on-chain. Disputes appear on a private `/admin` page for the owner, with both sides' evidence and one-click rulings. |
| **Dispute email alerts** | When a dispute opens, the owner gets an email. The server checks the chain first, so alerts can't be faked, and a daily scan catches any that were missed. |
| **Seller contact and photos** | Off-chain lots carry the seller's contact and delivery instructions, shown to the winner. Lot photos upload straight from your device. |

## Why this needs Arc, and only Arc

| Arc property | Where Gavel depends on it |
|---|---|
| **Sub-second deterministic finality** | The 10-second soft close in [`AuctionHouse._bidCore`](onchain/contracts/AuctionHouse.sol). A bid sent with four seconds left is final within a second and extends the clock. On a 12-second chain it would arrive after the close. The landing page animates the two side by side. |
| **USDC is the gas token** | A bidder holds exactly one asset. The relayer's gas bill is in dollars, about $0.004 per gasless bid, so sponsoring bids is a predictable cost rather than a token-price bet. |
| **Native USDC implements EIP-3009** | One-signature gasless bids through `receiveWithAuthorization` in [`bidWithAuthorization`](onchain/contracts/AuctionHouse.sol). |
| **No public mempool front-running** | A winning bid cannot be observed and outbid by a bot before it lands, which matters most in the final seconds. |
| **Memo contract** | Settlement is routed through Arc's Memo contract (`0x5294E992...e505`) with the lot ID as the memo ID, producing a reconcilable on-chain receipt for every sale ([`AuctionRoom.tsx`](app/src/pages/AuctionRoom.tsx)). |
| **USDC blocklist** | Transfers to or from a blocklisted address revert. That is why every payout in Gavel is a *pull*: credits go into `claimable` and each person calls `claim()`. One blocklisted bidder cannot freeze an auction for everyone else (test 8). |
| **ERC-8004 on mainnet** | [`ReputationWriter`](onchain/contracts/ReputationWriter.sol) records clean sales against a seller's ERC-8004 identity on the mainnet ReputationRegistry. |
| **Block timestamps are non-decreasing, not strictly increasing** | `block.timestamp` is used only for deadline comparisons, never to order bids. The frontend clock runs on chain time, not the browser clock (a PC clock 11 seconds behind the chain was one of our real bugs). |
| **`PREVRANDAO` is always 0** | Gavel needs no randomness, and nothing in the protocol relies on it. |

## Life of a lot, step by step

```
 seller                        AuctionHouse                         LotVault / GavelLot
   |  approve(USDC, bond)            |                                     |
   |  list(uri, reserve, dur, step)  |                                     |
   |-------------------------------->|  transferFrom(seller, bond)         |
   |                                 |  mint(LotVault, uri) -------------->|  NFT held in escrow
   |                                 |  emit Listed                        |
   |                                 |                                     |
 bidder A  bid(lot, 0.10)            |                                     |
   |-------------------------------->|  checks: live, not seller, > 0,     |
   |                                 |          >= reserve                 |
   |                                 |  highest = A, 0.10                  |
   |                                 |  transferFrom(A, 0.10)              |
   |                                 |                                     |
 bidder B  signs one EIP-3009 auth   |                                     |
 relayer   bidWithAuthorization(...) |                                     |
   |-------------------------------->|  checks: >= 0.10 + step             |
   |                                 |  claimable[A] += 0.10  (Outbid)     |
   |                                 |  highest = B, 0.15                  |
   |                                 |  USDC.receiveWithAuthorization(B)   |
   |                                 |                                     |
 bidder A  bid(lot, 0.20) at T-4s    |                                     |
   |-------------------------------->|  claimable[B] += 0.15               |
   |                                 |  deadline = now + 10  (Extended)    |
   |                                 |                                     |
 anyone    settle(lot) after deadline|                                     |
   |-------------------------------->|  settled = true                     |
   |                                 |  claimable[seller] += 0.20          |
   |                                 |  release(A, tokenId) -------------->|  NFT to winner A
   |                                 |  emit Hammer, BondHeld              |
   |                                 |                                     |
 winner A  confirmDelivery(lot)      |  claimable[seller] += bond          |
 B, seller claim()                   |  USDC.transfer(caller, claimable)   |
```

The lot NFT and the seller's credit move in the same transaction. If the NFT transfer failed, the whole settlement would revert and nobody would be credited. There is no state in which the winner has paid but has no lot, or the seller has been paid but still holds it (test 11).

## Architecture

```
                         +------------------------------+
   browser               |  React app (Vite, wagmi,     |
   (any EVM extension    |  RainbowKit)                 |
    wallet)              |  landing  /lots  /lot/:id    |
                         |  /create  /me    /proof      |
                         +------+---------------+-------+
                                |               |
               direct txs:      |               |  gasless: POST /relay/bid
               list, bid,       |               |  { lotId, amount, from,
               settle, claim,   |               |    validAfter, validBefore,
               confirm, dispute |               |    salt, sig }
                                |               v
                                |      +-------------------+
                                |      |  Relayer           |
                                |      |  (Vercel Function  |
                                |      |   or Bun server)   |
                                |      |  validates, pays   |
                                |      |  gas in USDC       |
                                |      +---------+---------+
                                v                v
 +--------------------------------------------------------------------+
 |  Arc mainnet (chain 5042)                                          |
 |                                                                    |
 |  AuctionHouse ---- mints ----> GavelLot (ERC-721)                  |
 |       |                             |                              |
 |       +--- escrows via ----> LotVault (holds NFTs until settle)    |
 |       |                                                            |
 |       +--- USDC 0x3600...0000 (ERC-20 + EIP-3009)                  |
 |       +--- reads ReputationWriter ---> ERC-8004 ReputationRegistry |
 |                                                                    |
 |  Memo 0x5294...e505  (settlement receipts, EOA callers only)       |
 |  Multicall3 0xcA11...CA11 (batched reads for the lobby)            |
 +--------------------------------------------------------------------+
```

There is no backend database. Every number the app shows comes from contract reads or event logs on Arc. The only server-side component is the optional gasless relayer, and the app works fully without it (bidders just pay their own gas, about a third of a cent).

## Smart contracts

All contracts are Solidity 0.8.28, compiled with the optimizer and `via_ir`, built and tested with Foundry. OpenZeppelin 5.1 provides `Ownable`, `ReentrancyGuard` and `ERC721URIStorage`.

### AuctionHouse

The auction engine. One contract holds every lot, every bid and every balance.

| Function | Caller | What it does |
|---|---|---|
| `list(kind, asset, id, amount, lotURI, reserve, durationSecs, minIncrement)` | seller | Validates limits (reserve <= `maxReserve`, step > 0, duration > 0, on-chain assets must be allowlisted). OFFCHAIN: pulls the bond and mints a lot NFT into `LotVault`. ERC721/ERC1155/ERC20: moves the asset into `LotVault` and checks it arrived exactly (ownerOf / balance increase). Emits `Listed`. |
| `bid(lotId, amount)` | anyone except the seller | Runs `_bidCore`, uses the caller's Gavel balance first (`CreditUsed`), then pulls only the rest with `transferFrom`. |
| `bidWithAuthorization(lotId, amount, topUp, from, validAfter, validBefore, salt, v, r, s)` | relayer, for a signer | `credit = amount - topUp` comes from the signer's Gavel balance; only `topUp` is pulled with `USDC.receiveWithAuthorization`. The nonce binds lot, amount, top-up, chain and contract. Emits `RelayedBid`. |
| `settle(lotId)` | anyone, after the deadline | Marks the lot settled. If sold: credits the seller with the winning bid, moves the NFT to the winner, holds the bond. If unsold: credits the bond back and returns the NFT to the seller. Emits `Hammer` and `BondHeld`, or `Unsold`. |
| `confirmDelivery(lotId)` | winner | Releases the bond to the seller. |
| `releaseBondAfterTimeout(lotId)` | anyone, 7 days after settle | Releases the bond to the seller if no dispute was raised. |
| `dispute(lotId)` | winner, within 7 days | Freezes the bond pending arbitration. |
| `resolveDispute(lotId, sellerAtFault)` | owner | Sends the bond to the winner (seller at fault) or to the seller. |
| `resolveDisputeTimeout(lotId)` | anyone, 14 days after settle | If the owner never arbitrated, releases the bond to the seller. |
| `claim()` | anyone | Sends the caller their whole `claimable` balance. |
| `cancel(lotId)` | seller or owner, while there are no bids | Credits the bond back; the seller reclaims the asset with `claimLotAsset`. |
| `claimLotAsset(lotId, to)` | winner (sold) or seller (unsold/cancelled) | Sends the escrowed asset to any address the claimant chooses. Once only. |
| `releaseEscrow(lotId)` | anyone, 7 days after an off-chain sale with no dispute | Pays the seller the held payment + bond. |
| `refundBuyer(lotId, reason)` | seller of an off-chain lot | Sends the payment back to the buyer's wallet and the bond to the seller, with a reason (max 280 bytes) in `BuyerRefunded`. |
| `submitEvidence(lotId, text)` | buyer or seller of an off-chain lot, while escrow is held or disputed | Records a note or link (max 1,000 bytes, 10 per party) in an `Evidence` event. |
| `setAllowedAsset(asset, kind, allow)` / `setMaxReserve(n)` | owner | Curates which token contracts can be auctioned; adjusts the reserve cap (max 100,000 USDC). |
| `pause()` / `unpause()` | owner | Halts `list` and `bid`. Never blocks `settle`, `claim` or the bond functions, so funds can always leave. |
| `setReputationWriter(rw)` | owner | Wires the optional reputation contract (unset on mainnet). |
| `renounceOwnership()` | nobody | Disabled, so the contract can never be stuck paused with no owner. |

The core bid logic, `_bidCore(bidder, lotId, amount)`, enforces, in this order:

1. the lot exists, is not settled or cancelled, and its deadline has not passed;
2. `bidder != lot.seller` (no shill bidding, for both bid paths);
3. `amount > 0`;
4. the first bid is at least the reserve, and every later bid is at least `highestBid + minIncrement`;
5. effects before interactions: the previous leader is credited to `claimable`, the new leader is recorded, and if fewer than 10 seconds remain (and fewer than 30 extensions have happened) the deadline becomes `now + 10`.

Only after all state is written does the contract pull the bidder's USDC.

**Constants:** `maxReserve = 1,000 USDC` (owner-adjustable, never above `MAX_RESERVE_CAP = 100,000 USDC`), `SOFT_CLOSE_WINDOW = 10 s`, `MAX_EXTENSIONS = 500`, `DELIVERY_WINDOW = 7 days`, `DISPUTE_RESOLVE_TIMEOUT = 14 days`.

**Events:** `Listed`, `Bid`, `RelayedBid`, `Outbid`, `Extended`, `Hammer`, `Unsold`, `Claimed`, `Cancelled`, `BondHeld`, `BondReleased`, `Disputed`, `DisputeResolved`, `ReputationWriterUpdated`. Together they let anyone rebuild the full history of every lot from logs alone, which is exactly what the `/proof` page does.

### GavelLot

An ERC-721 (`ERC721URIStorage`) whose only minter is the AuctionHouse. Each listing mints one token, whose `tokenURI` is the lot's metadata. Owning the token is the on-chain proof that you won the lot.

### LotVault

Holds every listed NFT until the auction resolves. Only the AuctionHouse can call `release(to, tokenId)`. It uses `transferFrom` rather than `safeTransferFrom` on purpose: a winner that is a contract without an `onERC721Received` hook must not be able to make `settle()` revert forever and trap the seller's money (test 36).

### ReputationWriter

Connects Gavel to ERC-8004. A seller links their ERC-8004 agent identity with `linkSeller(agentId)`, and the contract checks they own it. After a sale's bond is released, anyone can call `recordSale(lotId)`, which writes +1 feedback (clean sale) or -1 (disputed) to the mainnet ReputationRegistry and counts clean sales. Self-sales never count. The AuctionHouse can read `cleanSalesView` to halve the bond for sellers with three clean sales, but that discount is switched off on mainnet until sybil resistance exists (see Limitations).

### Mainnet addresses (chain 5042)

| Contract | Address | Source |
|---|---|---|
| AuctionHouse | [`0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6`](https://explorer.arc.io/address/0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6) | [Sourcify exact match](https://repo.sourcify.dev/5042/0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6) |
| GavelLot | [`0x871aDBA28fC21240E7020894292707e17e061222`](https://explorer.arc.io/address/0x871aDBA28fC21240E7020894292707e17e061222) | [Sourcify exact match](https://repo.sourcify.dev/5042/0x871aDBA28fC21240E7020894292707e17e061222) |
| LotVault | [`0x226e779B81c6365a4b8f62c8FCAeB71799f54269`](https://explorer.arc.io/address/0x226e779B81c6365a4b8f62c8FCAeB71799f54269) | [Sourcify exact match](https://repo.sourcify.dev/5042/0x226e779B81c6365a4b8f62c8FCAeB71799f54269) |
| ReputationWriter | [`0x98719b8AA176C0bB07a6863880F11be8f5bF1569`](https://explorer.arc.io/address/0x98719b8AA176C0bB07a6863880F11be8f5bF1569) | [Sourcify exact match](https://repo.sourcify.dev/5042/0x98719b8AA176C0bB07a6863880F11be8f5bF1569) |
| Owner | `0xBa6A590E4215CDE9448cd01A0B86531476E4dA0F` | the builder's own wallet |

External contracts used: USDC `0x3600000000000000000000000000000000000000` (6 decimals), Memo `0x5294E9927c3306DcBaDb03fe70b92e01cCede505`, Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`, ERC-8004 IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, ERC-8004 ReputationRegistry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. Each was checked with `eth_getCode` on mainnet before deployment.

## Gasless bidding in one signature

Bidding should feel like pressing a button, not like operating a wallet. With a gasless bid the bidder signs one message and sends no transaction at all.

**Flow**

1. The app picks a random 32-byte `salt` and computes
   `nonce = keccak256(abi.encode(AuctionHouse, chainId, lotId, amount, salt))`.
2. The bidder signs an EIP-712 `ReceiveWithAuthorization` for USDC: `from = bidder`, `to = AuctionHouse`, `value = amount`, `validAfter`, `validBefore`, `nonce`.
3. The app posts the signature and parameters to the relayer.
4. The relayer checks that the lot is live, that the amount is a valid next bid, that the bidder holds enough USDC, and the per-address rate limit and daily cap. Then it calls `bidWithAuthorization` and pays the gas.
5. The AuctionHouse recomputes the same nonce from the arguments it was given, runs the bid logic, and calls `USDC.receiveWithAuthorization`. USDC verifies the signature and moves exactly `amount` from the bidder to the AuctionHouse.

**Why the relayer cannot cheat**

- The nonce binds the lot, the amount, the chain and the contract. If a relayer submits a different lot or amount, the contract computes a different nonce, the signature no longer matches, and USDC reverts (tests 20, 21, 23).
- It is `receive`WithAuthorization, not `transfer`WithAuthorization. USDC enforces `msg.sender == to`, so only the AuctionHouse can redeem the signature, and it cannot be replayed as a plain transfer anywhere else.
- USDC marks every nonce as used, so the same signature cannot be submitted twice (test 22).
- An expired `validBefore` is rejected (test 24).
- A seller cannot sneak in a bid on their own lot through the relayer either (test 34).

The first version of this design used a random nonce plus a second signature. Arc Studio's own review caught that the lot ID was not bound into the signed data, so a relayer could have redirected a bid to a different lot. The single-signature, bound-nonce design replaced it.

## Money flows and the accounting invariant

During an auction Gavel never sends USDC anywhere: outbid bids go to the bidder's Gavel balance (`claimable`), where they can be withdrawn with `claim()` or reused for the next bid. Once an off-chain escrow closes (confirm, release, refund or ruling), the payout is sent straight to the recipient's wallet; if that transfer fails, it falls back to their `claimable` balance, so one bad address can never block anything.

| Event | USDC into the contract | Credited to `claimable` |
|---|---|---|
| `list` | bond (= reserve) from the seller | |
| `bid` / `bidWithAuthorization` | the bid amount from the bidder | the previous leader gets their bid back |
| `settle` (sold) | | the seller gets the winning bid; the bond stays held |
| `settle` (unsold) | | the seller gets the bond back |
| `confirmDelivery` / `releaseBondAfterTimeout` / `resolveDisputeTimeout` | | the seller gets the bond |
| `resolveDispute` (seller at fault) | | the winner gets the bond |
| `cancel` | | the seller gets the bond |
| `claim` | out: the caller's whole balance | set to 0 |

**Invariant:** the contract's USDC balance always equals the sum of all `claimable` balances, plus every live lot's current highest bid, plus every unreleased bond. Test 15 checks it step by step through a full list, bid, outbid, settle, release and claim sequence. Test 37 replays a real three-bid auction (0.70, 0.98, 1.26, the numbers from testnet lot #115) and asserts that after everyone claims, the contract holds exactly zero.

## The web app

React 18, Vite and Tailwind; wagmi v2 and viem; RainbowKit for any browser-extension EVM wallet (MetaMask, Rabby, OKX, Coinbase, Brave and others) plus WalletConnect; Motion for animation. Light and dark themes.

| Page | What it shows |
|---|---|
| **Landing** (`/`) | The pitch, the live lot that ends soonest, live totals from chain (volume, bids, distinct bidders, lots settled), and an animation comparing a late bid on a 12-second chain with the same bid on Arc. |
| **Lots** (`/lots`) | Every live lot sorted by time left, plus recently ended lots, loaded with Multicall3 in one batched read. |
| **Auction room** (`/lot/:id`) | The product. A countdown driven by **block timestamps**, not the browser clock, that flashes when the clock extends. Current high bid and leader ("You are winning" / "You won"). Bid history streaming in, newest first, each row linking to the explorer. One Bid button with the exact next valid amount, with a gasless option. The outbid banner with one-tap Withdraw. Settle via Memo, confirm delivery and dispute. |
| **Create** (`/create`) | List a lot: title, reserve, step and duration (10 minutes to 7 days). Approves the bond and lists. |
| **Me** (`/me`) | Three tabs, Bidding, Won and Selling, plus your claimable balance with one-tap Withdraw. |
| **Proof** (`/proof`) | Every market event read live from chain, no wallet needed: listings, bids, relayed bids, extensions, hammers and claims, with totals for USDC moved, bids placed and distinct bidders. |

**Network fees.** Every transaction estimates gas with `estimateContractGas` (plus 30% headroom) and reads `estimateFeesPerGas`, never going below Arc's 20 gwei base-fee floor. A transaction that would revert is reported to the user before they sign, rather than failing on-chain. Gas is never hardcoded.

**Reading the chain efficiently.** One shared block poller drives every component, and pauses when the tab is hidden. Event logs load in 10,000-block chunks (the most the public RPC allows), are cached in the browser, and back off on `-32005` rate-limit responses with a visible "The public Arc RPC is busy. Retrying in N s" message instead of silently freezing.

## The relayer

The gasless relayer is a single TypeScript handler ([`app/relayer/handler.ts`](app/relayer/handler.ts)) that runs either as a Vercel Function (`/relay/bid`, `/relay/stats`) or as a local Bun server. It holds one small hot wallet funded with a few dollars of USDC.

- Validates every request against the chain before spending gas: the lot exists and is live, the contract is not paused, the amount is a valid next bid, and the bidder holds enough USDC.
- Per-address limits: 5 relayed bids per minute and 100 USDC of relayed bids per day.
- Pays at least the 20 gwei floor. If no receipt arrives within 15 seconds it re-sends with the same nonce at 1.5 times the fee.
- Reports `relayedBids` and the total gas spent in USDC (`receipt.gasUsed * effectiveGasPrice / 1e18`).

The relayer never holds bidders' funds. USDC moves straight from the bidder to the AuctionHouse inside `receiveWithAuthorization`.

## Arc-specific engineering

Things that only show up when you actually build on Arc, and how Gavel handles each:

| Trap | What we do |
|---|---|
| USDC has 18 decimals as the native balance and 6 through the ERC-20 interface | All contract maths uses the 6-decimal ERC-20 interface. `msg.value` is never used. Relayer gas is reported by dividing native wei by 1e18. |
| Transactions below the 20 gwei base fee disappear silently, with no error and no receipt | Every client and the relayer floor the fee at 20 gwei. |
| Blocklisted addresses revert transfers and still burn gas | Bids are refunded to a balance, never pushed; escrow payouts try the wallet and fall back to the balance if the transfer fails. |
| `eth_getLogs` is capped at 10,000 blocks per call | Chunked log loading, sized to the cap. |
| The public RPC rate-limits under load (`-32005`, HTTP 429) | Batched reads, one shared poller, exponential backoff, a browser cache, and a `VITE_RPC_URL` override for a dedicated RPC. |
| viem's `multicall` needs Multicall3 declared on the chain object | Declared at `0xcA11...CA11`, which exists on Arc mainnet and testnet. |
| Memo accepts direct EOA callers only | Settlement through Memo is sent from the user's wallet. Smart-contract wallets fall back to a plain `settle()`. |
| Block timestamps can repeat | Used for deadlines only, never for ordering. |

## Proof on Arc mainnet

- **Deploy (v7):** AuctionHouse in block 28,065,938, tx [`0xad6537e1...0c03`](https://explorer.arc.io/tx/0xad6537e1f54b167bdd9b7ed66c35157871a152e3523929518b6ee9eff4500c03). EURC and ERC-8004 identities allowlisted in txs [`0xe575e017...52ec`](https://explorer.arc.io/tx/0xe575e0179f1764f2ec8f795a067382dbe1da55bfe25c9f1e87c74ac7655f52ec) and [`0xcafe61bc...2e21`](https://explorer.arc.io/tx/0xcafe61bca3316f80136a81b44d7a457d9a86945f665979d6e096d920d6252e21). The first mainnet auction (lot #0) ran on v6 `0x24D8...56dd` and stays there. ReputationWriter tx [`0xc64d48e7...c419`](https://explorer.arc.io/tx/0xc64d48e7e148f8b1c3089012a6e6c0fb3b7c10aad22e87ad24ef96496a67c419). Total deploy gas 4,070,482, which cost 0.082 USDC.
- **Verified:** all four contracts match their source exactly on Sourcify, and their wiring was checked on-chain (`usdc()`, `owner()`, `lotVault()`, `gavelLot()`, `auctionHouse()`, `reputationRegistry()`).
- **Activity:** every mainnet transaction is listed with explorer links in [PROOF.md](PROOF.md), and the live `/proof` page recomputes the totals from chain.
- **Testnet history:** six AuctionHouse versions were deployed to Arc testnet during the build. A full end-to-end run (gas bid, gasless bid, last-second extension, settle, refund claim, delivery confirmation) passed on the final version before mainnet, and those hashes are in PROOF.md too.

## Measured gas and cost

Measured from transaction receipts of the same bytecode. Cost is at 25 gwei, a typical Arc price; Arc's floor is 20 gwei.

| Action | Gas | Cost in USDC |
|---|---:|---:|
| List a lot (mint NFT into vault, post bond) | 427,667 | 0.0107 |
| Bid | 115,569 | 0.0029 |
| Gasless bid (paid by the relayer) | 144,648 | 0.0036 |
| Bid in the last 10 seconds (extends the clock) | 132,383 | 0.0033 |
| Settle (NFT and payment in one transaction) | 128,668 | 0.0032 |
| Claim | 53,373 | 0.0013 |
| Confirm delivery | 43,308 | 0.0011 |
| Deploy everything (AuctionHouse, GavelLot, LotVault, ReputationWriter) | 4,070,482 | 0.082 |

A whole auction with three bids, a settlement and two claims costs about 2 cents of gas across all participants.

## Security

**How it was reviewed**

1. **83 Foundry tests**, the first 37 listed in full below.
2. **Slither** static analysis: no medium or high findings. The remaining informational items (timestamp comparisons for deadlines, a reentrancy note on `list` behind `nonReentrant`, a missing zero-check where `address(0)` intentionally disables reputation) are by design.
3. **A line-by-line internal review**, written up in [AUDIT.md](AUDIT.md).
4. **An independent Arc Studio review** (turn 21), which judged each fix and flagged the owner's cancel power as a centralisation point.
5. The mainnet deploy script re-runs all 83 tests and refuses to deploy if any fail.

**The bug we found on-chain.** While testing with two real wallets on testnet, lot #115 showed the seller bidding on their own auction. The money all reconciled to the cent, but the behaviour should never have been possible. It triggered the full review, and three fixes went in before mainnet:

| Severity | Issue | Fix | Test |
|---|---|---|---|
| High | A seller could bid on their own lot (shill bidding), directly or gasless | `require(bidder != lot.seller)` inside `_bidCore`, covering both paths. The UI hides the Bid button for the seller. | 29, 34 |
| Medium | A winning contract without an ERC-721 receiver hook could make `settle()` revert forever, locking the seller's proceeds and bond | `LotVault.release` uses `transferFrom` | 36 |
| Low | A zero bid on a zero-reserve lot won for free and blocked `cancel()` | `require(amount > 0)` | 35 |

**Design choices that limit damage**

- No USDC is sent during an auction; payouts after it fall back to a pull balance if a transfer fails.
- `nonReentrant` on every state-changing function, and checks-effects-interactions ordering throughout (test 16 attacks `claim` with a reentrant receiver).
- `pause()` stops new listings and bids but can never block settlement, claims or bond releases.
- Ownership cannot be renounced, so the contract cannot be left paused with nobody able to unpause it.
- The owner cannot move anyone's funds. Owner powers are pausing, cancelling a lot that has no bids, and arbitrating disputes, with a 14-day permissionless fallback.
- The reserve is capped at 1,000 USDC while the code has no third-party audit; bids and steps are uncapped. Only allowlisted token contracts can be auctioned.

This is an internal review plus an Arc Studio review, not a professional third-party audit. Use small amounts.

## Test suite

Run with `forge test` in `onchain/`. All 83 pass. Tests 38-53 cover the v7 lot kinds and escrow; 54-59 are the attack tests from the v7 audit (see AUDIT.md). The original 37:

| # | Test | What it proves |
|---|---|---|
| 1 | HappyPath_ListBidSettle | List, three bids, settle: the winner holds the NFT, the seller is credited, the bond is held |
| 2 | SoftClose_ExtendDeadline | A bid at T-3 s moves the deadline to now + 10 s |
| 3 | MaxExtensions_Cap | After 30 extensions the clock stops extending, so the auction ends |
| 4 | TwentyLateBids_ExtendAndSettle | Twenty consecutive last-second bids extend correctly and settle cleanly |
| 5 | RevertBelowReserveAndIncrement | Bids below the reserve or below the step revert |
| 6 | BidAfterDeadlineReverts | No bids after the deadline |
| 7 | OutbidCreditsClaimableAtomically | The outbid bidder is credited in the same transaction |
| 8 | BlocklistedAddressCannotBlockOthers | A bidder who cannot receive USDC cannot block anyone else's claim |
| 9 | SettleNoBids_ReturnsBondAndNFT | Unsold lots return the NFT and the bond |
| 10 | DoubleSettleReverts | A lot settles once |
| 11 | SettleAtomicity_NFTAndCreditSameTx | The NFT transfer and the seller credit happen together or not at all |
| 12 | TinyLot_EndToEnd | A tiny 6-decimal lot runs end to end through bid, outbid, settle and claim |
| 13 | BondLifecycle | The bond is held at the hammer and released on delivery or after 7 days |
| 14 | DisputeResolution | Dispute, owner resolution both ways, and the 14-day fallback |
| 15 | AccountingInvariant | The contract balance equals all claimables plus live bids plus held bonds, at every step |
| 16 | ReentrancyOnClaim | A malicious receiver cannot claim twice |
| 17 | PauseBehaviour | Pause blocks list and bid; settle and claim still work |
| 18 | Cancel | The seller or owner can cancel only while there are no bids |
| 19 | RelayedBid_HappyPath | A zero-gas wallet bids; the relayer pays the gas and is not the bidder |
| 20 | RelayedBid_WrongLotId_Reverts | A relayer cannot move a signed bid to another lot |
| 21 | RelayedBid_WrongAmount_Reverts | A relayer cannot change the amount |
| 22 | RelayedBid_Replay_Reverts | The same signature cannot be used twice |
| 23 | RelayedBid_WrongContract_Reverts | A signature for another contract is rejected |
| 24 | RelayedBid_ExpiredValidBefore_Reverts | Expired signatures are rejected |
| 25 | RelayedBid_SoftClose_AndRefund | Gasless bids extend the clock and refund the outbid bidder |
| 26 | RecordSale_OnlyAfterBondReleased | Reputation is written only after the bond resolves |
| 27 | RecordSale_AlreadyRecorded_Reverts | Each sale is recorded once |
| 28 | RecordSale_Negative_OnDispute | Disputed sales write negative feedback |
| 29 | SellerCannotBidOwnLot | The seller's direct bid reverts |
| 30 | BondDiscount_After3CleanSales | The optional 50% bond discount after three clean sales |
| 31 | CleanSalesViewRevert_DoesNotBlockList | A broken reputation contract can never block listing |
| 32 | LinkSeller_WrongOwner_Reverts | You can only link an ERC-8004 identity you own |
| 33 | ReputationWriterUpdated_EventEmitted | Owner changes are logged |
| 34 | SellerCannotBidOwnLot_Relayed | The seller's gasless bid reverts too |
| 35 | ZeroBidReverts | No free wins on zero-reserve lots |
| 36 | NFTRejectingWinnerCannotBlockSettle | A hostile winner contract cannot lock the seller's funds |
| 37 | FundsConservation_FullLifecycle | Replays lot #115's numbers; after all claims the contract holds zero |

## How it was built in Arc Studio

Gavel was built in one Arc Studio project ([studio.arc.io/app/d49aa346...](https://studio.arc.io/app/d49aa346-328f-49aa-b5c9-62e187eca7ed)) over 29 turns between 17 and 28 October 2026. Studio wrote and tested the contracts, built the app and the relayer, and deployed every testnet version. [STUDIO.md](STUDIO.md) logs each turn: the prompt, what Studio produced, what it got wrong, and what was corrected. The exact prompts are in [`prompts/`](prompts).

| Turns | Date | What was built | Notable |
|---|---|---|---|
| 1-2 | 17 Oct | Core contracts, bond and disputes, 18-test matrix | Pull payments chosen over push refunds because of the USDC blocklist. Studio added the 14-day dispute fallback itself. |
| 3, 3b-d | 17-22 Oct | Live auction room, lobby, create, me, /proof; shared log store | Studio guessed the deploy block 67 million blocks wrong; caught by reading the deploy receipt. |
| 4, 4b | 22 Oct | Gasless bidding, relayer, rate-limit-aware loading | Studio's own review caught the lot-binding flaw in the first gasless design. |
| 5, 5b-c | 22-23 Oct | Memo receipts, ERC-8004 reputation, one-signature gasless bids | 33 tests. |
| 6-7 | 23 Oct | Polish, a real relayer test | A test-only signature bypass was removed. |
| 8-20 | 23-24 Oct | Redesign, landing page, durations, accessibility, RPC resilience | Bugs found only by running the full stack against the real chain. |
| 21 | 25 Oct | Pre-mainnet security fixes reviewed, tested (37/37) and redeployed by Studio | |
| 22 | 25 Oct | App repointed at mainnet | |

Arc Studio deploys to testnet only, so the mainnet contracts were deployed with `arc-forge` from the builder's own wallet, from exactly the same source Studio had tested. The deploy script asks for the key interactively, so the key never touches a file. Twelve small fixes were made by hand outside Studio, mostly when the usage limit was reached. Each is listed in STUDIO.md and was uploaded back into the Studio project before the next turn, so the Studio project and this repository match.

## What we got wrong

Dated, and kept rather than edited away.

- **17 Oct.** The first refund design pushed USDC to the outbid bidder. One blocklisted address would have frozen every auction. Changed to pull payments.
- **17 Oct.** `DEPLOY_BLOCK = 400000n` was a guess; the real deploy block was 67,707,191. The lobby scanned the wrong range and showed nothing. Fixed from the deploy receipt.
- **22 Oct.** The first gasless design used a random nonce, so a relayer could re-target a signed bid to another lot. Lot, amount, chain and contract are now bound into the nonce.
- **24 Oct.** `/lots` showed loading skeletons forever: viem's multicall needs Multicall3 declared on the chain object, and it wasn't. Added it, and moved every component to one shared block poller instead of each polling the RPC.
- **24 Oct.** A hand-written `Listed` event ABI did not match the contract, so event decoding silently found nothing. Replaced with the compiled ABI everywhere.
- **24 Oct.** The countdown was 11 seconds off because the test PC's clock was behind the chain. The clock now runs on chain time.
- **24 Oct.** Cached logs showed "NaN USDC" because `bigint` values do not survive `JSON.stringify`. Added tagged serialisation and dropped stale caches.
- **24 Oct.** A seller could bid on their own lot. Seen on testnet lot #115 and fixed before mainnet.

## Limitations

- **Off-chain items still need the seller to deliver.** Since v7 the winning payment is held in escrow until the winner confirms, the seller refunds, or the 7-day window ends; a dispute goes to the owner, and if the owner does not rule within 14 days the payment is split 50/50. On-chain lots (NFTs, ERC-1155, ERC-20) need no trust at all: the asset is escrowed at listing.
- **Shill bidding from a second wallet** cannot be prevented by any auction contract. The seller's own wallet is blocked; for everything else, the bid history is public.
- **The owner** can pause new listings and bids, cancel a lot that has no bids, and arbitrate disputes. The owner cannot move anyone's funds, and disputes resolve without the owner after 14 days.
- **The reputation bond discount is off on mainnet.** Without sybil resistance, a seller could farm clean sales by winning their own lots from a second wallet.
- **Memo settlement needs a plain wallet**, because Memo only accepts direct EOA callers. Smart-contract wallets fall back to a plain `settle()`.
- **The gasless relayer is a small hot wallet.** It is rate-limited per address and capped per day. If it runs dry, bidders can still bid normally.
- **On a serverless host,** the relayer's rate limits are kept per running instance rather than globally.
- **The public Arc RPC** rate-limits heavy log reads. The app backs off and caches; a dedicated RPC can be set with `VITE_RPC_URL`.

## What a microgrant would fund

| # | Milestone | What it proves | How it is measured |
|---|---|---|---|
| 1 | **AI-agent bidders:** an agent wallet with on-chain spending caps bidding through the gasless relayer | People and agents competing in one live market, with AuctionHouse used as a composable primitive | Agent bids on mainnet, each within its cap |
| 2 | **Delivery attestation for physical lots**, so the bond is released or slashed without an arbiter | The owner is no longer needed to settle disputes | Disputes resolved without `resolveDispute` |
| 3 | **Reputation-sized bonds with sybil resistance**, building on the ERC-8004 feedback already written | Trusted sellers post less capital without enabling self-dealing | Bond size against verified clean sales |
| 4 | **Cross-chain bidders via CCTP** | A bidder holding USDC on another chain joins an Arc auction | Bids whose funds arrived through CCTP |
| 5 | **Seller tools:** scheduled auctions, multi-lot sales and batch settlement | Real sellers running regular sales | Repeat sellers and lots per seller |

## Run it yourself

**Contracts**

```bash
git clone https://github.com/timix648/gavel && cd gavel/onchain
forge install foundry-rs/forge-std --no-git
npm install @openzeppelin/contracts@5.1.0
forge test        # 83 tests
```

**Web app**

```bash
cd app
bun install
bun run dev       # http://localhost:5173, reads Arc mainnet
```

Every address and chain setting lives in [`app/src/chain.ts`](app/src/chain.ts). Set `VITE_RPC_URL` to use a dedicated RPC.

**Relayer (optional)**

```bash
cd app
RELAYER_PRIVATE_KEY=0x... bun relayer/index.ts      # local, port 3001
```

On Vercel the same handler runs as `api/relay/[action].ts`; set `RELAYER_PRIVATE_KEY` in the project's environment variables. Never commit keys.

**Deploy your own copy**

```bash
bash deploy-mainnet.sh    # re-runs the tests, asks for your key interactively, prints the addresses
```

## Project structure

```
gavel/
  onchain/
    contracts/
      AuctionHouse.sol        the auction engine
      GavelLot.sol            ERC-721 lot token
      LotVault.sol            escrow for listed lots
      ReputationWriter.sol    ERC-8004 reputation bridge
      test/AuctionHouse.t.sol 83 Foundry tests
      test-helpers/           MockUSDC with EIP-3009, mock ERC-8004 registries
  app/
    src/
      pages/                  Landing, Lobby, AuctionRoom, Create, Me, Proof
      components/             Layout, LotCard, AuctionPanel
      chain.ts                every address and chain setting
      txGas.ts                gas and fee estimation for every transaction
      useBlock.ts             one shared chain-time block poller
      logStore.ts             chunked, cached, rate-limit-aware event loading
    relayer/                  gasless relayer handler and local Bun server
    api/relay/                the same relayer as a Vercel Function
  prompts/                    every Arc Studio prompt, turn by turn
  deploy-mainnet.sh           mainnet deploy with tests and an interactive key prompt
  STUDIO.md                   build history in Arc Studio
  AUDIT.md                    security review
  PROOF.md                    every deployment and transaction
  JUDGE.md                    60-second path for reviewers
  WRITEUP.md                  submission write-up
```

## FAQ

**Do I need a special wallet?** No. Any browser-extension EVM wallet works, as does WalletConnect. If your wallet is on another network, the app asks it to switch to Arc.

**Do I need gas?** On Arc, gas is paid in USDC, so if you hold USDC you can bid. With a gasless bid you don't even need that: you sign once and the relayer pays.

**What happens to my money if I'm outbid?** It is credited to you in the same transaction that outbid you. Press Withdraw at any time to receive everything you're owed, from every auction, in one transaction.

**Can the seller bid on their own lot?** Not from their own wallet. The contract rejects it, for normal and gasless bids alike.

**What if the seller never delivers?** Open a dispute within 7 days of the hammer. If the seller is found at fault, you receive their bond.

**Can an auction run forever?** No. Each lot can be extended at most 500 times, and every extension needs a real, higher bid that locks real USDC.

**Who can settle?** Anyone, once the deadline passes. Usually the winner or the seller does it from the auction room.

**Is the code audited?** It has been reviewed internally, with Slither and by Arc Studio, and it is fully tested, but it has not had a professional third-party audit. Amounts are capped in v1.

## License

MIT. See [LICENSE](LICENSE).
