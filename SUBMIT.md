# Submission pack: Arc Microgrants, "Built with Arc Studio"

Deadline: 1 Nov 2026 (DoraHacks: 2 Nov 04:59 UTC). Earlier submissions get earlier answers.

## What the form needs, and where it is
| Field | Value |
|---|---|
| Arc Studio project URL | https://studio.arc.io/app/d49aa346-328f-49aa-b5c9-62e187eca7ed |
| Live app | https://gavel-alpha.vercel.app |
| Contract addresses | AuctionHouse 0x24D890c1285D481cB6B8761318A8250C922956dd (+ the 3 others in README) |
| Example tx + explorer link | _first live mainnet bid or settle_ https://explorer.arc.io/tx/... |
| Public repo | https://github.com/timix648/gavel |
| Video walkthrough | _after recording_. Must show the build in Arc Studio AND a mainnet transaction |
| Short description | Use "One line" + "What Gavel does" from WRITEUP.md |
| Builder profile | Your GitHub / X / Farcaster |

## Rules check (from the DoraHacks page)
- Built in Arc Studio: yes, 22 turns. Hand fixes are disclosed in STUDIO.md and synced back to Studio.
- Deployed to Arc mainnet and moved USDC through contract + app: deployed. **Needs at least one real bid before you submit.**
- Not testnet-only, not a mockup: yes.
- Not already funded by Circle/Arc: yes.
- Pseudonymous OK; verification only after selection.
- One submission per project.

## Video script (about 3 min)
1. **0:00–0:20 Hook.** The live room with the clock under 10 s; a bid lands and the clock jumps back to 10. Say: "A real auction, settling real dollars, on a chain where a bid is final in under a second."
2. **0:20–1:10 Arc Studio.** Open the Studio project. Scroll the turn history. Show turn 1 (contracts), turn 4 (gasless; Studio caught the lot-binding bug), and turn 21 (security review, 37/37 tests). Open STUDIO.md briefly.
3. **1:10–2:10 Mainnet demo.**
   - Create a lot (title, $0.10 reserve, 10 min).
   - From a second wallet, bid normally.
   - From a third, bid gasless: one signature, no gas.
   - Show the outbid banner and Withdraw.
   - Bid in the last 10 s to show the extension.
   - Settle: the NFT and payment move in one transaction. Open it on explorer.arc.io.
4. **2:10–2:40 Safety.** Show the seller's view: "This is your lot", so a seller can't bid. Mention the on-chain bug found in lot #115 and the fix.
5. **2:40–3:00 Proof + close.** Open /proof with live totals. "Escrow, conditional payout and instant DvP, built in Arc Studio, live on mainnet."

## Live event checklist
- Invite 25–30 people for 10–15 attendees (Arc Discord, DoraHacks round-2 builders, friends).
- Each needs a little USDC on Arc mainnet ($1 is plenty; gasless bids need no gas). Note any you fund, for the PROOF.md disclosure.
- Run 3–5 lots of 10 minutes, digital items (a code review, a logo, a shout-out). Record the screen.
- Afterwards: settle every lot, confirm deliveries, fill the mainnet summary in WRITEUP.md and PROOF.md.
