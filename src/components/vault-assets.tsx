'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

function AssetIcon({ symbol }: { symbol: string }) {
  const upper = symbol.toUpperCase()
  if (upper === 'ETH') {
    // ETH icon (rounded)
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={20}
        height={20}
        fill="none"
        viewBox="0 0 20 20"
        style={{ borderRadius: 9999 }}
        aria-hidden
      >
        <g clipPath="url(#ethClip)">
          <path fill="#627EEA" d="M0 0h20v20H0z" />
          <path fill="white" d="m10 1.756-5.06 8.396 5.06-2.3z" />
          <path fill="#C0CBF7" d="m10 7.854-5.06 2.3 5.06 2.99zM15.06 10.152 10 1.756v6.096z" />
          <path fill="#8197EE" d="m10 13.145 5.06-2.992-5.06-2.3z" />
          <path fill="white" d="m4.94 11.113 5.06 7.13v-4.14z" />
          <path fill="#C0CBF7" d="M10 14.103v4.14l5.063-7.13z" />
        </g>
        <defs>
          <clipPath id="ethClip">
            <rect width="20" height="20" fill="white" rx="10" />
          </clipPath>
        </defs>
      </svg>
    )
  }
  if (upper === 'USDC') {
    // USDC icon (rounded)
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 2000 2000"
        width={20}
        height={20}
        style={{ borderRadius: 9999 }}
        aria-hidden
      >
        <path fill="#2775ca" d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000" />
        <path fill="#fff" d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84" />
        <path fill="#fff" d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5m441.67-1300c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67" />
      </svg>
    )
  }
  return null
}

// No per-asset color; match app primary color to keep design consistent

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
  onLoadingChange?: (loading: boolean) => void
  onAssetsUpdate?: (assets: any[]) => void
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

export function VaultAssets({ onSummaryUpdate, onLoadingChange, onAssetsUpdate }: VaultAssetsProps) {
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
    onLoadingChange?.(true)
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
      onAssetsUpdate?.(normalizedAssets)
    } catch (err) {
      console.error('Failed to load treasury overview', err)
      setError(err instanceof Error ? err.message : 'Unable to load treasury balances.')
      setWalletAddress(null)
      setAssets([])
      setTotalUsd(0)
      onSummaryUpdate?.({ totalUsd: 0, walletAddress: null })
    } finally {
      setLoading(false)
      onLoadingChange?.(false)
    }
  }, [onSummaryUpdate, onLoadingChange, sanitizeAssets])

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
    return (
      <div className="w-full">
        <div className="mb-3 space-y-1 text-center">
          <div className="animate-pulse h-4 rounded bg-muted w-48 mx-auto" />
          <div className="animate-pulse h-4 rounded bg-muted w-40 mx-auto" />
        </div>
        <div className="flex gap-1 w-full">
          <div className="rounded-md border-2 px-2 py-3 text-xs" style={{ width: '34%' }}>
            <div className="animate-pulse h-4 rounded bg-muted w-5/6" />
            <div className="animate-pulse h-3 rounded bg-muted w-1/2 mt-2" />
          </div>
          <div className="rounded-md border-2 px-2 py-3 text-xs" style={{ width: '22%' }}>
            <div className="animate-pulse h-4 rounded bg-muted w-4/5" />
            <div className="animate-pulse h-3 rounded bg-muted w-1/2 mt-2" />
          </div>
          <div className="rounded-md border-2 px-2 py-3 text-xs" style={{ width: '16%' }}>
            <div className="animate-pulse h-4 rounded bg-muted w-3/4" />
            <div className="animate-pulse h-3 rounded bg-muted w-1/2 mt-2" />
          </div>
          <div className="rounded-md border-2 px-2 py-3 text-xs" style={{ width: '12%' }}>
            <div className="animate-pulse h-4 rounded bg-muted w-2/3" />
            <div className="animate-pulse h-3 rounded bg-muted w-1/2 mt-2" />
          </div>
        </div>
      </div>
    )
  }

  if (error && assets.length === 0) {
    return <div className="text-sm text-destructive">{error}</div>
  }

  if (!walletAddress || assets.length === 0) {
    return <div className="text-sm text-muted-foreground">No treasury assets detected yet.</div>
  }

  return (
    <div className="w-full">
      {/* Percent-based containers */}
      <div className="flex gap-1 w-full">
        {orderedAssets.map((asset) => {
          const share = asset.share > 0 ? asset.share : 0
          const widthPercent = share > 0 ? Math.max(share * 100, 6) : 6

          return (
            <div
              key={asset.id}
              className="flex flex-col items-center justify-center gap-1 rounded-md border px-2 py-3 text-xs"
              style={{
                width: `${widthPercent}%`,
                minWidth: '6%',
                backgroundColor: asset.symbol.toUpperCase() === 'ETH' ? '#0000ff08' : '#3c8aff08',
                borderColor: asset.symbol.toUpperCase() === 'ETH' ? '#0000ff20' : '#3c8aff20',
              }}
            >
              <AssetIcon symbol={asset.symbol} />
              <span className="text-xs font-semibold">
                {asset.symbol}
              </span>
              <span className="text-xs font-medium">
                {(share * 100).toFixed(1)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

