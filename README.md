<div align="center">

# Gavel

### A live auction house where every bid is a USDC transaction on Arc mainnet

The auction ends when the bidding does: a bid in the last ten seconds adds ten seconds, the outbid
bidder's USDC is released in the same transaction, and at the hammer the lot and the payment swap in one step.

[![Live on Arc mainnet](https://img.shields.io/badge/▶_Live-Arc_mainnet-06b6d4?style=for-the-badge)](LIVE_URL)
[![For reviewers](https://img.shields.io/badge/⚖_For-reviewers-3ddc84?style=for-the-badge)](JUDGE.md)
[![Demo video](https://img.shields.io/badge/▶_Demo-video-FF0000?style=for-the-badge)](VIDEO_URL)
[![Built in Arc Studio](https://img.shields.io/badge/Built_in-Arc_Studio-8b5cf6?style=for-the-badge)](https://studio.arc.io/app/d49aa346-328f-49aa-b5c9-62e187eca7ed)
[![AuctionHouse](https://img.shields.io/badge/AuctionHouse-0x24D8…56dd-4ea1ff?style=for-the-badge)](https://explorer.arc.io/address/0x24D890c1285D481cB6B8761318A8250C922956dd)

![Arc](https://img.shields.io/badge/Arc-mainnet_5042-4ea1ff?style=flat)
![USDC-as-gas](https://img.shields.io/badge/gas-USDC-3ddc84?style=flat)
![Solidity](https://img.shields.io/badge/Solidity_0.8.28-363636?style=flat&logo=solidity&logoColor=white)
![Foundry](https://img.shields.io/badge/Foundry-37_tests-3ddc84?style=flat)
![Sourcify](https://img.shields.io/badge/Sourcify-exact_match_×4-3ddc84?style=flat)
![EIP-3009](https://img.shields.io/badge/gasless-EIP--3009-06b6d4?style=flat)

</div>

---

**In three lines**

- **Problem:** online auctions either trust a platform with the money or, on-chain, cannot do a soft close: on a 12-second chain, a "last 10 seconds" bid lands after the auction has closed, and every bidder needs ETH for gas as well as USDC.
- **On Arc:** sub-second deterministic finality makes a 10-second soft close real, USDC is the only asset a bidder needs (and with a one-signature gasless bid, not even gas), and settlement swaps the lot NFT and the payment atomically.
- **Proof:** four contracts on Arc mainnet, all source-verified on Sourcify (exact match); 37 Foundry tests; a bid costs about $0.003 and a gasless bid about $0.004; every hash in [PROOF.md](PROOF.md), and a live [/proof](LIVE_URL/proof) page that reads the chain with no wallet.

---

## 💡 The problem

**Trust.** On an auction site the platform holds the money, decides who won and when the seller is paid. Both sides trust the operator.

**Timing.** Sniping, a bid in the final second that nobody can answer, is solved off-chain with a *soft close*: any late bid extends the clock. On-chain that has been impossible. With 12-second blocks, a 10-second window is shorter than one block, finality is probabilistic, the public mempool lets bots outbid a winning bid, and a bidder needs two assets. Auctions on other chains end up as a few discrete rounds, not a live room.

## 🔨 What Gavel does

| | |
|---|---|
| **Seller** | Lists a lot: title, reserve (≤ 5 USDC in v1), bid step and duration. Live: 10, 15 or 30 minutes. Timed: 1 h to 7 days. Listing mints a lot NFT straight into an escrow vault and posts a bond equal to the reserve. |
| **Bidder** | Taps **Bid $X**, the exact next valid amount. Either a normal USDC transaction or a **gasless** bid: one signature, no transaction, no gas. |
| **Outbid** | Your USDC becomes claimable in the same transaction as the bid that beat you. One **Withdraw** pulls everything you are owed across all auctions. |
| **Last 10 seconds** | A bid with under 10 s left sets the deadline to now + 10 s (max 30 extensions, so it always ends). The clock visibly jumps. |
| **Hammer** | `settle()` moves the NFT to the winner and credits the seller in one transaction, sent through Arc's **Memo** contract so it carries a receipt keyed to the lot. |
| **Delivery** | The seller's bond stays locked until the winner confirms delivery, or 7 days pass. The winner can dispute; the owner arbitrates, with a permissionless fallback after 14 days so bonds never lock. |

Every lot is listed by a real seller. There are no automated or house auctions.

## 🔵 Why this needs Arc, and only Arc

| Arc property | Where Gavel depends on it |
|---|---|
| **Sub-second deterministic finality** | The 10-second soft close ([`AuctionHouse.sol` `_bidCore`](onchain/contracts/AuctionHouse.sol)). A bid at T-4 s lands before the close and extends it. On 12-second blocks it would land after. |
| **USDC is the gas token** | A bidder holds one asset. The relayer's gas bill is in dollars: about $0.004 per gasless bid. |
| **EIP-3009 on native USDC** | One-signature gasless bids via `receiveWithAuthorization` ([`bidWithAuthorization`](onchain/contracts/AuctionHouse.sol)). |
| **No public-mempool front-running** | A winning bid cannot be seen and outbid by a bot before it lands. |
| **Memo contract** | Settlement receipts whose memo ID is the lot ID ([`AuctionRoom.tsx`](app/src/pages/AuctionRoom.tsx)). |
| **USDC blocklist** | Why every payout is a pull (`claimable` + `claim()`): one blocklisted address cannot freeze an auction. |
| **ERC-8004 on mainnet** | [`ReputationWriter`](onchain/contracts/ReputationWriter.sol) records clean sales on the mainnet ReputationRegistry. |

## ✍️ Gasless bidding in one signature

The bidder signs one EIP-3009 `ReceiveWithAuthorization`. The relayer submits `bidWithAuthorization`, USDC pulls exactly that amount from the signer, and the relayer pays the gas. The nonce is not random. It is `keccak256(address(this), chainid, lotId, amount, salt)`, so a relayer cannot change the lot, the amount, the chain or the contract without breaking the signature. Because it is `receive`- rather than `transfer`WithAuthorization, only the AuctionHouse can redeem it. Arc Studio's own review caught that the first design (random nonce) let a relayer move a bid to another lot. The fix is tested in `test_20`–`test_24`.

## 🧾 Proof (Arc mainnet, chain 5042)

| Contract | Address | Source |
|---|---|---|
| AuctionHouse | [`0x24D890c1285D481cB6B8761318A8250C922956dd`](https://explorer.arc.io/address/0x24D890c1285D481cB6B8761318A8250C922956dd) | [Sourcify exact match](https://repo.sourcify.dev/5042/0x24D890c1285D481cB6B8761318A8250C922956dd) |
| GavelLot (lot NFT) | [`0x5f1a8677d47d39D28C75936574B3529686Bb9121`](https://explorer.arc.io/address/0x5f1a8677d47d39D28C75936574B3529686Bb9121) | [Sourcify exact match](https://repo.sourcify.dev/5042/0x5f1a8677d47d39D28C75936574B3529686Bb9121) |
| LotVault | [`0xeD8a17B1e9aF7cA83d501248985A2d8FfC575A2F`](https://explorer.arc.io/address/0xeD8a17B1e9aF7cA83d501248985A2d8FfC575A2F) | [Sourcify exact match](https://repo.sourcify.dev/5042/0xeD8a17B1e9aF7cA83d501248985A2d8FfC575A2F) |
| ReputationWriter | [`0x8865A988DD9ff40a55590C7ce136512bC6A2E1CD`](https://explorer.arc.io/address/0x8865A988DD9ff40a55590C7ce136512bC6A2E1CD) | [Sourcify exact match](https://repo.sourcify.dev/5042/0x8865A988DD9ff40a55590C7ce136512bC6A2E1CD) |

**Measured gas** (from receipts of the same bytecode; cost at 25 gwei, a typical Arc price):

| Action | Gas | Cost |
|---|---:|---:|
| List a lot (mints NFT into vault, posts bond) | 427,667 | $0.0107 |
| Bid | 115,569 | $0.0029 |
| Gasless bid (paid by relayer) | 144,648 | $0.0036 |
| Bid in the last 10 s (extends clock) | 132,383 | $0.0033 |
| Settle (NFT + payment, one tx) | 128,668 | $0.0032 |
| Claim | 53,373 | $0.0013 |
| Confirm delivery | 43,308 | $0.0011 |
| Deploy everything | 4,070,482 | $0.082 (paid) |

Every mainnet transaction, with explorer links: [PROOF.md](PROOF.md). Security review: [AUDIT.md](AUDIT.md). Build history: [STUDIO.md](STUDIO.md).

## 🛡️ Security

- **37 Foundry tests:** the full blueprint matrix (soft close, cap, 20 late bids, reverts, atomicity, pull safety, reentrancy, pause), gasless-bid attacks (wrong lot, wrong amount, replay, wrong contract, expired signature, seller relaying their own bid), bond and dispute lifecycle, and a fund-conservation test that replays a real auction and asserts the contract ends holding zero.
- **Found on-chain, fixed before mainnet:** on testnet lot #115 the seller bid on their own auction. The contract now rejects seller bids (direct and gasless), zero bids, and settlement can no longer be blocked by a winner contract that rejects NFTs. See [AUDIT.md](AUDIT.md).
- **Reviewed three ways:** a line-by-line internal review plus Slither (no medium/high), an independent Arc Studio review (turn 21), and the deploy script re-runs all 37 tests before touching mainnet.
- **Not a third-party audit.** Use small amounts. Reserve is capped at 5 USDC and the bid step at 1 USDC.

## 🏗️ How it was built in Arc Studio

One Arc Studio project, 22 turns, 17–25 October 2026: contracts, tests, the app and the relayer. [STUDIO.md](STUDIO.md) records each turn's prompt, what Studio produced, what it got wrong, and what I corrected. That includes where Studio was strong (it caught the gasless lot-binding flaw and designed the dispute fallback) and where it was not (a deploy block guessed 67 million blocks wrong, a hand-written event ABI that did not match, and the seller-bid bug it never noticed). Studio deploys to testnet only, so mainnet was deployed with arc-forge from the owner's wallet, as Circle's docs describe. Studio then repointed the app (turn 22).

## 🩹 What we got wrong (dated, kept rather than edited away)

- **2026-10-17:** the first refund pushed USDC to the outbid bidder. One blocklisted address would have frozen every auction. Changed to pull payments.
- **2026-10-17:** `DEPLOY_BLOCK = 400000n` was a guess. The real block was 67,707,191, so the lobby scanned the wrong range. Fixed from the deploy receipt.
- **2026-10-22:** the first gasless bid used a random nonce, so a relayer could re-target a bid to another lot. Lot, amount, chain and contract are now bound into the nonce.
- **2026-10-24:** `/lots` never loaded: viem's multicall needs Multicall3 declared on the chain, and Arc's wasn't. Added.
- **2026-10-24:** the keeper used a hand-written `Listed` event ABI that did not match the contract. Replaced with the compiled ABI.
- **2026-10-24:** a seller could bid on their own lot. Seen on testnet lot #115 and fixed before mainnet.

## ⚠️ Limitations (honest)

- If a seller never delivers, the winner recovers the **bond (= reserve), not the full price**. v1 targets digital and creator lots.
- A seller can still shill-bid **from a second wallet**. No auction contract can prevent that; bid history is public.
- The owner can pause listing and bidding, cancel a lot that has no bids, and arbitrate disputes. The owner cannot move anyone's funds.
- Memo settlement needs a plain wallet (Memo requires `msg.sender == tx.origin`). Smart-contract wallets fall back to a plain settle.
- The gasless relayer is a small funded hot wallet with per-address rate limits and a daily cap.
- The app reads events from the public Arc RPC in 10,000-block chunks and backs off when rate-limited.

## 🎯 What a microgrant would fund

| # | Milestone | What it proves |
|---|---|---|
| 1 | **AI-agent bidders:** an agent wallet with on-chain spend caps bidding through the gasless relayer | People and agents in one live market, using AuctionHouse as a composable primitive |
| 2 | **Delivery attestation** for physical lots, so the bond is released or slashed without an arbiter | Removes the owner from disputes |
| 3 | **Reputation-sized bonds with sybil resistance**, building on the ERC-8004 feedback already written | Trusted sellers post less capital |
| 4 | **Cross-chain bidders via CCTP** | A bidder with USDC on another chain joins an Arc auction |

## 🚀 Run it

```bash
git clone REPO_URL && cd gavel
cd onchain && forge test                              # 37 tests
cd ../app && bun install && bun run dev               # frontend on :5173
RELAYER_PRIVATE_KEY=0x... bun relayer/index.ts        # optional gasless relayer
```

All addresses and chain settings live in `app/src/chain.ts`. Never commit keys.

## 📁 Project structure

```
onchain/contracts/        AuctionHouse, LotVault, GavelLot, ReputationWriter
onchain/contracts/test/   37 Foundry tests
app/src/                  React + Vite + wagmi + RainbowKit app (pages: landing, lots, lot room, create, me, proof)
app/relayer/              gasless bid relayer (Bun)
deploy-mainnet.sh         mainnet deploy: re-runs tests, asks for the key interactively
STUDIO.md  AUDIT.md  PROOF.md  JUDGE.md  WRITEUP.md
```

## 📄 License

MIT
