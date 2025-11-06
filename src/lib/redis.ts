import { Redis } from '@upstash/redis'
import { formatEther } from 'viem'

import { calculateDepositWeight } from './voting'

const BIGINT_ZERO = BigInt(0)

let redisInstance: Redis | null = null

function getRedis(): Redis {
  if (redisInstance) {
    return redisInstance
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!redisUrl || !redisToken) {
    throw new Error(
      'Missing Upstash Redis credentials. Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.'
    )
  }

  redisInstance = new Redis({
    url: redisUrl,
    token: redisToken,
  })

  return redisInstance
}

// Lazy-loaded Redis instance - only initializes when first accessed
export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    const instance = getRedis()
    const value = instance[prop as keyof Redis]
    if (typeof value === 'function') {
      return value.bind(instance)
    }
    return value
  },
})

// Transaction record schema
export type TransactionRecord = {
  hash: string
  from: string
  to: string
  value: string // Wei amount as string
  valueEth: string // ETH amount as string
  blockNumber: string
  blockHash: string
  timestamp: number // Unix timestamp in milliseconds
  chainId: number
  confirmations?: number
}

// User transaction list - sorted set key pattern: `user:tx:{address}`
// Transaction record key pattern: `tx:{hash}`
// User stats key pattern: `user:stats:{address}`

export async function recordSuccessfulTransaction(
  tx: TransactionRecord
): Promise<void> {
  const txKey = `tx:${tx.hash.toLowerCase()}`
  const userTxSetKey = `user:tx:${tx.from.toLowerCase()}`
  const userStatsKey = `user:stats:${tx.from.toLowerCase()}`

  // Store transaction record (expires after 1 year)
  await redis.setex(txKey, 365 * 24 * 60 * 60, JSON.stringify(tx))

  // Add to user's transaction set (sorted by timestamp)
  await redis.zadd(userTxSetKey, {
    score: tx.timestamp,
    member: tx.hash.toLowerCase(),
  })

  // Update user stats
  const stats = await redis.hgetall<{ totalTransactions?: string; totalValueWei?: string }>(userStatsKey)
  const currentCount = Number(stats?.totalTransactions ?? 0)
  let currentTotalValue = BIGINT_ZERO
  try {
    currentTotalValue = BigInt(stats?.totalValueWei ?? '0')
  } catch {
    currentTotalValue = BIGINT_ZERO
  }
  const newTotalValue = currentTotalValue + BigInt(tx.value)

  await redis.hset(userStatsKey, {
    totalTransactions: currentCount + 1,
    totalValueWei: newTotalValue.toString(),
    lastTransactionHash: tx.hash.toLowerCase(),
    lastTransactionTimestamp: tx.timestamp.toString(),
  })

  // Set expiration on user keys (1 year)
  await redis.expire(userTxSetKey, 365 * 24 * 60 * 60)
  await redis.expire(userStatsKey, 365 * 24 * 60 * 60)
}

export async function getTransactionByHash(hash: string): Promise<TransactionRecord | null> {
  const txKey = `tx:${hash.toLowerCase()}`
  const data = await redis.get<string>(txKey)
  if (!data) return null
  return JSON.parse(data) as TransactionRecord
}

export async function getUserTransactions(
  address: string,
  limit = 50
): Promise<TransactionRecord[]> {
  const userTxSetKey = `user:tx:${address.toLowerCase()}`
  const hashes = await redis.zrange<string[]>(userTxSetKey, 0, limit - 1, { rev: true })

  if (!hashes || hashes.length === 0) return []

  const txKeys = hashes.map((hash) => `tx:${hash.toLowerCase()}`)
  const transactions = await redis.mget<Array<string | null>>(txKeys)

  return transactions
    .filter((tx): tx is string => tx !== null)
    .map((tx) => JSON.parse(tx) as TransactionRecord)
}

export type UserStatsRecord = {
  address: string
  totalTransactions: number
  totalValueWei: string
  lastTransactionHash: string | null
  lastTransactionTimestamp: number | null
}

export async function getUserStats(address: string): Promise<{
  totalTransactions: number
  totalValueWei: string
  lastTransactionHash: string | null
  lastTransactionTimestamp: number | null
} | null> {
  const userStatsKey = `user:stats:${address.toLowerCase()}`
  const stats = await redis.hgetall<{
    totalTransactions?: string
    totalValueWei?: string
    lastTransactionHash?: string
    lastTransactionTimestamp?: string
  }>(userStatsKey)

  if (!stats || Object.keys(stats).length === 0) return null

  return {
    totalTransactions: Number(stats.totalTransactions ?? 0),
    totalValueWei: stats.totalValueWei ?? '0',
    lastTransactionHash: stats.lastTransactionHash ?? null,
    lastTransactionTimestamp: stats.lastTransactionTimestamp
      ? Number(stats.lastTransactionTimestamp)
      : null,
  }
}

async function scanKeys(match: string, count = 100): Promise<string[]> {
  try {
    let cursor = 0
    const keys: string[] = []

    do {
      const [nextCursor, batch] = await redis.scan(cursor, { match, count })
      if (batch && batch.length > 0) {
        keys.push(...batch)
      }
      cursor = Number(nextCursor)
    } while (cursor !== 0)

    return keys
  } catch (error) {
    console.error('Failed to scan Redis keys:', error)
    return []
  }
}

export async function getAllUserStats(): Promise<UserStatsRecord[]> {
  try {
    const keys = await scanKeys('user:stats:*')
    if (keys.length === 0) return []

    const records = await Promise.all(
      keys.map(async (key) => {
        try {
          const stats = await redis.hgetall<{
            totalTransactions?: string
            totalValueWei?: string
            lastTransactionHash?: string
            lastTransactionTimestamp?: string
          }>(key)

          if (!stats || Object.keys(stats).length === 0) {
            return null
          }

          const address = key.replace('user:stats:', '')

          return {
            address,
            totalTransactions: Number(stats.totalTransactions ?? 0),
            totalValueWei: stats.totalValueWei ?? '0',
            lastTransactionHash: stats.lastTransactionHash ?? null,
            lastTransactionTimestamp: stats.lastTransactionTimestamp
              ? Number(stats.lastTransactionTimestamp)
              : null,
          } satisfies UserStatsRecord
        } catch (error) {
          console.error(`Failed to get stats for key ${key}:`, error)
          return null
        }
      })
    )

    return records.filter((record): record is UserStatsRecord => record !== null)
  } catch (error) {
    console.error('Failed to get all user stats:', error)
    return []
  }
}

export type VoteChoice = 'yes' | 'no'

export type VoteRecord = {
  address: string
  choice: VoteChoice
  weight: number
  depositValueWei: string
  depositValueEth: string
  timestamp: number
}

function getVoteRecordsKey(proposalId: string) {
  return `vote:${proposalId}:records`
}

function getVoteTotalsKey(proposalId: string) {
  return `vote:${proposalId}:totals`
}

export async function recordVote(
  proposalId: string,
  vote: VoteRecord
): Promise<void> {
  const addressKey = vote.address.toLowerCase()
  const recordsKey = getVoteRecordsKey(proposalId)

  const payload: VoteRecord = {
    ...vote,
    address: addressKey,
  }

  await redis.hset(recordsKey, { [addressKey]: JSON.stringify(payload) })
}

export async function getVoteRecord(
  proposalId: string,
  address: string
): Promise<VoteRecord | null> {
  const recordsKey = getVoteRecordsKey(proposalId)
  try {
    const record = await redis.hget<string | VoteRecord>(recordsKey, address.toLowerCase())
    if (!record) return null
    
    if (typeof record === 'string') {
      try {
        return JSON.parse(record) as VoteRecord
      } catch (error) {
        console.error('Failed to parse vote record:', error, record)
        return null
      }
    }
    
    if (record && typeof record === 'object') {
      return record as VoteRecord
    }
    
    return null
  } catch (error) {
    console.error('Failed to get vote record:', error)
    return null
  }
}

export async function getVoteResults(proposalId: string): Promise<{
  totals: { yes: number; no: number; totalWeight: number; totalVoters: number }
  votes: VoteRecord[]
}> {
  const totalsKey = getVoteTotalsKey(proposalId)
  const recordsKey = getVoteRecordsKey(proposalId)

  let voteRecordsRaw: Record<string, string | VoteRecord> | null = null
  try {
    voteRecordsRaw = await redis.hgetall<Record<string, string | VoteRecord>>(recordsKey)
  } catch (error) {
    console.error('Failed to get vote records:', error)
  }

  const parsedVotes: VoteRecord[] = voteRecordsRaw && Object.keys(voteRecordsRaw).length > 0
    ? Object.entries(voteRecordsRaw)
        .map(([addressKey, value]) => {
          if (typeof value === 'string') {
            try {
              const vote = JSON.parse(value) as VoteRecord
              return { ...vote, address: addressKey }
            } catch (error) {
              console.error('Failed to parse vote record:', error, value)
              return null
            }
          }
          if (value && typeof value === 'object') {
            return { ...(value as VoteRecord), address: addressKey }
          }
          return null
        })
        .filter((vote): vote is VoteRecord => vote !== null)
    : []

  if (parsedVotes.length === 0) {
    const emptyTotals = { yes: 0, no: 0, totalWeight: 0, totalVoters: 0 }
    await redis.hset(totalsKey, {
      yes: '0',
      no: '0',
      totalWeight: '0',
      totalVoters: '0',
    })
    return { totals: emptyTotals, votes: [] }
  }

  const userStats = await getAllUserStats()
  const statsMap = new Map(userStats.map((stat) => [stat.address.toLowerCase(), stat]))

  const totalDepositsWei = userStats.reduce((acc, stat) => {
    try {
      return acc + BigInt(stat.totalValueWei)
    } catch {
      return acc
    }
  }, BIGINT_ZERO)

  let yesWeight = 0
  let noWeight = 0
  let totalWeight = 0
  let totalVoters = 0

  const updatedVotes = parsedVotes.map((vote) => {
    const address = vote.address.toLowerCase()
    const stats = statsMap.get(address)

    let depositWei = BIGINT_ZERO
    if (stats) {
      try {
        depositWei = BigInt(stats.totalValueWei)
      } catch {
        depositWei = BIGINT_ZERO
      }
    }

    if (depositWei === BIGINT_ZERO) {
      try {
        depositWei = BigInt(vote.depositValueWei)
      } catch {
        depositWei = BIGINT_ZERO
      }
    }

    const weight = calculateDepositWeight(depositWei, totalDepositsWei)
    const depositEth = formatEther(depositWei)

    if (weight > 0) {
      totalVoters += 1
      totalWeight += weight
      if (vote.choice === 'yes') {
        yesWeight += weight
      } else {
        noWeight += weight
      }
    }

    return {
      ...vote,
      address,
      weight,
      depositValueWei: depositWei.toString(),
      depositValueEth: depositEth,
    }
  })

  const totalWeightRaw = totalWeight
  const cappedTotalWeight = totalWeightRaw > 1 ? 1 : totalWeightRaw
  let normalizedYes = yesWeight
  let normalizedNo = noWeight

  if (totalWeightRaw > 1 && totalWeightRaw > 0) {
    const scale = cappedTotalWeight / totalWeightRaw
    normalizedYes *= scale
    normalizedNo *= scale
  }

  const normalizedTotals = {
    yes: normalizedYes,
    no: normalizedNo,
    totalWeight: cappedTotalWeight,
    totalVoters,
  }

  if (updatedVotes.length > 0) {
    const updates = updatedVotes.reduce<Record<string, string>>((acc, vote) => {
      acc[vote.address.toLowerCase()] = JSON.stringify(vote)
      return acc
    }, {})
    await redis.hset(recordsKey, updates)
  }

  await redis.hset(totalsKey, {
    yes: normalizedTotals.yes.toString(),
    no: normalizedTotals.no.toString(),
    totalWeight: normalizedTotals.totalWeight.toString(),
    totalVoters: normalizedTotals.totalVoters.toString(),
  })

  return { totals: normalizedTotals, votes: updatedVotes }
}

