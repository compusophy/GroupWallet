import { NextResponse } from 'next/server'
import { base } from 'wagmi/chains'
import { createPublicClient, formatUnits, http, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { getTreasuryConfig, getTreasuryPrivateKey, type TreasuryAssetConfig } from '@/lib/treasury'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Base mainnet RPC endpoint - use BASE_RPC_URL if available, otherwise use public Base RPC
const baseRpcUrl = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const

type PriceMap = Record<string, number>

type BalanceSnapshot = {
  blockNumber: string | null
  blockHash: string | null
  balances: Record<string, {
    balanceWei: string
    balanceFormatted: string
  }>
}

let lastSnapshot: BalanceSnapshot | null = null

async function fetchPrices(priceIds: string[]): Promise<PriceMap> {
  if (priceIds.length === 0) {
    return {}
  }

  const uniqueIds = Array.from(new Set(priceIds))
  const url = `https://coins.llama.fi/prices/current/${uniqueIds.join(',')}`

  try {
    const response = await fetch(url, { next: { revalidate: 60 } })
    if (!response.ok) {
      throw new Error(`Failed to load prices (${response.status})`)
    }

    const json = (await response.json()) as { coins?: Record<string, { price?: number }> }
    const result: PriceMap = {}

    if (!json.coins) {
      return result
    }

    for (const [id, payload] of Object.entries(json.coins)) {
      if (payload?.price && Number.isFinite(payload.price)) {
        result[id] = payload.price
      }
    }

    return result
  } catch (error) {
    console.error('Failed to fetch asset prices:', error)
    return {}
  }
}

export async function GET() {
  try {
    const config = getTreasuryConfig()
    const privateKey = getTreasuryPrivateKey()
    if (!privateKey) {
      return NextResponse.json(
        { ok: false, error: 'TREASURY_PRIVATE_KEY is not configured on the server.' },
        { status: 500 }
      )
    }
    const account = privateKey ? privateKeyToAccount(privateKey) : null
    const walletAddress = account?.address ?? config.address

    const client = createPublicClient({
      chain: base,
      transport: http(baseRpcUrl),
    })

    const checksummedWalletAddress = getAddress(walletAddress)

    const [latestBlock, finalizedBlock] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client
        .getBlock({ blockTag: 'finalized' })
        .catch((error) => {
          console.warn('Failed to load finalized block. Falling back to latest.', error)
          return null
        }),
    ])

    const blockNumber = latestBlock.number
    const blockHash = latestBlock.hash
    const blockTimestamp = latestBlock.timestamp

    const finalizedBlockNumber = finalizedBlock?.number ?? null

    console.log('Fetching treasury balances', {
      walletAddress: checksummedWalletAddress,
      latestBlockNumber: typeof blockNumber === 'bigint' ? blockNumber.toString() : null,
      latestBlockHash: blockHash,
      latestBlockTimestamp: typeof blockTimestamp === 'bigint' ? Number(blockTimestamp) : null,
      finalizedBlockNumber: typeof finalizedBlockNumber === 'bigint' ? finalizedBlockNumber.toString() : null,
      assets: config.assets.map((asset) => ({ id: asset.id, symbol: asset.symbol, type: asset.type, address: asset.address ?? null })),
      lastSnapshot,
    })

    const rawBalances = await Promise.all(
      config.assets.map(async (asset) => {
        try {
          if (asset.type === 'native') {
            const balance = await client.getBalance({ address: checksummedWalletAddress })
            console.log('Loaded native balance', {
              symbol: asset.symbol,
              balance: balance.toString(),
              formatted: formatUnits(balance, asset.decimals),
            })
            return { asset, balance }
          }

          if (!asset.address) {
            return { asset, balance: BigInt(0) }
          }

          const checksummedTokenAddress = getAddress(asset.address)

          // Check if address is a contract before calling balanceOf
          try {
            const code = await client.getBytecode({ address: checksummedTokenAddress })
            if (!code || code === '0x') {
              console.warn(`Token ${asset.symbol} at ${checksummedTokenAddress} is not a contract`)
              return { asset, balance: BigInt(0) }
            }
          } catch (err) {
            console.warn(`Failed to check bytecode for ${asset.symbol} at ${checksummedTokenAddress}:`, err)
            // If we can't check, try the balanceOf call anyway
          }

          const balance = await client.readContract({
            address: checksummedTokenAddress,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [checksummedWalletAddress],
          })

          console.log('Loaded token balance', {
            symbol: asset.symbol,
            balance: balance.toString(),
            formatted: formatUnits(balance, asset.decimals),
            blockNumber: typeof blockNumber === 'bigint' ? blockNumber.toString() : null,
          })
          return { asset, balance: balance ?? BigInt(0) }
        } catch (error: any) {
          // Log all errors for debugging, but still return BigInt(0) to not break the API
          const isZeroDataError = error?.shortMessage?.includes('returned no data') || 
                                  error?.cause?.shortMessage?.includes('returned no data')
          
          console.error(`Failed to load balance for ${asset.symbol} (${asset.address}):`, {
            error: error?.shortMessage || error?.message || error,
            isZeroDataError,
            walletAddress: checksummedWalletAddress,
            tokenAddress: asset.address,
          })
          
          return { asset, balance: BigInt(0) }
        }
      })
    )

    const priceMap = await fetchPrices(config.assets.map((asset) => asset.priceId))

    const breakdown = rawBalances.map(({ asset, balance }) => {
      const normalized = Number.parseFloat(formatUnits(balance, asset.decimals))
      const price = priceMap[asset.priceId] ?? 0
      const usdValue = normalized * price

      return {
        id: asset.id,
        symbol: asset.symbol,
        name: asset.displayName ?? asset.symbol,
        type: asset.type,
        address: asset.address ?? null,
        decimals: asset.decimals,
        priceId: asset.priceId,
        priceUsd: price,
        balance: normalized,
        balanceFormatted: formatUnits(balance, asset.decimals),
        balanceWei: balance.toString(),
        usdValue,
        color: asset.color ?? null,
      }
    })

    // Deduplicate by address (in case of duplicate assets)
    const seenAddresses = new Set<string>()
    const uniqueBreakdown = breakdown.filter((item) => {
      if (item.type === 'native') return true
      if (!item.address) return true
      const key = item.address.toLowerCase()
      if (seenAddresses.has(key)) return false
      seenAddresses.add(key)
      return true
    })

    const totalUsd = uniqueBreakdown.reduce((acc, item) => acc + (Number.isFinite(item.usdValue) ? item.usdValue : 0), 0)

    const breakdownWithShare = uniqueBreakdown
      .map((item) => ({
        ...item,
        share: totalUsd > 0 && Number.isFinite(item.usdValue) ? item.usdValue / totalUsd : 0,
      }))
      .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))

    const snapshot: BalanceSnapshot = {
      blockNumber: typeof blockNumber === 'bigint' ? blockNumber.toString() : null,
      blockHash,
      balances: breakdownWithShare.reduce<BalanceSnapshot['balances']>((acc, item) => {
        acc[item.symbol] = {
          balanceWei: item.balanceWei,
          balanceFormatted: item.balanceFormatted,
        }
        return acc
      }, {}),
    }

    const diff = lastSnapshot
      ? Object.entries(snapshot.balances).map(([symbol, current]) => {
          const previous = lastSnapshot?.balances[symbol]
          if (!previous) {
            return { symbol, previous: null, current }
          }

          const delta = BigInt(current.balanceWei) - BigInt(previous.balanceWei)
          return {
            symbol,
            previous,
            current,
            delta: delta.toString(),
          }
        })
      : null

    console.log('Computed treasury snapshot', {
      walletAddress: checksummedWalletAddress,
      blockNumber: snapshot.blockNumber,
      totalUsd,
      assets: breakdownWithShare.map((item) => ({
        symbol: item.symbol,
        balance: item.balance,
        balanceWei: item.balanceWei,
        usdValue: item.usdValue,
      })),
      diff,
    })

    lastSnapshot = snapshot

    return NextResponse.json(
      {
        ok: true,
        walletAddress: checksummedWalletAddress,
        chainId: base.id,
        totalValueUsd: totalUsd,
        assets: breakdownWithShare,
        blockNumber: typeof blockNumber === 'bigint' ? blockNumber.toString() : null,
        blockHash,
        updatedAt: new Date().toISOString(),
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, private',
          'Pragma': 'no-cache',
          'Expires': '0',
          'X-Block-Number': typeof blockNumber === 'bigint' ? blockNumber.toString() : '',
          'X-Block-Hash': blockHash ?? '',
        },
      }
    )
  } catch (error) {
    console.error('Failed to load treasury overview:', error)
    return NextResponse.json({ ok: false, error: 'Unable to load treasury overview' }, { status: 500 })
  }
}


