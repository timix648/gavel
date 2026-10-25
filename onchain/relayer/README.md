# Gavel Relayer

A lightweight Bun HTTP service that submits `bidWithAuthorization` transactions on behalf of auction bidders, enabling gasless bidding via EIP-3009.

## How it works

1. The bidder signs two EIP-712 messages in their browser wallet:
   - **USDC ReceiveWithAuthorization** — authorizes the AuctionHouse to pull `amount` USDC from the bidder.
   - **BidAuthorization** — authorizes the relayer to submit a bid on a specific lot.
2. The frontend POSTs both signatures to `POST /bid`.
3. The relayer validates the bid (lot exists, not expired, amount meets reserve/increment, bidder has balance) and submits the `bidWithAuthorization` tx from its own EOA.
4. The relayer pays gas; the bidder never needs native tokens.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | Yes | 0x-prefixed hex private key for the relayer EOA |
| `RELAYER_PORT` | No | Port to listen on (default: `3001`) |
| `AUCTION_HOUSE_ADDRESS` | No | Override contract address (default: v3 on Arc Testnet) |
| `ARC_RPC_URL` | No | Override Arc RPC URL (default: `https://rpc.testnet.arc.io`) |

**Never commit `RELAYER_PRIVATE_KEY` to source control.** Set it in your shell or a `.env` file that is in `.gitignore`.

## Running locally

```bash
# Set your relayer wallet private key
export RELAYER_PRIVATE_KEY=0x...

# Start the relayer (from the project root)
bun run relayer/index.ts
```

The relayer binds to `http://localhost:3001` by default. The Vite dev server proxies `/relay/*` to it automatically, so the frontend can call `/relay/bid` without CORS issues.

## API

### `POST /bid`

Submit a gasless bid.

**Request body:**
```json
{
  "lotId": 0,
  "amount": "150000",
  "auth": {
    "from": "0xBIDDER",
    "to": "0xAUCTION_HOUSE",
    "value": "150000",
    "validAfter": "0",
    "validBefore": "1234567890",
    "nonce": "0xRANDOM_BYTES32"
  },
  "usdcSig": { "v": 27, "r": "0x...", "s": "0x..." },
  "bidSig":  { "v": 27, "r": "0x...", "s": "0x..." }
}
```

**Success (200):**
```json
{ "txHash": "0x..." }
```

**Error (4xx/5xx):**
```json
{ "error": "human-readable reason" }
```

### `GET /stats`

Returns relay statistics.

```json
{
  "relayedBids": 42,
  "totalGasUsdc": "0.000123"
}
```

## Rate limits and spend caps

- **Per-address rate limit:** 5 bids per minute per `from` address.
- **Daily spend cap:** 100 USDC relayed per `from` address per day (prevents float drain). Adjust `DAILY_SPEND_CAP` in `relayer/index.ts` to suit your budget.

## Gas

Arc Testnet has a 20 gwei minimum gas floor. The relayer sends:
- `maxFeePerGas = 20 gwei`
- `maxPriorityFeePerGas = 0`

If no receipt arrives within 15 seconds, it retries once at 1.5× the base fee (30 gwei).

## Hosting options

| Option | Notes |
|---|---|
| **Fly.io** | Free tier works for low traffic. Set `RELAYER_PRIVATE_KEY` as a secret: `fly secrets set RELAYER_PRIVATE_KEY=0x...` |
| **Railway** | Similar — use environment variable secrets. |
| **Render** | Free web service; set env vars in the dashboard. |
| **Docker** | `docker run -e RELAYER_PRIVATE_KEY=0x... -p 3001:3001 your-image` |
| **VPS** | Run with `bun run relayer/index.ts` behind nginx/caddy as reverse proxy. |

For production, run behind a reverse proxy with TLS. Never expose `RELAYER_PRIVATE_KEY` in logs, error messages, or API responses — the relayer code already enforces this.
