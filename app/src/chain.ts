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

/** AuctionHouse v8 mainnet deployment (four lot kinds: OFFCHAIN, ERC721, ERC1155, ERC20) */
export const AUCTION_HOUSE_ADDRESS = '0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6' as const

/** AuctionHouse v7 testnet deployment with the audit fixes (verification only; app stays on mainnet) */
export const AUCTION_HOUSE_TESTNET_ADDRESS = '0x71A4FA23a2B7Fd7b4a11032c44f1e30591b83A04' as const
/** AuctionHouse v8 testnet deployment (top-up bidding, evidence, contact/delivery) */
export const AUCTION_HOUSE_V8_TESTNET_ADDRESS = '0x2621EfB0581A02429A0B1276f3391Ee303354A34' as const

/**
 * Block the AuctionHouse was deployed at — used as getLogs fromBlock.
 * AuctionHouse v8 mainnet tx: 0xe57ba2140d97356597d43894f18f8119288febc62ed92e0558650dd7eb7327d2
 */
export const DEPLOY_BLOCK = 28077831n

/**
 * ReputationWriter v3 — wired to AuctionHouse v6.
 * The owner of AuctionHouse must call setReputationWriter(REPUTATION_WRITER_ADDRESS)
 * to enable bond discounts. Sellers must call linkSeller(agentId) after registering
 * their identity on the IdentityRegistry.
 */
export const REPUTATION_WRITER_ADDRESS = '0x98719b8AA176C0bB07a6863880F11be8f5bF1569' as const

/**
 * ERC-8004 registries on Arc Mainnet.
 */
export const IDENTITY_REGISTRY_ADDRESS   = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const
export const REPUTATION_REGISTRY_ADDRESS = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const

/**
 * Arc mainnet ERC-20 asset allowlist (each vetted on a fork: list, bid, settle, claim).
 * NEVER match tokens by symbol — always match by address. The symbol "USDC" is used by
 * at least one fake token (UpSideDownCat 0x8E98A…) that must never appear in the UI.
 */
export const EURC_ADDRESS    = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' as const  // 6 dec
export const CIRBTC_ADDRESS  = '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0' as const  // 8 dec, cirBTC
export const LINK_ADDRESS    = '0x76a443768A5e3B8d1AED0105FC250877841Deb40' as const  // 18 dec
export const XAUM_ADDRESS    = '0x178b01f61CBeA1D2a5581Fe1621Be607835EC349' as const  // 18 dec, Matrixdock Gold
export const VIRTUAL_ADDRESS = '0x8C4252c87081c88c6Ad57d6dD97E1cAFebF842B7' as const  // 18 dec
export const GBPA_ADDRESS    = '0xbBe6aAB0Ed76e90AeA0d1cd978EC231c8AdCDF8b' as const  // 6 dec
export const MXNB_ADDRESS    = '0xF197FFC28c23E0309B5559e7a166f2c6164C80aA' as const  // 6 dec
export const QCAD_ADDRESS    = '0xd70C2FA4232e054B373eFAEa98E4138511c2a309' as const  // 6 dec
export const TRYB_ADDRESS    = '0xFb0705023603dc86325b83D9ff6b0DA7921fEc17' as const  // 18 dec
export const WBRL_ADDRESS    = '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0' as const  // 18 dec
export const USYC_ADDRESS    = '0x8a5D989Bbb96929F689B0200f435f53dA42bF490' as const  // 18 dec, permissioned
/** USYC transfer restriction warning shown in the UI when this asset is selected. */
export const USYC_WARNING  = 'USYC is a permissioned token. Only KYC-eligible wallets can receive it. Confirm the buyer is eligible before listing.' as const

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


/** GitHub repository URL, shown in the landing and lobby footers. */
export const GITHUB_URL = 'https://github.com/timix648/gavel'

/**
 * WalletConnect project ID — required for ConnectKit's full wallet list.
 * Override with VITE_WALLETCONNECT_PROJECT_ID env var.
 */
export const WALLETCONNECT_PROJECT_ID: string =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID) ?? '35feb36938c720a01f77006e662bcf8a'

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
