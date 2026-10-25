/**
 * wagmi + RainbowKit configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import {
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  okxWallet,
  coinbaseWallet,
  braveWallet,
  trustWallet,
  phantomWallet,
  zerionWallet,
  rainbowWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets'
import { CHAIN, CHAIN_ID, RPC_URL, WALLETCONNECT_PROJECT_ID } from './chain'
import { registerChain } from './tracing'

registerChain(CHAIN_ID, CHAIN.rpcUrls.default.http[0])

const projectId = WALLETCONNECT_PROJECT_ID

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Installed / Recommended',
      wallets: [
        injectedWallet,
        metaMaskWallet,
        rabbyWallet,
        okxWallet,
        coinbaseWallet,
        braveWallet,
        trustWallet,
        phantomWallet,
        zerionWallet,
        rainbowWallet,
      ],
    },
    {
      groupName: 'Other',
      wallets: [walletConnectWallet],
    },
  ],
  { appName: 'Gavel', projectId },
)

export const config = createConfig({
  chains:     [CHAIN],
  connectors,
  // Batch concurrent reads into one JSON-RPC request and poll gently: the public
  // Arc RPC answers 429 when a page fires many small requests at once.
  transports: {
    [CHAIN_ID]: http(RPC_URL, { batch: { wait: 20 }, retryCount: 4, retryDelay: 1500 }),
  },
  pollingInterval: 4000,
})
