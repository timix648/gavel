# Gavel - proof of what runs on chain

Every hash below was checked independently with `arc-cast receipt <hash> status`
(Arc Foundry), not taken from Studio's output. The live /proof page reads the same events
straight from chain.

## Arc mainnet (chain 5042)

_To be filled after the mainnet deploy._

| Contract | Address | Deploy tx |
|---|---|---|
| AuctionHouse | | |
| ReputationWriter | | |
| GavelLot | | |
| LotVault | | |

Transaction count, distinct wallets and USDC moved: see the live /proof page and the
table that will go here.

Funding disclosure: _list any participants funded to remove the onboarding barrier, e.g.
"N participants were sent 1 USDC on Arc; all bids were their own decisions."_

## Arc testnet (chain 5042002) - development history

### Contract versions
| Version | AuctionHouse | Deploy block | What changed |
|---|---|---|---|
| v1 | `0x48a6042850d4b82be7a9a4d6aefd9b62b276ca5f` | - | Core auction |
| v2 | `0x58a0d1f5426e5ed1e47db45e3eec1e73179dc2f3` | 67707191 | Per-lot increment/bond, held bond, disputes |
| v3 | `0xd852f946ce33d314ebecf6b3465376c8cc8768b1` | 68429852 | Gasless bidding (two signatures) |
| v4 | `0x64e7fea4f62dcd87739177f976c43841c678ad20` | 68433448 | ERC-8004 reputation, reputation-sized bonds |
| v5 | `0x6280bf11fd8fcdf63a2493fdf893b326fb06478f` | 68670003 | Gasless bidding with one signature (current) |

ReputationWriter v2 (wired to v5): `0x5898b97d94afab5c47fd29f468bc269f03e52dad`

### Full auction with soft close (v2, 22 Oct)
| Step | Tx | Block |
|---|---|---|
| list 0.10 reserve / 0.05 step | `0xf69f1dfedb1decbfa029e23d872d6b14aff902c838199d9a33f56119473577e3` | 68425249 |
| bid 0.10 | `0x485b1ef9d14248fe94e54a4dc352bc91929832c4ee7fa9dea4970f747dd585db` | 68425263 |
| bid 0.15 (outbid) | `0xafebbb4d45359ecf1ae1cb937c992f3999e4bc0242a675e74fb44a0369bbc279` | 68425277 |
| bid 0.20 in final 10 s (Extended) | `0x8b5daf73d69c5b1ca21835630a70506119d43804063c616d5f1989a464ec4bfa` | 68425474 |
| settle (Hammer) | `0x8b1b3c59feab0cf1a7ca771083f6918b60ae8efcfa0ec020175d8531f0297950` | 68425503 |
| claim outbid refund | `0xd52ade2e62a2a5819a5fd94a9c26284f38923e5459eb1cb9e388a082ae26bf0d` | 68425515 |

Event check over blocks 68425249-68425515 with `cast logs`: Listed 1, Bid 3, Outbid 2,
Extended 1, Hammer 1, BondHeld 1, Claimed 1.

### Gasless bidding
| What | Tx | tx.from |
|---|---|---|
| Two-signature relayed bid (v3) | `0xf770305630b623c950227e1d5087ea0a3f1eefc11be599aecdabaf64f6f8b0b8` | relayer `0xca79D9B8…84Af` |
| One-signature relayed bid (v5) | `0xde257a84dffe8f2c49bc5866b923bc04d254e24fb80279929b03d90268f9ea15` | relayer `0xca79D9B8…84Af` |

In the v5 bid the bidder (`0x6C64C5aA…85db`) never held gas and signed once; its balance
dropped by exactly the 0.10 bid.

### Reputation and delivery (v4)
| Step | Tx |
|---|---|
| settle | `0x921d8380d85f2300c343b75515534285e4ee88947547daa5ab1970ef29986589` |
| confirmDelivery | `0xf44bed1f99f4b2a7b02b382d16048a5e20925b38b4e9447a0a8f07ea286a3ca3` |
| recordSale (ERC-8004 feedback) | `0x5cbe405e74dfbcd31d67391fc1ef0d17ac218fdd3f96ae961decc3d32f2786dd` |

### House auction keeper (v5)
| Step | Tx |
|---|---|
| list lot #1 "30-min code review" | `0xe446172d205dcbdaec6afc87fb5c6ded024347a0e2894ff34b1e99c226505412` |
| settle lot #1 | `0xf5a33d9d430f424c3b7e00dd24d649037003dcba67d251476f2ca51af87b7b8f` |
| list lot #2 "Logo sketch" | `0x9abb38154e68aa62861d6ec49c5278278f9a9b5ddba718271d96370cdc3b8b44` |

### Full-stack end-to-end run (v5, 24 Oct)
Relayer and keeper running on my own machine (not Studio's sandbox), four fresh testnet
wallets, scripted auction on the keeper's lot #16. All receipts `status = true`.

| Step | From | Tx |
|---|---|---|
| A bids 0.10 (with gas) | bidder A `0xBafE…4688` | `0xfa384b9b6fe4d841397cd0ea767059287c5048175c6bd7afadf14f85d0366625` |
| B bids 0.15 (gasless, one signature) | relayer `0x7118…D808` | `0xd89042f7cef7361a632d10d8357d000ac69ba2cdd96a512b3cf44da6d8f4d9a5` |
| A bids 0.20 in last 10 s (deadline 1792835646 -> 1792835649) | bidder A | `0x61e27449f14ff21efb0caa8e17e098bce583d1c1ee1be5299081cbf793b8a8d0` |
| settle | bidder A | `0x64810a9dcfeac6bbf090d76606d3c0fb8162e6629e92aa4597b8819570f4b652` |
| B claims 0.15 refund | bidder B `0x5DFE…6F97` | `0x4661baff2319cc32520710a324907a8e5dfea22c4c9a6a0031d994034bcbe701` |
| A confirms delivery (bond released) | bidder A | `0xa43149bcbda7dbd7ac5afa8b983c695f0c232b9c57628337195592a309e2eb90` |

Bidder B sent zero transactions. Relayer cost for 3 relayed bids: 0.008 USDC
(balance 20.000000 -> 19.992008).

## Tests
33 Foundry tests, re-run outside Arc Studio with Arc Foundry (`arc-forge test`, forge
1.7.1): **33 passed, 0 failed.** Covers soft-close extension and termination, settlement
atomicity, pull-payment safety against a blocklisted address, 6-decimal accounting with
no stranded dust, reentrancy, pause, bond lifecycle and disputes, gasless bids with real
EIP-3009 signatures (wrong lot / amount / contract / replay / expiry all revert), and
reputation recording.

## Not yet exercised live
- Settle through Arc's Memo contract (needs a plain browser wallet; to be done on mainnet).
- Seller registration with the ERC-8004 IdentityRegistry.

## AuctionHouse v6 (testnet, 24 Oct 2026): audit fixes live
AuctionHouse v6 `0xa1C6274453AA11122F5d69585e77D162A993c1D4` (block 68884570, deploy tx 0xa91cd0b74360dea22e801b851a778882ae5bf57ef1247f3fd4693f1503b1f016), ReputationWriter v3 `0x729dae8ee6B9E530db612E695a8CE7009D5AEe10`, GavelLot `0xEceEE124478972315798E2053F908eeBbd21D1be`. Owner: house wallet (testnet only). Fixes: see AUDIT.md.

End-to-end on v6, lot #1 (test wallets funded by us):
| Step | Tx |
|---|---|
| A bids 0.10 (gas) | 0x05d579414706caf805905777bbee76c94723f29a3a3b916c1687bea2612e591d |
| B bids 0.15 (gasless, sent by relayer) | 0xb8473c5a094637052af06eda17b2eb1f15d42351114bc3cff97aaaea63273da1 |
| A bids 0.20 in last 10 s (soft close +4 s) | 0xde203b7ac27dd01b7eb290bbfe0489a40ecc9f01d7ec9c3a2ca11d43e8882874 |
| settle | 0x36fb260fe05fd02722530146865add194b2275497e936f89a65a2ab5aa31e12c |
| B claims 0.15 refund | 0xcf772a693a50de16dc7e354cde756d129f78030e622c8367d614a9159bbe0117 |
| A confirms delivery | 0xb9d84115ca671b3d6844671bb6aec2e53cad1048790586ba5f91921bc21ee3d3 |

## AuctionHouse v6 deployed BY ARC STUDIO (turn 21, 25 Oct 2026), replaces the hand-deployed v6 above
AuctionHouse `0x4ca018cd8d40159183d32c35b2072e90ef3903a6` (block 69022491, tx 0x571b156ab4d6508870174f365cce715f4a9c39d3d3f47fbdfd7ffc62103625ef, owner = Studio deployer 0x5B12…Ef42), GavelLot `0x7059A13a0771337232B24EBBD2Eb9AC1fDE0B3B7`, LotVault `0x3cbde21d88B5067d8790279df81c6a6E00C4c32c`, ReputationWriter v3 `0x6418acb3f652aa5a6f89cc519e7ad3bf4820698c`. Checked on-chain: receipt status true, seller-bid revert string present in bytecode, reputationWriter unset.

Live check: a seller bid simulated on house lot #0 reverts with "AuctionHouse: seller cannot bid".

End-to-end on Studio v6, lot #1 (test wallets funded by us):
| Step | Tx |
|---|---|
| A bids 0.10 (gas) | 0xcecfe79e98dad6035d83da1ea02d369599105e943cf7a6b1c1e6e58909cf75eb |
| B bids 0.15 (gasless, sent by relayer) | 0xdab94dff0721783eae27987f8e148cce48444b4f1f6491c11014624671713363 |
| A bids 0.20 in last 10 s (soft close) | 0xefc37793beab23725ba5e086f0d17cb8be5ab02f2d722a629449f2100696b3f0 |
| settle | 0x5f93b7c75eb0af22abe82e33d1020aac3bf727c856841c10dcee5339bc79b97e |
| B claims 0.15 refund | 0xdc74682e7508bd5553afa9c418dcad1c535e926789c9a09977efa51e9f03d846 |
| A confirms delivery | 0xa7975e0b66c2afff85655d0171799990acb964f39cce10808d2a94e12258f9c3 |

# ARC MAINNET (chain 5042)

Deployed 25 Oct 2026 with arc-forge from the owner's wallet (Studio deploys to testnet only). It is the same source Studio tested in turn 21 (37/37), and the deploy script re-ran all 37 tests before deploying.

| Contract | Address |
|---|---|
| AuctionHouse | `0x24D890c1285D481cB6B8761318A8250C922956dd` (block 27790604, tx 0xa17499eaed3ccc04ecb6a6939d9d8b8ec1f90a1e8de1ccd3fb44d0662861d7b2) |
| GavelLot (NFT) | `0x5f1a8677d47d39D28C75936574B3529686Bb9121` |
| LotVault | `0xeD8a17B1e9aF7cA83d501248985A2d8FfC575A2F` |
| ReputationWriter | `0x8865A988DD9ff40a55590C7ce136512bC6A2E1CD` (tx 0xc64d48e7e148f8b1c3089012a6e6c0fb3b7c10aad22e87ad24ef96496a67c419) |
| Owner | `0xBa6A590E4215CDE9448cd01A0B86531476E4dA0F` |

Verified on mainnet:
- both receipts have status true
- `usdc()` = 0x3600…0000 (USDC, 6 decimals)
- the seller-bid guard is present in the bytecode
- ReputationWriter points to the mainnet ERC-8004 ReputationRegistry 0x8004BAa1…9b63

Deploy gas: 3,276,917 + 793,565, costing about 0.082 USDC in total.

No automated or house lots run on mainnet. Every lot is listed by a real seller.

## First mainnet auction: lot #0 (25 Oct 2026), verified on-chain
Seller `0xBa6A…dA0F` (the builder) and two bidders, `0x1d94…1038` and `0x5e50…9650`, both wallets of the builder or friends. Reserve 1.00, step 0.25. All 10 transactions have status = true. After the last claim, the AuctionHouse holds 0 USDC.

| Step | From | Tx |
|---|---|---|
| list "first auction" (bond 1.00) | seller | [0x870f7888…c978](https://explorer.arc.io/tx/0x870f7888dc370093b5a11244bf65069dcb0966535708cabe0ab9c6e84d61c978) |
| bid 1.00 | 0x1d94 | [0xf513a819…332b](https://explorer.arc.io/tx/0xf513a81904b9c5c963d0397bb22c583c2cde19051dcc5a2c7d60f0e80984332b) |
| bid 1.25 (0x1d94 outbid, 1.00 credited) | 0x5e50 | [0xd71d06a4…c3c4](https://explorer.arc.io/tx/0xd71d06a41dafd8d9b25156f59ba6daf9b37a883dd360264d038a34db8e6de3c4) |
| claim 1.00 | 0x1d94 | [0x883144e1…7f32](https://explorer.arc.io/tx/0x883144e13c8965bdd8aa9946ac3cc57db6c58a38fe70e6ee590bd2f0221f7f32) |
| bid 1.50 (0x5e50 outbid, 1.25 credited) | 0x1d94 | [0xc752cf91…76b6](https://explorer.arc.io/tx/0xc752cf912df355118512bec601f3a188f5e2581ea852f08dcb4c3506b40d76b6) |
| claim 1.25 | 0x5e50 | [0x756fcfb7…8b59](https://explorer.arc.io/tx/0x756fcfb7a81dce262b436c0be672cf88a14fa8b100d36f9e66d2a0c3fbc88b59) |
| settle via Memo: NFT #1 to 0x1d94, 1.50 to seller, in one tx | seller | [0xf20c04af…dd74](https://explorer.arc.io/tx/0xf20c04af874fee8f3e2d2733c2610bf1c192201e652244085f10f76017cedd74) |
| claim 1.50 (sale proceeds) | seller | [0x829cc973…a0b7](https://explorer.arc.io/tx/0x829cc973d01e515009e7ce0972b12f83d4164b58b0e2880dc3290aa5fd35a0b7) |
| confirm delivery (bond released) | 0x1d94 | [0x31067b41…13d1](https://explorer.arc.io/tx/0x31067b419ed63814503d8ebadcf00086cebe39c44a6aa9865b4c6d3a284713d1) |
| claim 1.00 (bond back) | seller | [0xe542ee9e…b6c6](https://explorer.arc.io/tx/0xe542ee9e7327264668feb4380d79bc6854c6f0318d8bf72e4d2205c2f3a4b6c6) |

USDC through the contract: 4.75 in (1.00 bond + 1.00 + 1.25 + 1.50 bids), 4.75 out. NFT #1 is owned by the winner `0x1d94…1038`.

# v7 on Arc mainnet (27 Oct 2026)

Deployed by the owner with deploy-mainnet-v7.sh (arc-forge, interactive key). The script re-ran the 59 tests before deploying. All four contracts are a Sourcify exact match.

| Contract | Address |
|---|---|
| AuctionHouse v7 | `0x6102D866Dcb9CFeE929Eb6b2A16468E9d0193A2E` (block 28065938, tx 0xad6537e1f54b167bdd9b7ed66c35157871a152e3523929518b6ee9eff4500c03) |
| GavelLot | `0x95CaC1B5Ab1eA40F016dc0C7d2Fb41A1BB8263AB` |
| LotVault | `0xB0Cd097BBFC8ba8a4A1250d9F891C7Db8BA906b9` |
| ReputationWriter | `0x236572D0981dB417638FbD7b4Ac8406AE4d286C6` (tx 0x9d195adf52a7a48d3ef182945dfd58c0d0f4c9bb41fa5df279bcfb45d8c4411c) |

Allowlist transactions:
- EURC `0xbEf5…21c1` as ERC-20: [0xe575e017…52ec](https://explorer.arc.io/tx/0xe575e0179f1764f2ec8f795a067382dbe1da55bfe25c9f1e87c74ac7655f52ec)
- ERC-8004 IdentityRegistry `0x8004A169…a432` as ERC-721: [0xcafe61bc…2e21](https://explorer.arc.io/tx/0xcafe61bca3316f80136a81b44d7a457d9a86945f665979d6e096d920d6252e21)

Verified on-chain:
- `usdc()` is 0x3600…0000;
- `maxReserve` is 1,000 USDC and `MAX_EXTENSIONS` is 500;
- the vault and ReputationWriter point to v7;
- calling `releaseBondAfterTimeout` reverts, because the function does not exist.

Deploy gas: 5,072,467 + 793,565.

v6 (`0x24D8…56dd`) holds lot #0 above and stays readable, but the app no longer lists on it.

## v7 real-chain scenarios on Arc testnet (fixed code, `0x71A4FA23a2B7Fd7b4a11032c44f1e30591b83A04`)

**ERC-721 lot: a real ERC-8004 agent identity (#897604)**
1. Owner allowlisted the registry; the seller registered the identity, approved it and listed it. The vault took custody.
2. The seller's own bid reverted: "seller cannot bid".
3. A bid 0.10, then B bid 0.25. A was credited 0.10.
4. Settle credited the seller exactly 0.25.
5. A stranger's claim reverted: "not winner".
6. The winner sent the identity to a different wallet.
7. A double claim reverted: "already claimed".
8. Withdrawals left the contract at 0.

**Off-chain lot, confirm path**
1. After settle the escrow was HELD and the seller was credited 0.
2. `releaseEscrow` before the window reverted: "delivery window open".
3. The winner confirmed, and the seller was credited 0.40 (0.30 payment + 0.10 bond).

**Off-chain lot, refund path**
1. The seller refunded: the buyer was credited 0.30 and the seller 0.10 (bond).

**Escrow left in place:** one off-chain lot (#1) is still HELD with 0.40, exactly matching the contract's remaining balance.

# v8 on Arc mainnet (27 Oct 2026)

| Contract | Address |
|---|---|
| AuctionHouse v8 | `0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6` (block 28077831, tx 0xe57ba2140d97356597d43894f18f8119288febc62ed92e0558650dd7eb7327d2) |
| GavelLot | `0x871aDBA28fC21240E7020894292707e17e061222` |
| LotVault | `0x226e779B81c6365a4b8f62c8FCAeB71799f54269` |
| ReputationWriter | `0x98719b8AA176C0bB07a6863880F11be8f5bF1569` |

Allowlist transactions:
- EURC: [0xe96a261c…73cd](https://explorer.arc.io/tx/0xe96a261c12ee9fd0ca63047a566eae7bf5b8019ecbd98e97240e41e893c573cd)
- ERC-8004 identities: [0x470d3a81…6f15](https://explorer.arc.io/tx/0x470d3a817c7ab47bf9e644185181eb5e4128ae323fc863a30d23a679e6a46f15)

All 4 contracts are a Sourcify exact match. The deploy script ran 83/83 tests first.

Earlier contracts stay readable: v6 `0x24D8…56dd` (lot #0, Oct 25) and v7 `0x6102…3A2E` (lot #0, $2.00, confirmed and closed). The app now lists on v8.
