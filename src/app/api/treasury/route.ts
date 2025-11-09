import { NextResponse } from 'next/server'
import { base } from 'wagmi/chains'
import { formatUnits } from 'viem'

import { getTreasuryConfig, getTreasuryPrivateKey, type TreasuryAssetConfig } from '@/lib/treasury'
import { getPricesForAssets } from '@/lib/pricing'
import { fetchTreasuryState } from '@/lib/treasury-state'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type BalanceSnapshot = {
  blockNumber: string | null
  blockHash: string | null
  balances: Record<string, {
    balanceWei: string
    balanceFormatted: string
  }>
}

let lastSnapshot: BalanceSnapshot | null = null

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

    const treasuryState = await fetchTreasuryState()
    const { blockNumber, blockHash, blockTimestamp, finalizedBlockNumber, balances: rawBalances, walletAddress } = treasuryState

    console.log('Fetching treasury balances', {
      walletAddress,
      latestBlockNumber: typeof blockNumber === 'bigint' ? blockNumber.toString() : null,
      latestBlockHash: blockHash,
      latestBlockTimestamp: typeof blockTimestamp === 'bigint' ? Number(blockTimestamp) : null,
      finalizedBlockNumber: typeof finalizedBlockNumber === 'bigint' ? finalizedBlockNumber.toString() : null,
      assets: config.assets.map((asset) => ({ id: asset.id, symbol: asset.symbol, type: asset.type, address: asset.address ?? null })),
      lastSnapshot,
    })

    const priceSnapshots = await getPricesForAssets(config.assets.map((asset) => asset.id))

    const breakdown = rawBalances.map(({ asset, balance }) => {
      const normalized = Number.parseFloat(formatUnits(balance, asset.decimals))
      const price = priceSnapshots.get(asset.id)?.priceUsd ?? 0
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
      walletAddress,
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
        walletAddress,
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


