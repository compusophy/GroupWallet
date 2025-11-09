import { createPublicClient, getAddress, http } from 'viem'
import { base } from 'wagmi/chains'
import { privateKeyToAccount } from 'viem/accounts'

import { getTreasuryConfig, getTreasuryPrivateKey, type TreasuryAssetConfig } from './treasury'

export const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const

export type TreasuryAssetBalance = {
  asset: TreasuryAssetConfig
  balance: bigint
}

export type TreasuryState = {
  walletAddress: `0x${string}`
  blockNumber: bigint
  blockHash: string
  blockTimestamp: bigint
  balances: TreasuryAssetBalance[]
  finalizedBlockNumber?: bigint | null
}

const baseRpcUrl = process.env.BASE_RPC_URL!

export async function fetchTreasuryState(): Promise<TreasuryState> {
  const config = getTreasuryConfig()
  const privateKey = getTreasuryPrivateKey()

  const account = privateKey ? privateKeyToAccount(privateKey) : null
  const walletAddress = account?.address ?? config.address
  const checksumWallet = getAddress(walletAddress)

  const client = createPublicClient({
    chain: base,
    transport: http(baseRpcUrl),
  })

  const [latestBlock, finalizedBlock] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    client
      .getBlock({ blockTag: 'finalized' })
      .catch((error) => {
        console.warn('[treasury] Failed to load finalized block, falling back to latest', error)
        return null
      }),
  ])

  const balances = await Promise.all(
    config.assets.map(async (asset) => {
      try {
        if (asset.type === 'native') {
          const balance = await client.getBalance({ address: checksumWallet })
          return { asset, balance }
        }

        if (!asset.address) {
          return { asset, balance: BigInt(0) }
        }

        const checksumToken = getAddress(asset.address)

        try {
          const code = await client.getBytecode({ address: checksumToken })
          if (!code || code === '0x') {
            console.warn('[treasury] Token address is not a contract', {
              symbol: asset.symbol,
              address: checksumToken,
            })
            return { asset, balance: BigInt(0) }
          }
        } catch (error) {
          console.warn('[treasury] Unable to check token bytecode', {
            symbol: asset.symbol,
            address: checksumToken,
            error,
          })
        }

        const balance = await client.readContract({
          address: checksumToken,
          abi: ERC20_BALANCE_OF_ABI,
          functionName: 'balanceOf',
          args: [checksumWallet],
        })

        return { asset, balance: (balance as bigint) ?? BigInt(0) }
      } catch (error) {
        console.error('[treasury] Failed to load balance', {
          symbol: asset.symbol,
          address: asset.address ?? null,
          error,
        })
        return { asset, balance: BigInt(0) }
      }
    })
  )

  return {
    walletAddress: checksumWallet,
    blockNumber: latestBlock.number,
    blockHash: latestBlock.hash,
    blockTimestamp: latestBlock.timestamp,
    balances,
    finalizedBlockNumber: finalizedBlock?.number ?? null,
  }
}


