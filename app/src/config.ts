/**
 * wagmi + RainbowKit configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { createConfig } from 'wagmi'
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
import { CHAIN, CHAIN_ID, WALLETCONNECT_PROJECT_ID } from './chain'
import { arcTransport } from './rpc'
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
    [CHAIN_ID]: arcTransport,
  },
  pollingInterval: 4000,
})
