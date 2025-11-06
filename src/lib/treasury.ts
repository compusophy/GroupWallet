import { isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export type TreasuryAssetConfig = {
  id: string
  type: 'native' | 'erc20'
  symbol: string
  displayName?: string
  address?: `0x${string}`
  decimals: number
  priceId: string
  color?: string
}

export type TreasuryConfig = {
  address: `0x${string}`
  assets: TreasuryAssetConfig[]
}

const DEFAULT_TREASURY_ADDRESS = '0xe815308ac85a573f7af1d4008c590948e69e124f'

const DEFAULT_ASSETS: TreasuryAssetConfig[] = [
  {
    id: 'eth',
    type: 'native',
    symbol: 'ETH',
    displayName: 'Ether',
    decimals: 18,
    priceId: 'coingecko:ethereum',
    color: '#0ea5e9',
  },
  {
    id: 'usdc',
    type: 'erc20',
    symbol: 'USDC',
    displayName: 'USD Coin',
    address: '0x833589fcd6edB6e08F4c7c32D4f71B54Bda02913',
    decimals: 6,
    priceId: 'coingecko:usd-coin',
    color: '#22c55e',
  },
]

function parseAssetConfig(value: unknown): TreasuryAssetConfig | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as Partial<TreasuryAssetConfig>

  if (!candidate.id || typeof candidate.id !== 'string') return null
  if (candidate.type !== 'native' && candidate.type !== 'erc20') return null
  if (!candidate.symbol || typeof candidate.symbol !== 'string') return null
  if (!candidate.priceId || typeof candidate.priceId !== 'string') return null
  if (typeof candidate.decimals !== 'number' || !Number.isFinite(candidate.decimals)) return null

  if (candidate.type === 'erc20') {
    if (!candidate.address || typeof candidate.address !== 'string' || !isAddress(candidate.address)) {
      return null
    }
  }

  return {
    id: candidate.id,
    type: candidate.type,
    symbol: candidate.symbol,
    displayName: candidate.displayName,
    address: candidate.address as `0x${string}` | undefined,
    decimals: candidate.decimals,
    priceId: candidate.priceId,
    color: candidate.color,
  }
}

export function getTreasuryAddress(): `0x${string}` {
  const rawPrivateKey = getTreasuryPrivateKey()
  const derivedAddress = (() => {
    if (!rawPrivateKey) return null
    try {
      return privateKeyToAccount(rawPrivateKey).address
    } catch (error) {
      console.error('Failed to derive treasury address from private key:', error)
      return null
    }
  })()

  const fromEnv =
    process.env.TREASURY_ADDRESS ??
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS ??
    derivedAddress ??
    DEFAULT_TREASURY_ADDRESS

  const address = fromEnv.trim()
  if (!isAddress(address)) {
    throw new Error('Invalid treasury address. Set TREASURY_ADDRESS to a valid 0x address.')
  }

  if (derivedAddress && derivedAddress.toLowerCase() !== address.toLowerCase()) {
    console.warn(
      'Treasury address derived from private key does not match TREASURY_ADDRESS. Using configured address.'
    )
  }

  return address as `0x${string}`
}

export function getTreasuryAssets(): TreasuryAssetConfig[] {
  const raw = process.env.TREASURY_ASSETS ?? process.env.NEXT_PUBLIC_TREASURY_ASSETS

  if (!raw) {
    return DEFAULT_ASSETS
  }

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.warn('TREASURY_ASSETS must be a JSON array. Falling back to defaults.')
      return DEFAULT_ASSETS
    }

    const assets = parsed
      .map((item) => parseAssetConfig(item))
      .filter((asset): asset is TreasuryAssetConfig => asset !== null)

    if (assets.length === 0) {
      console.warn('No valid assets found in TREASURY_ASSETS. Falling back to defaults.')
      return DEFAULT_ASSETS
    }

    return assets
  } catch (error) {
    console.error('Failed to parse TREASURY_ASSETS. Falling back to defaults.', error)
    return DEFAULT_ASSETS
  }
}

export function getTreasuryConfig(): TreasuryConfig {
  return {
    address: getTreasuryAddress(),
    assets: getTreasuryAssets(),
  }
}

export function getTreasuryPrivateKey(): `0x${string}` | null {
  const raw = process.env.TREASURY_PRIVATE_KEY ?? null
  if (!raw) return null

  const normalized = raw.startsWith('0x') ? raw : `0x${raw}`
  const isValid = /^0x[0-9a-fA-F]{64}$/.test(normalized)

  if (!isValid) {
    console.error('TREASURY_PRIVATE_KEY must be a 32-byte hex string (optionally prefixed with 0x).')
    throw new Error('Invalid TREASURY_PRIVATE_KEY value.')
  }

  return normalized as `0x${string}`
}


