# Gavel — Deployed Contract Registry

## AuctionHouse v6 (current — Turn 21, pre-mainnet security fixes)

| Field | Value |
|---|---|
| Address | `0x4ca018cd8d40159183d32c35b2072e90ef3903a6` |
| Tx hash | `0x571b156ab4d6508870174f365cce715f4a9c39d3d3f47fbdfd7ffc62103625ef` |
| Deploy block | 69022491 |
| Chain | Arc Testnet (chainId 5042002) |
| GavelLot | `0x7059A13a0771337232B24EBBD2Eb9AC1fDE0B3B7` |
| LotVault | `0x3cbde21d88B5067d8790279df81c6a6E00C4c32c` |

### What's new in v6
- `_bidCore`: `require(bidder != lot.seller)` — shill-bid prevention for both `bid()` and `bidWithAuthorization()`
- `_bidCore`: `require(amount > 0)` — blocks free win on zero-reserve lots
- `LotVault.release`: `transferFrom` instead of `safeTransferFrom` — malicious winner contract cannot block `settle()`
- 37 Foundry tests passing (tests 34-37 are new for v6 changes)

## ReputationWriter v3 (current — Turn 21)

| Field | Value |
|---|---|
| Address | `0x6418acb3f652aa5a6f89cc519e7ad3bf4820698c` |
| Tx hash | `0xb7bd362003c8feea3a36b12c3e7338d3ad65d81efd22c3d4eb4c8a4dbced0395` |
| Chain | Arc Testnet (chainId 5042002) |
| AuctionHouse | `0x4ca018cd8d40159183d32c35b2072e90ef3903a6` (v6) |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Note: `setReputationWriter` on AuctionHouse v6 must still be called by the owner to enable bond discounts.

---

## AuctionHouse v5 (superseded — Turn 5, single-sig gasless bid)

| Field | Value |
|---|---|
| Address | `0x6280bf11fd8fcdf63a2493fdf893b326fb06478f` |
| Tx hash | `0x13e036540fd1c53a13cd96b8ce4f49cd9bfabde431561681684dbf9b9d1f1228` |
| Deploy block | 68670003 |
| Chain | Arc Testnet (chainId 5042002) |
| GavelLot | `0x674063589E88b92B69CfC5025aB63Dba016Ab629` |
| LotVault | `0xb60857dBB0308BcD2c350c2f95e836f55f0Fc1c9` |

### What's new in v5
- Single-sig gasless bid: `bidWithAuthorization(lotId, amount, from, validAfter, validBefore, salt, v, r, s)`
- Nonce = `keccak256(abi.encode(address(this), block.chainid, lotId, amount, salt))` — binds all bid params + contract + chain into the EIP-3009 nonce; no second signature needed
- Removed: `BID_AUTHORIZATION_TYPEHASH`, `ECDSA` import, `domainSeparator()`, `_cachedDomainSeparator`

## ReputationWriter v2 (current — Turn 5)

| Field | Value |
|---|---|
| Address | `0x5898b97d94afab5c47fd29f468bc269f03e52dad` |
| Tx hash | `0x2957fa51638c828c5335beabb6fcaefef0dd94db3740ac5135e6368cb7f9a7cb` |
| Chain | Arc Testnet (chainId 5042002) |
| AuctionHouse | `0x6280bf11fd8fcdf63a2493fdf893b326fb06478f` (v5) |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

### What's new in ReputationWriter v2 (Turn 5)
- `linkSeller(uint256 agentId)` — seller registers on IdentityRegistry themselves, then links; contract verifies `ownerOf(agentId) == msg.sender`
- `recordSale(uint256 lotId)` — permissionless; records +1/-1 feedback to ERC-8004 ReputationRegistry; wraps in try/catch
- Self-sale guard: `highestBidder == seller` → no cleanSales increment
- `cleanSalesView(address seller)` — AuctionHouse reads this to give 50% bond discount after 3 clean sales
- Note: `setReputationWriter` on AuctionHouse v5 must still be called by the owner (`0x5B12Ce46C7…`) to enable discounts

---

## AuctionHouse v4 (superseded — Turn 5 initial deploy)

| Field | Value |
|---|---|
| Address | `0x64e7fea4f62dcd87739177f976c43841c678ad20` |
| Tx hash | `0x0c3b0337f8a38f4d52c06e399d35fc6817c09ea09a503cde7a8891a15f056124` |
| Deploy block | 68433448 |
| GavelLot | `0x674063589E88b92B69CfC5025aB63Dba016Ab629` |
| LotVault | `0xb60857dBB0308BcD2c350c2f95e836f55f0Fc1c9` |

## AuctionHouse v3 (superseded — Turn 4)

| Field | Value |
|---|---|
| Address | `0xd852f946ce33d314ebecf6b3465376c8cc8768b1` |
| Tx hash | `0xdc95daeac4b3c24d23b8c124d28f371555c350db7f9f9ba8e8658f5615ffdc70` |
| Deploy block | 68429852 |
| GavelLot | `0xd7995C47e2fFf894B88876cda02c248aB9ca386D` |
| LotVault | `0x70eD196CB845aa9fA1d155A7663826214df9f8ff` |

## AuctionHouse v2 (superseded — Turn 2)

| Field | Value |
|---|---|
| Address | `0x58a0d1f5426e5ed1e47db45e3eec1e73179dc2f3` |
| Tx hash | `0x5ab6159d82890efe67f6e79e4729769b7f031bc90896ec7d190ff68591c53df0` |
| Deploy block | 67707191 |

## AuctionHouse v1 (superseded — Turn 1)

| Field | Value |
|---|---|
| Address | `0x48a6042850d4b82be7a9a4d6aefd9b62b276ca5f` |
| Tx hash | `0xe82246db63a5765bb8f45f59f2f388d2e282c37c89bc2e02c4237f298e9473b5` |

---

## Common addresses

| Name | Address |
|---|---|
| USDC (Arc Testnet ERC-20, 6 dec) | `0x3600000000000000000000000000000000000000` |
| Platform deployer wallet | `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` |
| Deployer wallet ID | `3c2464b2-8369-52e2-a782-800bbeca5396` |
| Memo contract (testnet + mainnet) | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |
| ERC-8004 IdentityRegistry (testnet) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 ReputationRegistry (testnet) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ERC-8004 IdentityRegistry (mainnet) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry (mainnet) | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Test Seller wallet | `0xbdcc7e7af3eee8f8f47260a7568123c285bdd8ff` (Circle ID: 94bf46ee-e5b0-5085-9db6-f69bff28db80) |
| Test Bidder1 wallet | `0x5dba2b9277991ca1d1cfb1b237091872b10c2521` (Circle ID: e9babdeb-bbe2-5d25-9b39-8005f7f0167f) |
| Test Bidder2 wallet | `0x3cd27115006abd6683f1f663d1f83020dd0088af` (Circle ID: c9512204-51b7-5a0a-ae9d-8efc945865ea) |
| Relayer EOA | `0xca79D9B87ec6a3AeC6e302E6Fc4f8208FdAC84Af` |
| Gasless bidder EOA | `0x670BFFCd9091B0Cf42d3F41C23a5BE921D8f80c3` |

## Turn 6 additions

| Item | Detail |
|---|---|
| Keeper service | `keeper/index.ts` — house auction keeper, health on port 3002 |
| Keeper wallet | `0x670BFFCd9091B0Cf42d3F41C23a5BE921D8f80c3` (HOUSE_PRIVATE_KEY = relayer EOA from Turn 4) |
| Lot #1 (30-min code review) | listed `0xe446172d…`, settled `0xf5a33d9d…` |
| Lot #2 (Logo sketch) | listed `0x9abb3815…` |

---

## Key source files

| File | Purpose |
|---|---|
| `contracts/AuctionHouse.sol` | Core auction contract (v5) |
| `contracts/ReputationWriter.sol` | ERC-8004 reputation writer |
| `contracts/GavelLot.sol` | ERC-721 lot token |
| `contracts/LotVault.sol` | NFT escrow vault |
| `contracts/test-helpers/MockUSDC.sol` | 6-dec mock USDC with EIP-3009 for tests |
| `contracts/test/AuctionHouse.t.sol` | 33 Foundry tests (all passing) |
| `src/chain.ts` | Chain config, contract addresses, deploy block |
| `src/abi.ts` | ABI imported from compiled artifact |
| `src/logStore.ts` | Shared log cache (100k-block chunks, backoff retry) |
| `src/useLogs.ts` | Per-lot log filter hook |
| `src/pages/AuctionRoom.tsx` | Lot detail + bid form with single-sig gasless toggle |
| `src/pages/Proof.tsx` | Event explorer with progress bar |
| `relayer/index.ts` | Bun HTTP relayer for single-sig gasless bids |
| `relayer/README.md` | Relayer docs |
| `scripts/flow-test.ts` | End-to-end testnet flow test |
| `scripts/gasless-v5-test.ts` | Single-sig gasless bid end-to-end test |

## Live test tx hashes (Turn 5)

### v4 flow test (superseded)
- settle: `0x921d8380d85f2300c343b75515534285e4ee88947547daa5ab1970ef29986589`
- confirmDelivery: `0xf44bed1f99f4b2a7b02b382d16048a5e20925b38b4e9447a0a8f07ea286a3ca3`
- recordSale: `0x5cbe405e74dfbcd31d67391fc1ef0d17ac218fdd3f96ae961decc3d32f2786dd`

### v5 single-sig gasless bid test
- list:       `0xdba54a1d644e26a22c3d17f43cd463d782c529fbbc4e3f91e943baf413dc86e2`
- gasless bid: `0x9a6a11362a54a443a4947e75d0be7552ca699ba421c8af3d887bd3220b7901e6`
- Bidder signed **once** (ReceiveWithAuthorization only). No BidAuthorization sig.
