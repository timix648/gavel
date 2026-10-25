/**
 * Gavel chain configuration — the ONE file to edit when repointing to mainnet.
 *
 * Mainnet: chainId=5042, rpc=https://rpc.mainnet.arc.io, explorer=https://explorer.arc.io
 * Testnet: chainId=5042002, rpc=https://rpc.testnet.arc.io, explorer=https://explorer.testnet.arc.io
 */

export const CHAIN_ID = 5042

/** Human-readable network label — used in UI copy, never hard-coded in components. */
export const NETWORK_LABEL = 'Arc'

export const CHAIN = {
  id: CHAIN_ID,
  name: 'Arc',
  network: 'arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.arc.io'] },
    public:  { http: ['https://rpc.mainnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
  // Required by viem's client.multicall (lobby, landing featured lot, /me titles).
  // Standard Multicall3 address; deployed on Arc (verified with eth_getCode).
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
} as const

export const EXPLORER = 'https://explorer.arc.io'

/** USDC ERC-20 at 6 decimals — also the native gas token on Arc */
export const USDC_ADDRESS   = '0x3600000000000000000000000000000000000000' as const
export const USDC_DECIMALS  = 6

/** AuctionHouse v6 mainnet deployment (shill-bid guard + zero-bid guard + transferFrom in LotVault) */
export const AUCTION_HOUSE_ADDRESS = '0x24D890c1285D481cB6B8761318A8250C922956dd' as const

/**
 * Block the AuctionHouse was deployed at — used as getLogs fromBlock.
 * AuctionHouse v6 mainnet tx: 0xa17499eaed3ccc04ecb6a6939d9d8b8ec1f90a1e8de1ccd3fb44d0662861d7b2
 */
export const DEPLOY_BLOCK = 27790604n

/**
 * ReputationWriter v3 — wired to AuctionHouse v6.
 * The owner of AuctionHouse must call setReputationWriter(REPUTATION_WRITER_ADDRESS)
 * to enable bond discounts. Sellers must call linkSeller(agentId) after registering
 * their identity on the IdentityRegistry.
 */
export const REPUTATION_WRITER_ADDRESS = '0x8865A988DD9ff40a55590C7ce136512bC6A2E1CD' as const

/**
 * ERC-8004 registries on Arc Mainnet.
 */
export const IDENTITY_REGISTRY_ADDRESS   = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const
export const REPUTATION_REGISTRY_ADDRESS = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const

/**
 * Memo contract — same address on testnet and mainnet.
 * EOA-only: AuctionHouse cannot call it; settle-through-Memo is done in the frontend.
 */
export const MEMO_ADDRESS = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505' as const

/**
 * Ordered list of RPC endpoints. The log store cycles to the next URL after
 * repeated rate-limit responses. Add a private provider URL (e.g. Alchemy / Infura)
 * as the first entry to avoid being throttled by the public endpoint.
 *
 * For now only the public RPC is listed; leave a comment here when adding a provider:
 *   'https://arc-mainnet.g.alchemy.com/v2/<KEY>',  // add before the public URL
 */
export const RPC_URLS: readonly string[] = [
  // VITE_RPC_URL (a private provider URL set in the hosting env) is tried first.
  ...(import.meta.env.VITE_RPC_URL ? [String(import.meta.env.VITE_RPC_URL)] : []),
  'https://rpc.mainnet.arc.io',   // public — leave as fallback
]

/** The RPC every client in the app uses by default: the provider URL if set, else the public RPC. */
export const RPC_URL: string = RPC_URLS[0]

/**
 * Relayer URL — the Bun HTTP service in relayer/ that submits bidWithAuthorization txs.
 * On localhost during development this is the port the relayer binds to.
 * On mainnet replace with your hosted relayer URL.
 */
export const RELAYER_URL = 'http://localhost:3001'

/**
 * getLogs chunk size. One address-only request per chunk.
 * The Arc Testnet public RPC handles 100,000-block ranges reliably in a single call
 * (~5 s) but rate-limits on rapid sequential requests (-32005). On a rate-limit we
 * back off and retry the SAME range — never halve. We only halve on a genuine range
 * error ("query returned more than N results", "block range too large", etc.).
 * Replace with a smaller value if your RPC demands it.
 */
export const LOGS_CHUNK_SIZE = 10_000n

/** Minimum inter-call delay (ms) to stay within the public RPC's request rate. */
export const LOGS_MIN_INTERVAL_MS = 400


/** GitHub repository URL — shown in the lobby footer. Replace with your actual repo. */
export const GITHUB_URL = 'https://github.com/your-org/gavel'

/**
 * WalletConnect project ID — required for ConnectKit's full wallet list.
 * Override with VITE_WALLETCONNECT_PROJECT_ID env var.
 */
export const WALLETCONNECT_PROJECT_ID: string =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? '35feb36938c720a01f77006e662bcf8a'

export const txUrl   = (hash: string) => `${EXPLORER}/tx/${hash}`
export const addrUrl = (addr: string) => `${EXPLORER}/address/${addr}`

/** wallet_addEthereumChain params — derived entirely from constants above */
export const ADD_CHAIN_PARAMS = {
  chainId:            `0x${CHAIN_ID.toString(16)}`,
  chainName:          CHAIN.name,
  nativeCurrency:     CHAIN.nativeCurrency,
  rpcUrls:            CHAIN.rpcUrls.default.http,
  blockExplorerUrls:  [EXPLORER],
}
