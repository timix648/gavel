# Gavel House Keeper

A lightweight Bun service that keeps a live "house auction" running 24/7 on AuctionHouse v5.

## What it does

Every cycle (default 20 s):

1. Checks the house wallet's USDC balance. Warns in the log if below 2 USDC.
2. Ensures the AuctionHouse has a USDC allowance for the bond (approves once with a large allowance).
3. Scans all lots owned by the house wallet:
   - **Live lot** (deadline in the future) — no action, marks it as the current live lot.
   - **Ended lot** (deadline passed, not settled) — calls `settle()`.
   - **Settled lot, bond not released, 7 days elapsed** — calls `releaseBondAfterTimeout()`.
4. If no live lot is found, lists a new lot with the next title from the rotating list, reserve 0.10 USDC, minIncrement 0.05 USDC, 120-second duration.

`confirmDelivery` is **not** called by the keeper — that is the winner's responsibility.

## Environment variables

| Variable           | Required | Default                                         | Description                              |
|--------------------|----------|-------------------------------------------------|------------------------------------------|
| `HOUSE_PRIVATE_KEY`| yes      | —                                               | 0x-prefixed EOA private key. Never logged. |
| `AUCTION_HOUSE`    | no       | `0x6280bf11fd8fcdf63a2493fdf893b326fb06478f`    | AuctionHouse contract address.           |
| `RPC_URL`          | no       | `https://rpc.mainnet.arc.io`                    | RPC endpoint.                            |
| `KEEPER_PORT`      | no       | `3002`                                          | Health server port.                      |
| `CYCLE_MS`         | no       | `20000`                                         | Poll interval in milliseconds.           |

## How to run

```bash
# From the project root
HOUSE_PRIVATE_KEY=0x... bun keeper/index.ts
```

## Health endpoint

```
GET http://localhost:3002/health
→ { "lastAction": "listed lot #3 \"Logo sketch\" tx:0x…", "liveLotId": 3, "balance": "0.90" }
```

## How to host

Any environment that can run a long-lived Bun process works:

- **Free VM** (e.g. Oracle Cloud free tier, Fly.io hobby plan, Railway free tier): clone the repo, set `HOUSE_PRIVATE_KEY` as an environment secret, run `bun keeper/index.ts` as a systemd service or `pm2` process.
- **Docker**: `FROM oven/bun:latest`, `COPY . .`, `CMD ["bun", "keeper/index.ts"]`.
- **Deno Deploy / Bun Cloud** (when available): deploy the `keeper/` directory as a background worker.

## Cost estimate (testnet; scale similarly on mainnet)

| Item | Estimate |
|------|----------|
| Gas per `list()` | ~150 000 gas × 20 gwei = 0.003 USDC equivalent |
| Gas per `settle()` | ~80 000 gas × 20 gwei = 0.0016 USDC equivalent |
| Lots per day at 120 s duration | 720 |
| Bond per lot | 0.10 USDC (returned after delivery or timeout) |
| Total gas per day | ~720 × (0.003 + 0.0016) ≈ 3.3 USDC equivalent |
| Bond locked at any time | 0.10 USDC (one active lot) |

Keep at least 5 USDC in the house wallet to cover gas and one cycle's bond.
