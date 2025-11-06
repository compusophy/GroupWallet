'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

function getAssetColor(symbol: string): string {
  const upperSymbol = symbol.toUpperCase()
  if (upperSymbol === 'ETH') return '#2563eb'
  if (upperSymbol === 'USDC') return '#22c55e'
  if (upperSymbol === 'USDB' || upperSymbol === 'USDBC') return '#0ea5e9'
  const fallbackColors = ['#7c3aed', '#f97316', '#facc15', '#ef4444', '#8b5cf6']
  return fallbackColors[symbol.length % fallbackColors.length]
}

type RawTreasuryAsset = {
  id: string
  symbol: string
  name: string
  type: 'native' | 'erc20'
  address: string | null
  decimals: number
  priceUsd: number
  balance: number
  balanceFormatted: string
  balanceWei: string
  usdValue: number
  share: number
  color: string | null
}

type TreasuryResponse = {
  ok: true
  walletAddress: `0x${string}`
  chainId: number
  totalValueUsd: number
  assets: RawTreasuryAsset[]
  updatedAt: string
}

type TreasuryErrorResponse = {
  ok: false
  error?: string
}

type VaultAssetsProps = {
  onSummaryUpdate?: (summary: { totalUsd: number; walletAddress: `0x${string}` | null }) => void
}

type DisplayAsset = RawTreasuryAsset & {
  balanceDisplay: string
  share: number
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return '$0.00'
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function formatTokenAmount(value: number, maximumFractionDigits = 6) {
  if (!Number.isFinite(value)) return '0'
  if (value === 0) return '0'
  if (value >= 1) {
    return value.toLocaleString(undefined, { maximumFractionDigits })
  }
  return value.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '')
}

export function VaultAssets({ onSummaryUpdate }: VaultAssetsProps) {
  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(null)
  const [assets, setAssets] = useState<DisplayAsset[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalUsd, setTotalUsd] = useState<number>(0)

  useEffect(() => {
    onSummaryUpdate?.({ totalUsd, walletAddress })
  }, [totalUsd, walletAddress, onSummaryUpdate])

  const orderedAssets = useMemo(() => {
    const preferredOrder = ['ETH', 'USDC']
    return [...assets].sort((a, b) => {
      const indexA = preferredOrder.indexOf(a.symbol.toUpperCase())
      const indexB = preferredOrder.indexOf(b.symbol.toUpperCase())

      const scoreA = indexA === -1 ? preferredOrder.length : indexA
      const scoreB = indexB === -1 ? preferredOrder.length : indexB

      if (scoreA !== scoreB) return scoreA - scoreB

      return 0
    })
  }, [assets])

  const sanitizeAssets = useCallback((rawAssets: RawTreasuryAsset[], totalUsdValue: number): DisplayAsset[] => {
    return rawAssets.map((asset) => {
      const balanceNumeric = Number.isFinite(asset.balance)
        ? asset.balance
        : Number.parseFloat(asset.balanceFormatted ?? '0')

      const usdValueNumeric = Number.isFinite(asset.usdValue) ? asset.usdValue : 0

      const shareNumeric = Number.isFinite(asset.share)
        ? asset.share
        : totalUsdValue > 0
          ? usdValueNumeric / totalUsdValue
          : 0

      return {
        ...asset,
        balance: balanceNumeric,
        usdValue: usdValueNumeric,
        share: shareNumeric,
        balanceDisplay: `${formatTokenAmount(balanceNumeric)} ${asset.symbol}`,
      }
    })
  }, [])

  const loadTreasury = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/treasury?ts=${Date.now()}`, { cache: 'no-store' })
      const json = (await response.json()) as TreasuryResponse | TreasuryErrorResponse

      if (!response.ok || !json || json.ok === false) {
        const message = json && 'error' in json ? json.error : null
        throw new Error(message ?? 'Unable to load treasury balances.')
      }

      const totalFromApi = Number.isFinite(json.totalValueUsd) ? json.totalValueUsd : 0
      const sanitizedAssets = sanitizeAssets(json.assets, totalFromApi)

      const recomputedTotal = totalFromApi > 0
        ? totalFromApi
        : sanitizedAssets.reduce((acc, asset) => acc + (Number.isFinite(asset.usdValue) ? asset.usdValue : 0), 0)

      const normalizedAssets = sanitizedAssets.map((asset) => {
        const share = recomputedTotal > 0 && Number.isFinite(asset.usdValue) ? asset.usdValue / recomputedTotal : 0
        return {
          ...asset,
          share,
        }
      })

      setWalletAddress(json.walletAddress)
      setTotalUsd(recomputedTotal)
      setAssets(normalizedAssets)
    } catch (err) {
      console.error('Failed to load treasury overview', err)
      setError(err instanceof Error ? err.message : 'Unable to load treasury balances.')
      setWalletAddress(null)
      setAssets([])
      setTotalUsd(0)
      onSummaryUpdate?.({ totalUsd: 0, walletAddress: null })
    } finally {
      setLoading(false)
    }
  }, [onSummaryUpdate, sanitizeAssets])

  useEffect(() => {
    void loadTreasury()
  }, [loadTreasury])

  useEffect(() => {
    const handler = () => {
      void loadTreasury()
    }

    window.addEventListener('deposit-confirmed', handler)
    return () => {
      window.removeEventListener('deposit-confirmed', handler)
    }
  }, [loadTreasury])

  useEffect(() => {
    const handleRefresh = () => {
      if (document.hidden) return
      void loadTreasury()
    }

    window.addEventListener('focus', handleRefresh)
    document.addEventListener('visibilitychange', handleRefresh)

    return () => {
      window.removeEventListener('focus', handleRefresh)
      document.removeEventListener('visibilitychange', handleRefresh)
    }
  }, [loadTreasury])

  if (loading && assets.length === 0) {
    return <div className="text-sm text-muted-foreground">Loading assets...</div>
  }

  if (error && assets.length === 0) {
    return <div className="text-sm text-destructive">{error}</div>
  }

  if (!walletAddress || assets.length === 0) {
    return <div className="text-sm text-muted-foreground">No treasury assets detected yet.</div>
  }

  return (
    <div className="flex gap-1 w-full">
      {orderedAssets.map((asset) => {
        const share = asset.share > 0 ? asset.share : 0
        const widthPercent = share > 0 ? Math.max(share * 100, 6) : 6
        const color = getAssetColor(asset.symbol)

        return (
          <div
            key={asset.id}
            className="flex flex-col items-center justify-center gap-1 rounded-md border-2 px-2 py-3 text-xs"
            style={{
              backgroundColor: `${color}20`,
              borderColor: color,
              width: `${widthPercent}%`,
              minWidth: '6%',
            }}
          >
            <span className="text-xs font-semibold" style={{ color: '#0f172a' }}>
              {asset.balanceDisplay} ({formatUsd(asset.usdValue)})
            </span>
            <span className="text-xs font-medium" style={{ color: '#0f172a' }}>
              {(share * 100).toFixed(1)}%
            </span>
          </div>
        )
      })}
    </div>
  )
}

