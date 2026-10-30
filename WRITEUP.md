# Gavel: a live USDC auction house on Arc

**Live app:** https://gavel-alpha.vercel.app · **Arc Studio project:** https://studio.arc.io/app/d49aa346-328f-49aa-b5c9-62e187eca7ed · **Repo:** https://github.com/timix648/gavel

**AuctionHouse on Arc mainnet:** [`0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6`](https://explorer.arc.io/address/0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6)
**Example mainnet transaction:** lot 11 settled for 84.67 USDC, [0xe01c69e1…6652](https://explorer.arc.io/tx/0xe01c69e1dacc7db88511e1514d72b9ad7047829e5f735c15a5f46d99c99b6652)

## One line

A real auction needs bids to land the instant they are made. On Arc, a 10-second soft close actually works, so Gavel runs live English auctions where every bid is a USDC transaction, outbid funds are released in the same transaction, and the lot and payment swap atomically at the hammer.

## The problem

Online auctions have two failures that blockchains were supposed to fix and have not.

**Trust.** On a normal auction site the platform holds the money, decides who won and when to pay the seller. The buyer trusts the site to deliver the payment logic, and the seller trusts it to pay out.

**Timing.** Anyone who has used eBay knows sniping: a bid placed in the final second that nobody can answer. The standard fix is a *soft close*: any bid near the end extends the clock, so the auction ends when bidding stops, not when the timer does. On-chain, that fix has been impossible. On a chain with 12-second blocks, a "10-second soft close" is shorter than one block. A bid sent with four seconds left lands in a block that arrives after the close. The auction becomes a handful of discrete rounds, not a live room. Finality is probabilistic, so the "winner" is not final until confirmations. The public mempool lets bots see and outbid a winning bid. And every bidder needs two assets, ETH for gas and USDC to bid.

Arc removes each of those constraints: sub-second deterministic finality, USDC as the gas token, and no public mempool front-running. Gavel is built around exactly those properties. It is a product that does not work on other chains, rather than one ported to Arc.

## What Gavel does

1. **A seller lists a lot.** It sets a title, a reserve (up to 1,000 USDC), a minimum bid step and a duration: 10, 15 or 30 minutes for a live auction, or 1 hour to 7 days for a timed listing. Listing mints a lot NFT straight into an escrow vault and takes a bond equal to the reserve.
2. **Bidders bid live.** Each bid is a USDC transaction that must beat the current high bid by the step. The previous high bidder's USDC becomes claimable in that same transaction. The room shows a countdown driven by block timestamps, the bid history streaming in, and the exact next valid bid on one button.
3. **Late bids extend the clock.** A bid in the final 10 seconds pushes the deadline to now + 10 seconds, up to 30 times, so the auction always ends.
4. **The hammer is atomic.** `settle()` moves the lot NFT from the vault to the winner and credits the seller with the winning bid in one transaction. Neither side can renege. In the app, settlement goes through Arc's Memo contract, so it carries a reconcilable receipt keyed to the lot.
5. **Delivery protection.** The seller's bond stays locked after the sale. The winner releases it by confirming delivery, or it releases automatically after 7 days. Before that the winner can dispute. The owner arbitrates, with a permissionless fallback after 14 days so a bond can never lock forever.
6. **Money goes back automatically.** Outbid USDC becomes credit that the next bid reuses (you only add the difference) or that you withdraw with one `claim()`. Escrow payouts and refunds are pushed straight to the wallet, falling back to `claimable` if a transfer fails.

## Gasless bidding in one signature

A new user on Arc holds USDC, which is the gas token, so they can transact. Gavel goes one step further: a bidder can bid without sending a transaction at all.

The bidder signs one EIP-3009 `ReceiveWithAuthorization` message. A relayer submits it to `bidWithAuthorization`. USDC pulls exactly that amount from the signer into the AuctionHouse, and the relayer pays the gas. The security detail matters. The authorization nonce is not random: it is `keccak256(address(this), chainid, lotId, amount, salt)`. USDC verifies the signature over the nonce, so a relayer cannot change the lot, the amount, the chain or the contract without breaking it. Because it is `receive`- and not `transfer`WithAuthorization, USDC also enforces that only the AuctionHouse can redeem it, so the signature cannot be replayed as a plain transfer elsewhere. The first design used a random nonce; Arc Studio's own review caught that a relayer could have moved a bid to a different lot, and the fix is in the contract and covered by tests.

## Security, and the bug we found on-chain

While testing with two real wallets, I watched a live testnet lot (#115) where **the seller bid on their own auction**. That is shill bidding: inflating the price against real buyers. The money all added up (I traced every claim to the cent), but the behaviour should never have been possible. It triggered a full review before mainnet:

- **Seller cannot bid on their own lot**, checked inside `_bidCore` so it covers both direct and gasless bids.
- **No zero bids**: a 0-USDC bid on a 0-reserve lot would have won for free and blocked cancellation.
- **A winner contract cannot block settlement**: the vault uses `transferFrom` instead of `safeTransferFrom`, so a winning contract that rejects NFTs cannot make `settle()` revert forever and lock the seller's money.

Each fix has a test, and a dedicated test replays lot #115's exact numbers and checks the contract ends holding zero. Slither reported nothing medium or high. Then Arc Studio reviewed the three fixes independently, judged them correct, flagged the owner's cancel power as a known centralisation point, ran 37/37 tests and redeployed. Finally the deploy script re-ran the same 37 tests before touching mainnet.

What it does *not* claim: this is an internal review plus a Studio review, not a professional audit. A seller can still shill from a second wallet; no auction contract can stop that, and the bid history is public. If a seller never delivers, the winner recovers the bond (equal to the reserve), not the full price. That is why v1 targets digital and creator lots.

## What changed after real people used it (v7 and v8)

Real trading exposed real friction, and each fix went through Arc Studio:
- **Any Arc asset (v7).** EURC, ERC-8004 agent identities, NFTs and ERC-1155 positions are escrowed at listing, so delivery is trustless.
- **Off-chain payments held in escrow (v7)** instead of being paid at the hammer.
- **Outbid with just the extra (v8).** Bids reuse your returned balance.
- **Payouts straight to wallets** with a safe fallback, **refunds with reasons**, **on-chain evidence**, a private **dispute desk** with **email alerts**, seller contact and photo upload.

My audits caught:
- a critical escrow lockup in Studio's v7;
- invented function selectors in Studio's v8 alert code;
- a token-amount display bug found by a real user.

All were fixed and logged.

## How I built it in Arc Studio

All contracts, tests, the frontend and the relayer were built in one Arc Studio project over 35 turns between 17 and 28 October. [STUDIO.md](STUDIO.md) records every turn: the prompt, what Studio produced, what it got wrong, and what I corrected.

The pattern that worked was **Studio builds, I verify against the chain, Studio fixes**:

- **Turn 1–2:** the core contracts and an 18-test matrix. I replaced a push refund with a pull/claimable pattern, because Arc reverts transfers to blocklisted addresses and one bad address would have frozen an auction. Studio added the 14-day dispute fallback on its own.
- **Turn 3:** the live room. Studio guessed the deploy block for event loading and was off by 67 million blocks. I checked the receipt and corrected it.
- **Turn 4–5:** gasless bidding and Memo receipts. Studio's review caught the lot-binding flaw described above.
- **Turns 6–20:** the end-to-end stack, redesign, landing page, durations, accessibility, and RPC rate-limit handling. Several bugs only appeared when I ran the full stack against the real chain: a missing Multicall3 definition, a hand-written event ABI that did not match the contract, and a PC clock 11 seconds behind the chain.
- **Turn 21:** pre-mainnet security review, tests and redeploy.
- **Turn 22:** repointing the app at mainnet.

Studio deploys to testnet only, so the mainnet deploy used arc-forge from my own wallet, as Circle's docs describe. The script re-ran Studio's tests first and asked for the key interactively, so it never touched a file.

I was honest in STUDIO.md about where I worked outside Studio. 26 fixes were made by hand when the usage limit was reached or a change was tiny. Each is listed, and each was uploaded back to the Studio project before the next turn, so the Studio project and the shipped code match.

## Real USDC on mainnet

Deploying Gavel cost 0.082 USDC in gas. There are no automated or house auctions: every lot on mainnet is listed by a real seller and bid on by real people. [PROOF.md](PROOF.md) lists every contract and transaction hash, and the live /proof page reads every market event straight from chain, with no wallet needed, totalling USDC moved, bids placed, distinct bidders and lots settled.

Mainnet trading on v8 so far (audited on-chain from every event): **14 lots, 69 bids (53 gasless) from 6 wallets, 2,490 USDC of bid volume, 15 lots sold**. Every USDC that went in came back out to the right wallets; the contract, the vault and every claimable balance ended at 0. Some participants received USDC from me for testing, and that is disclosed in PROOF.md.

## Why it fits what Arc wants

- **Escrow and conditional payouts** (Arc's first suggested area): bids are escrowed, payment releases on the hammer, and the seller's bond releases only on confirmed delivery or timeout.
- **Gas-sponsored checkout**: one-signature gasless bidding.
- **Instant DvP**: the lot and the payment move in one transaction.
- **Composable**: AuctionHouse is callable by any contract, so another Arc app can list or bid programmatically.
- **Depends on Arc's features**: the soft close only means something with sub-second finality.

## Where it goes next

1. **AI-agent bidders.** An agent wallet with an on-chain spending cap bidding through the gasless relayer: a market where people and agents compete in the same room.
2. **Delivery attestation** for physical goods, so the bond can be released or slashed without an arbiter.
3. **Cross-chain bidders** via CCTP, so a bidder holding USDC on another chain can join an Arc auction.
4. **Seller reputation that matters:** ERC-8004 feedback already records clean sales; the next step is reputation-sized bonds with sybil resistance.

## Stack

Solidity 0.8.28 with Foundry (83 tests), OpenZeppelin, React + Vite + Tailwind, wagmi/viem, RainbowKit for any browser-extension EVM wallet, Motion, Bun for the relayer, and EIP-3009 USDC, Arc Memo and ERC-8004 on Arc mainnet.
