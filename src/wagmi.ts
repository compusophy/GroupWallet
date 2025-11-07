import { injected } from '@wagmi/core'
import { cookieStorage, createConfig, createStorage, http } from 'wagmi'
import { mainnet, sepolia, base } from 'wagmi/chains'
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector'

// Base RPC URL - use public Base RPC endpoint
const baseRpcUrl = 'https://mainnet.base.org'

export function getConfig() {
  return createConfig({
    chains: [mainnet, sepolia, base],
    connectors: [farcasterMiniApp(), injected()],
    storage: createStorage({
      storage: cookieStorage,
    }),
    ssr: true,
    transports: {
      [mainnet.id]: http(),
      [sepolia.id]: http(),
      [base.id]: http(baseRpcUrl),
    },
  })
}

declare module 'wagmi' {
  interface Register {
    config: ReturnType<typeof getConfig>
  }
}
