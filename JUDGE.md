# For reviewers

> **A live auction house where every bid is a USDC transaction on Arc mainnet. Late bids extend the clock; the lot and the payment swap in one transaction.**

Live app: https://gavel-alpha.vercel.app · Live proof (no wallet): https://gavel-alpha.vercel.app/proof · Arc Studio project: https://studio.arc.io/app/d49aa346-328f-49aa-b5c9-62e187eca7ed

## The 60-second path (an Arc wallet with ≥ 0.20 USDC; total spend a few cents)
1. Open **https://gavel-alpha.vercel.app/lots** and pick a live lot. If none is live, **Create** one: any title, reserve `0.10`, 10 minutes. You post a 0.10 bond, which comes back to you.
2. From another wallet, tap **Bid $X**. Choose **gasless**: you sign one message, send no transaction and pay no gas. The bid appears in the history with a link to explorer.arc.io.
3. From a third wallet, outbid it. The first bidder sees **You were outbid** and a **Withdraw** button. Their USDC is already claimable, released in the same transaction.
4. Bid with under 10 seconds left: the clock jumps back to 10.
5. Open the lot as its seller: there is no Bid button ("This is your lot"). The contract also rejects it.
6. At zero, **Settle**. One transaction, sent through Arc's Memo contract, moves the lot NFT to the winner and credits the seller. Open it on the explorer.

## No wallet? Read the receipts
| What | Link |
|---|---|
| AuctionHouse, source verified (exact match) | [explorer](https://explorer.arc.io/address/0x6102D866Dcb9CFeE929Eb6b2A16468E9d0193A2E) · [Sourcify](https://repo.sourcify.dev/5042/0x6102D866Dcb9CFeE929Eb6b2A16468E9d0193A2E) |
| Mainnet deploy | [0xa17499ea…](https://explorer.arc.io/tx/0xa17499eaed3ccc04ecb6a6939d9d8b8ec1f90a1e8de1ccd3fb44d0662861d7b2) |
| A gasless bid sent by the relayer | _mainnet hash after the live event_ |
| A bid that extended the clock | _mainnet hash_ |
| Settle via Memo (NFT + payment in one tx) | _mainnet hash_ |
| Every transaction | [PROOF.md](PROOF.md) |

## Receipt block
| | |
|---|---|
| Contracts | AuctionHouse, GavelLot, LotVault, ReputationWriter. All 4 Sourcify exact match on chain 5042. |
| Tests | 59 Foundry. Also Slither (no medium/high) and an Arc Studio review ([AUDIT.md](AUDIT.md)) |
| Gas | bid 115,569 (≈ $0.003) · gasless bid 144,648 (≈ $0.004) · settle 128,668 (≈ $0.003) · list 427,667 (≈ $0.011) |
| Automated activity | none. Every lot is listed by a real seller. |
| Built in Arc Studio | 22 turns, every one logged with what Studio got wrong ([STUDIO.md](STUDIO.md)) |
| Keys held by the app | 1: a small gasless-relayer hot wallet with rate limits and a daily cap |

## Reproduce (read-only)
```bash
git clone https://github.com/timix648/gavel && cd gavel/onchain && forge test     # 59 tests
```

## Honest limitations
- A winner who never receives the lot recovers the bond (= reserve), not the full price.
- A seller can shill from a second wallet; no contract can stop that.
- Internal review plus an Arc Studio review, not a third-party audit. Amounts are capped in v1.
