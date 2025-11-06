import { NextResponse } from 'next/server'
import { formatEther } from 'viem'

import { getAllUserStats } from '@/lib/redis'

const DEFAULT_ETH_PRICE_USD = 3000
const BIGINT_ZERO = BigInt(0)
const BIGINT_TEN_THOUSAND = BigInt(10000)

function getEthPriceUsd(): number {
  const fromEnv = process.env.ETH_PRICE_USD ?? process.env.NEXT_PUBLIC_ETH_PRICE_USD
  const parsed = fromEnv ? Number(fromEnv) : Number.NaN
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return DEFAULT_ETH_PRICE_USD
}

export async function GET() {
  try {
    const userStats = await getAllUserStats()

    const totalDepositsWei = userStats.reduce((acc, stat) => {
      try {
        return acc + BigInt(stat.totalValueWei)
      } catch {
        return acc
      }
    }, BIGINT_ZERO)

    const totalDepositsEth = totalDepositsWei === BIGINT_ZERO ? '0' : formatEther(totalDepositsWei)
    const ethPriceUsd = getEthPriceUsd()
    const totalDepositsUsd = (Number(totalDepositsEth) * ethPriceUsd).toFixed(2)

    const breakdown = userStats
      .map((stat) => {
        const valueWei = (() => {
          try {
            return BigInt(stat.totalValueWei)
          } catch {
            return BIGINT_ZERO
          }
        })()

        if (valueWei === BIGINT_ZERO) {
          return null
        }

        const valueEth = formatEther(valueWei)
        const valueUsd = Number(valueEth) * ethPriceUsd
        const percentage = totalDepositsWei === BIGINT_ZERO
          ? 0
          : Number((valueWei * BIGINT_TEN_THOUSAND) / totalDepositsWei) / 100

        return {
          address: stat.address,
          valueWei: valueWei.toString(),
          valueEth,
          valueUsd: Number.isFinite(valueUsd) ? valueUsd : 0,
          percentage,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => Number(b.valueEth) - Number(a.valueEth))

    const MAX_BREAKDOWN_ENTRIES = 6
    let breakdownWithOthers = breakdown

    if (breakdown.length > MAX_BREAKDOWN_ENTRIES) {
      const main = breakdown.slice(0, MAX_BREAKDOWN_ENTRIES - 1)
      const others = breakdown.slice(MAX_BREAKDOWN_ENTRIES - 1)

      const aggregatedValueWei = others.reduce((acc, entry) => acc + BigInt(entry.valueWei), BIGINT_ZERO)
      const aggregatedValueEth = aggregatedValueWei === BIGINT_ZERO ? '0' : formatEther(aggregatedValueWei)
      const aggregatedValueUsd = Number(aggregatedValueEth) * ethPriceUsd
      const aggregatedPercentage = totalDepositsWei === BIGINT_ZERO
        ? 0
        : Number((aggregatedValueWei * BIGINT_TEN_THOUSAND) / totalDepositsWei) / 100

      breakdownWithOthers = [
        ...main,
        {
          address: 'Others',
          valueWei: aggregatedValueWei.toString(),
          valueEth: aggregatedValueEth,
          valueUsd: Number.isFinite(aggregatedValueUsd) ? aggregatedValueUsd : 0,
          percentage: aggregatedPercentage,
        },
      ]
    }

    return NextResponse.json({
      ok: true,
      totalDeposits: {
        wei: totalDepositsWei.toString(),
        eth: totalDepositsEth,
        usd: totalDepositsUsd,
        priceUsd: ethPriceUsd,
      },
      uniqueAddresses: userStats.length,
      breakdown: breakdownWithOthers,
    })
  } catch (error) {
    console.error('Failed to load analytics data', error)
    return NextResponse.json(
      { ok: false, error: 'Failed to load analytics data' },
      { status: 500 }
    )
  }
}

