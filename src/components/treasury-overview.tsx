'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'

// Color mapping for specific tokens
function getAssetColor(symbol: string): string {
  const upperSymbol = symbol.toUpperCase()
  if (upperSymbol === 'ETH') return '#2563eb' // Blue
  if (upperSymbol === 'USDC') return '#22c55e' // Green
  if (upperSymbol === 'USDB' || upperSymbol === 'USDBC') return '#0ea5e9' // Light blue
  // Fallback colors for other tokens
  const fallbackColors = ['#7c3aed', '#f97316', '#facc15', '#ef4444', '#8b5cf6']
  return fallbackColors[symbol.length % fallbackColors.length]
}

type TreasuryAsset = {
  id: string
  symbol: string
  name: string
  type: 'native' | 'erc20'
  address: string | null
  decimals: number
  priceId: string
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
  assets: TreasuryAsset[]
  updatedAt: string
}

type TreasuryErrorResponse = {
  ok: false
  error?: string
}


function formatUsd(value: number) {
  if (!Number.isFinite(value)) return '$0.00'
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function formatPercentage(value: number) {
  if (!Number.isFinite(value)) return '0%'
  return `${Math.round(value * 100)}%`
}

function getContrastingTextColor(color: string): string {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return '#0f172a'
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#0f172a' : '#f8fafc'
}

function formatAddress(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`
}

export function TreasuryOverview() {
  const [data, setData] = useState<TreasuryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const loadTreasury = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/treasury', { cache: 'no-store' })
      const json = (await response.json()) as TreasuryResponse | TreasuryErrorResponse

      if (!response.ok || !json || json.ok === false) {
        const message = json && 'error' in json ? json.error : null
        throw new Error(message ?? 'Unable to load treasury balances.')
      }

      setData(json)
    } catch (err) {
      console.error('Failed to load treasury overview', err)
      setError(err instanceof Error ? err.message : 'Unable to load treasury balances.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

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

  const totalValueUsd = useMemo(() => {
    if (!data) return 0
    if (Number.isFinite(data.totalValueUsd)) return data.totalValueUsd
    return data.assets.reduce((acc, asset) => acc + (Number.isFinite(asset.usdValue) ? asset.usdValue : 0), 0)
  }, [data])

  const handleCopyAddress = useCallback(() => {
    if (!data?.walletAddress) return
    navigator.clipboard
      .writeText(data.walletAddress)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch((err) => {
        console.error('Failed to copy treasury address', err)
      })
  }, [data?.walletAddress])

  return (
    <div className="space-y-4">
        {loading && <p className="text-sm text-muted-foreground">Loading treasury data...</p>}
        {!loading && error && <p className="text-sm text-destructive">{error}</p>}

        {!loading && !error && data && (
          <>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground">Wallet</span>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
                    {formatAddress(data.walletAddress)}
                  </code>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted"
                    onClick={handleCopyAddress}
                    title="Copy wallet address"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground">Total Value</span>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold">{formatUsd(totalValueUsd)}</span>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                    onClick={() => void loadTreasury()}
                    disabled={loading}
                    title="Refresh balances"
                  >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>

            {data.assets.length > 0 && (
              <div className="space-y-2">
                {data.assets.map((asset) => {
                  const color = getAssetColor(asset.symbol)
                  return (
                    <div
                      key={asset.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
                        <div>
                          <p className="font-semibold text-foreground">{asset.symbol}</p>
                          <p className="text-muted-foreground">{asset.name}</p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end">
                        <span className="font-semibold text-foreground">{formatUsd(asset.usdValue)}</span>
                        <span className="text-muted-foreground">
                          {asset.balanceFormatted} {asset.symbol} · {formatPercentage(asset.share)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
    </div>
  )
}


