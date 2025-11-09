import { redis } from './redis'
import { getTreasuryConfig } from './treasury'

const CACHE_TTL_SECONDS = Number.parseInt(process.env.PRICE_CACHE_TTL_SECONDS ?? '60', 10)
const CACHE_KEY_PREFIX = 'price:snapshot:'

export type PriceSource = 'coinbase'

export type PriceSnapshot = {
  assetId: string
  symbol: string
  priceUsd: number
  source: PriceSource
  updatedAt: number
  expiresAt: number
  roundId?: string
  priceDecimals: number
  rawPrice: string
}

export type AssetPriceResult = {
  snapshot: PriceSnapshot
  stale: boolean
}

function createCacheKey(assetId: string) {
  return `${CACHE_KEY_PREFIX}${assetId.toLowerCase()}`
}

async function readSnapshotFromCache(assetId: string): Promise<PriceSnapshot | null> {
  try {
    const key = createCacheKey(assetId)
    const cached = await redis.get<string | PriceSnapshot>(key)
    if (!cached) return null

    let parsed: PriceSnapshot | null = null
    if (typeof cached === 'string') {
      try {
        parsed = JSON.parse(cached) as PriceSnapshot
      } catch {
        try {
          await redis.del(key)
        } catch {}
        return null
      }
    } else if (cached && typeof cached === 'object') {
      parsed = cached as PriceSnapshot
    }

    if (!parsed) return null
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
      return null
    }
    return parsed
  } catch (error) {
    console.warn('Failed to read cached price snapshot', { assetId, error })
    return null
  }
}

async function storeSnapshotInCache(snapshot: PriceSnapshot) {
  try {
    await redis.set(createCacheKey(snapshot.assetId), JSON.stringify(snapshot), {
      ex: CACHE_TTL_SECONDS,
    })
  } catch (error) {
    console.warn('Failed to cache price snapshot', { snapshot, error })
  }
}

export async function getAssetPrice(assetId: string): Promise<AssetPriceResult | null> {
  const config = getTreasuryConfig()
  const asset = config.assets.find((item) => item.id === assetId)
  if (!asset) {
    console.warn('Requested price for unknown asset', assetId)
    return null
  }

  const cached = await readSnapshotFromCache(asset.id)
  if (cached) {
    return {
      snapshot: cached,
      stale: false,
    }
  }

  // Pricing (Coinbase only):
  // - USDC -> Coinbase spot
  // - ETH  -> Coinbase spot
  try {
    const symbol = asset.id.toLowerCase() === 'eth' ? 'ETH' : asset.id.toLowerCase() === 'usdc' ? 'USDC' : null
    if (!symbol) {
      return null
    }
    const price = await fetchCoinbaseSpotPrice(`${symbol}-USD`)
    if (price && price > 0) {
      const now = Date.now()
      const snapshot: PriceSnapshot = {
        assetId: asset.id,
        symbol: asset.symbol,
        priceUsd: price,
        priceDecimals: 8,
        rawPrice: Math.round(price * 1e8).toString(),
        source: 'coinbase',
        updatedAt: now,
        expiresAt: now + CACHE_TTL_SECONDS * 1000,
      }
      await storeSnapshotInCache(snapshot)
      return { snapshot, stale: false }
    }
  } catch (error) {
    console.warn('Coinbase price fetch failed', { assetId: asset.id, error })
  }

  return null
}

export async function getPricesForAssets(assetIds: string[]): Promise<Map<string, PriceSnapshot>> {
  const entries = await Promise.all(
    assetIds.map(async (assetId) => {
      try {
        const resolved = await getAssetPrice(assetId)
        return resolved?.snapshot
      } catch (error) {
        console.error('Failed to load price for asset', { assetId, error })
        return null
      }
    })
  )

  const map = new Map<string, PriceSnapshot>()
  for (const snapshot of entries) {
    if (snapshot) {
      map.set(snapshot.assetId, snapshot)
    }
  }
  return map
}

async function fetchCoinbaseSpotPrice(pair: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, { next: { revalidate: 15 } })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { amount?: string; currency?: string } }
    const amount = json?.data?.amount ? Number.parseFloat(json.data.amount) : null
    return Number.isFinite(amount as number) && (amount as number) > 0 ? (amount as number) : null
  } catch {
    return null
  }
}

async function fetchCoinbaseEthUsdSpotPrice(): Promise<number | null> {
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { next: { revalidate: 15 } })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { amount?: string; currency?: string } }
    const amount = json?.data?.amount ? Number.parseFloat(json.data.amount) : null
    return Number.isFinite(amount as number) && (amount as number) > 0 ? (amount as number) : null
  } catch {
    return null
  }
}


