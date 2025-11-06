'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pie, PieChart, Cell, ResponsiveContainer } from 'recharts'


type AnalyticsBreakdownEntry = {
  address: string
  valueWei: string
  valueEth: string
  valueUsd: number
  percentage: number
}

type AnalyticsResponse = {
  ok: boolean
  totalDeposits: {
    wei: string
    eth: string
    usd: string
    priceUsd: number
  }
  uniqueAddresses: number
  breakdown: AnalyticsBreakdownEntry[]
}

const CHART_COLORS = ['#2563eb', '#7c3aed', '#0ea5e9', '#22c55e', '#f97316', '#facc15']

function formatEth(value: string) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '0'
  if (parsed >= 1) return parsed.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return parsed.toFixed(6)
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return '$0.00'
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function formatPercentage(value: number) {
  if (!Number.isFinite(value)) return '0%'
  return `${value.toFixed(2)}%`
}

export function PlatformAnalytics() {
  const [data, setData] = useState<AnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    const load = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch('/api/analytics', { cache: 'no-store' })
        if (!response.ok) {
          throw new Error('Failed to load analytics data')
        }
        const json = (await response.json()) as AnalyticsResponse
        if (active) {
          setData(json)
        }
      } catch (err) {
        console.error('Failed to load analytics data', err)
        if (active) {
          setError('Unable to load analytics data')
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [])

  // Listen for deposit confirmation events to refresh analytics
  useEffect(() => {
    const handleDepositConfirmed = () => {
      // Reload analytics when a deposit is confirmed
      setLoading(true)
      setError(null)
      fetch('/api/analytics', { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) {
            throw new Error('Failed to load analytics data')
          }
          return response.json() as Promise<AnalyticsResponse>
        })
        .then((json) => {
          setData(json)
        })
        .catch((err) => {
          console.error('Failed to reload analytics data', err)
          setError('Unable to load analytics data')
        })
        .finally(() => {
          setLoading(false)
        })
    }
    window.addEventListener('deposit-confirmed', handleDepositConfirmed)
    return () => {
      window.removeEventListener('deposit-confirmed', handleDepositConfirmed)
    }
  }, [])

  const chartData = useMemo(() => {
    if (!data?.breakdown) return []
    return data.breakdown.map((entry) => ({
      name: entry.address,
      value: Number(entry.valueEth),
      percentage: entry.percentage,
      valueEth: entry.valueEth,
      valueUsd: entry.valueUsd,
    }))
  }, [data])

  return (
    <div className="space-y-6">
        {loading && <p className="text-sm text-muted-foreground">Loading analytics...</p>}
        {!loading && error && <p className="text-sm text-destructive">{error}</p>}

        {!loading && !error && data && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">Total Deposits (ETH)</p>
                <p className="text-2xl font-semibold">
                  {formatEth(data.totalDeposits.eth)} <span className="text-sm text-muted-foreground">ETH</span>
                </p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">Unique Addresses</p>
                <p className="text-2xl font-semibold">{data.uniqueAddresses.toLocaleString()}</p>
              </div>
            </div>

            {chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deposits recorded yet.</p>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="h-64 w-full max-w-md">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie
                        data={chartData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={2}
                      >
                        {chartData.map((entry, index) => (
                          <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-wrap justify-center gap-2 w-full max-w-md">
                  {chartData.map((entry, index) => (
                    <div key={entry.name} className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
                      <span
                        className="h-2 w-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-medium">
                          {entry.name === 'Others'
                            ? 'Others'
                            : `${entry.name.slice(0, 6)}...${entry.name.slice(-4)}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatEth(entry.valueEth)} ETH · {formatPercentage(entry.percentage)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
    </div>
  )
}

