import { randomUUID } from 'node:crypto'

import { Address, createPublicClient, createWalletClient, encodeFunctionData, http, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'wagmi/chains'

import { enqueueJob, type Job } from './jobs'
import { markUserSettled, removeAllocationVote, redis } from './redis'
import { VOTE_PROPOSAL_ID } from './voting'
import { getTreasuryPrivateKey } from './treasury'
import { enqueueRebalance } from './rebalance'

const EXECUTE_SETTLEMENT = (process.env.CLAIM_EXECUTE ?? '').toLowerCase() === 'true'
const SETTLEMENT_HISTORY_LIMIT = Number.parseInt(process.env.SETTLEMENT_HISTORY_LIMIT ?? '50', 10)

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

type HeartbeatFn = () => Promise<void>

export type SettlementAssetPlan = {
  assetId: string
  symbol: string
  type: 'native' | 'erc20'
  tokenAddress: string | null
  decimals: number
  amountWei: string
  amountFormatted: string
}

export type SettlementJobPayload = {
  address: `0x${string}`
  share: number
  plan: SettlementAssetPlan[]
  totalDepositsWei: string
  requestId: string
  requestedAt: number
}

export type SettlementTransferResult = {
  assetId: string
  symbol: string
  amountWei: string
  txHash: string
  type: 'native' | 'erc20'
}

export type SettlementStatusState = 'queued' | 'executing' | 'executed' | 'dry-run' | 'failed'

export type SettlementStatus = {
  jobId: string
  requestId: string
  address: `0x${string}`
  share: number
  plan: SettlementAssetPlan[]
  state: SettlementStatusState
  createdAt: number
  updatedAt: number
  transactions?: SettlementTransferResult[]
  error?: string
}

const USER_STATUS_PREFIX = 'settlement:user:'
const JOB_STATUS_PREFIX = 'settlement:job:'
const HISTORY_KEY = 'settlement:history'
const SETTLEMENT_MAX_AGE_MS = Number.parseInt(process.env.SETTLEMENT_MAX_AGE_MINUTES ?? '5', 10) * 60 * 1000 // Default 5 minutes

function getUserStatusKey(address: string) {
  return `${USER_STATUS_PREFIX}${address.toLowerCase()}`
}

function getJobStatusKey(jobId: string) {
  return `${JOB_STATUS_PREFIX}${jobId}`
}

export async function loadUserStatus(address: string): Promise<SettlementStatus | null> {
  const data = await redis.get(getUserStatusKey(address))
  if (!data) return null
  try {
    // Handle both string and already-parsed object cases
    if (typeof data === 'string') {
      return JSON.parse(data) as SettlementStatus
    }
    return data as SettlementStatus
  } catch (error) {
    console.error('Failed to parse settlement status for user', { address, error })
    return null
  }
}

async function persistStatus(status: SettlementStatus) {
  const serialized = JSON.stringify(status)
  await redis
    .multi()
    .set(getJobStatusKey(status.jobId), serialized)
    .set(getUserStatusKey(status.address), serialized)
    .lpush(HISTORY_KEY, serialized)
    .ltrim(HISTORY_KEY, 0, SETTLEMENT_HISTORY_LIMIT - 1)
    .exec()
}

export async function enqueueSettlement(
  payload: SettlementJobPayload
): Promise<{ status: SettlementStatus; queued: boolean }> {
  // Periodic cleanup of stale settlements (10% chance to avoid overhead)
  if (Math.random() < 0.1) {
    await cleanupStaleSettlements()
  }

  let existing = await loadUserStatus(payload.address)
  if (existing) {
    // If already executed, check if user has new contributions
    if (existing.state === 'executed') {
      // Check if user has new contributions after settlement
      // If they do, clear the old settlement status and allow new settlement
      const { getUserStats } = await import('./redis')
      const userStats = await getUserStats(payload.address.toLowerCase())
      const hasNewContributions = userStats && BigInt(userStats.totalValueWei) > BigInt(0)
      
      if (hasNewContributions) {
        console.log('[settlement] User has new contributions after settlement, clearing old status', {
          address: payload.address,
          totalValueWei: userStats.totalValueWei,
        })
        // Clear old settlement status to allow new settlement
        await redis.del(getUserStatusKey(payload.address))
        await redis.del(getJobStatusKey(existing.jobId))
        // Clear deduplication key to allow new job to be enqueued
        const dedupeKey = `jobs:dedupe:settlement:${payload.address.toLowerCase()}`
        await redis.del(dedupeKey)
        // Clear existing so we don't check it again below
        existing = null
        // Continue with new settlement below
      } else {
        console.log('[settlement] User already settled with no new contributions', { address: payload.address })
        return { status: existing, queued: false }
      }
    }

    // Only check stale status if existing is still set (wasn't cleared above)
    if (existing) {
      // Check if existing status is stale (in queued/executing/failed state for too long)
      const age = Date.now() - existing.updatedAt
      const isStale = age > SETTLEMENT_MAX_AGE_MS && (
        existing.state === 'queued' || 
        existing.state === 'executing' || 
        existing.state === 'failed'
      )

      if (isStale) {
        console.log('[settlement] Found stale settlement status, cleaning up', {
          address: payload.address,
          jobId: existing.jobId,
          state: existing.state,
          ageMinutes: Math.round(age / (60 * 1000)),
        })
        // Clear stale status and continue with new settlement
        await redis.del(getUserStatusKey(payload.address))
        await redis.del(getJobStatusKey(existing.jobId))
        // Clear deduplication key to allow new job to be enqueued
        const dedupeKey = `jobs:dedupe:settlement:${payload.address.toLowerCase()}`
        await redis.del(dedupeKey)
        // Clear existing so we don't return it
        existing = null
      } else {
        // Return existing status if not stale (and not executed, which we already checked above)
        return { status: existing, queued: false }
      }
    }
  }

  const job = await enqueueJob<SettlementJobPayload>('settlement', payload, {
    dedupeKey: `settlement:${payload.address.toLowerCase()}`,
    dedupeTtlSeconds: 300,
  })

  if (!job) {
    const duplicate = (await loadUserStatus(payload.address)) ?? {
      jobId: 'unknown',
      requestId: payload.requestId,
      address: payload.address,
      share: payload.share,
      plan: payload.plan,
      state: 'queued' as SettlementStatusState,
      createdAt: payload.requestedAt,
      updatedAt: payload.requestedAt,
    }
    return { status: duplicate, queued: false }
  }

  const status: SettlementStatus = {
    jobId: job.id,
    requestId: payload.requestId,
    address: payload.address,
    share: payload.share,
    plan: payload.plan,
    state: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await persistStatus(status)

  return { status, queued: true }
}

async function updateStatusPartial(jobId: string, updates: Partial<SettlementStatus>) {
  const jobKey = getJobStatusKey(jobId)
  const currentRaw = await redis.get(jobKey)
  if (!currentRaw) return
  let current: SettlementStatus
  try {
    // Handle both string and already-parsed object cases
    if (typeof currentRaw === 'string') {
      current = JSON.parse(currentRaw) as SettlementStatus
    } else {
      current = currentRaw as SettlementStatus
    }
  } catch (error) {
    console.error('Failed to parse settlement job for update', { jobId, error })
    return
  }

  const next: SettlementStatus = {
    ...current,
    ...updates,
    updatedAt: Date.now(),
  }

  await persistStatus(next)
}

async function executeSettlementTransfers(
  payload: SettlementJobPayload,
  heartbeat?: HeartbeatFn
): Promise<SettlementTransferResult[]> {
  console.log('[settlement] executeSettlementTransfers called', {
    executeSettlement: EXECUTE_SETTLEMENT,
    address: payload.address,
    planItems: payload.plan.length,
  })

  if (!EXECUTE_SETTLEMENT) {
    console.log('[settlement] EXECUTE_SETTLEMENT is false, returning empty results')
    return []
  }

  const privateKey = getTreasuryPrivateKey()
  if (!privateKey) {
    throw new Error('TREASURY_PRIVATE_KEY must be configured for settlement execution.')
  }

  const baseRpcUrl = process.env.BASE_RPC_URL
  if (!baseRpcUrl) {
    throw new Error('BASE_RPC_URL must be configured for settlement execution.')
  }

  const account = privateKeyToAccount(privateKey)
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(baseRpcUrl),
  })
  const publicClient = createPublicClient({
    chain: base,
    transport: http(baseRpcUrl),
  })

  const results: SettlementTransferResult[] = []

  console.log('[settlement] Starting transfers', {
    from: account.address,
    to: payload.address,
    planItems: payload.plan.length,
  })

  for (const item of payload.plan) {
    const amountWei = BigInt(item.amountWei)
    if (amountWei === BigInt(0)) {
      console.log('[settlement] Skipping zero amount', { symbol: item.symbol })
      continue
    }

    await heartbeat?.()

    if (item.type === 'native') {
      console.log('[settlement] Sending native transfer', {
        symbol: item.symbol,
        from: account.address,
        to: payload.address,
        amountWei: amountWei.toString(),
        amountFormatted: item.amountFormatted,
      })

      try {
        const txHash = await walletClient.sendTransaction({
          account,
          chain: base,
          to: payload.address,
          value: amountWei,
        })

        console.log('[settlement] Native transaction sent', { symbol: item.symbol, txHash })
        await publicClient.waitForTransactionReceipt({ hash: txHash })
        console.log('[settlement] Native transaction confirmed', { symbol: item.symbol, txHash })

        results.push({
          assetId: item.assetId,
          symbol: item.symbol,
          amountWei: item.amountWei,
          txHash,
          type: item.type,
        })
      } catch (error) {
        console.error('[settlement] Failed to send native transfer', {
          symbol: item.symbol,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      continue
    }

    if (!item.tokenAddress) {
      console.warn('[settlement] Skipping ERC20 settlement without token address', {
        symbol: item.symbol,
        assetId: item.assetId,
      })
      continue
    }

    // Ensure token address is checksummed (required by viem)
    const tokenAddress = getAddress(item.tokenAddress)

    console.log('[settlement] Sending ERC20 transfer', {
      symbol: item.symbol,
      tokenAddress,
      to: payload.address,
      amountWei: amountWei.toString(),
      amountFormatted: item.amountFormatted,
    })

    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [payload.address as Address, amountWei],
    })

    try {
      const txHash = await walletClient.sendTransaction({
        account,
        chain: base,
        to: tokenAddress,
        data,
      })

      console.log('[settlement] ERC20 transaction sent', { symbol: item.symbol, txHash })
      await publicClient.waitForTransactionReceipt({ hash: txHash })
      console.log('[settlement] ERC20 transaction confirmed', { symbol: item.symbol, txHash })

      results.push({
        assetId: item.assetId,
        symbol: item.symbol,
        amountWei: item.amountWei,
        txHash,
        type: item.type,
      })
    } catch (error) {
      console.error('[settlement] Failed to send ERC20 transfer', {
        symbol: item.symbol,
        tokenAddress: item.tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  console.log('[settlement] All transfers completed', {
    address: payload.address,
    totalTransfers: results.length,
  })

  return results
}

export async function processSettlementJob(
  job: Job<SettlementJobPayload>,
  options: { heartbeat?: HeartbeatFn } = {}
): Promise<SettlementStatus> {
  console.log('[settlement] processSettlementJob called', {
    jobId: job.id,
    address: job.payload.address,
    planItems: job.payload.plan.length,
  })

  await updateStatusPartial(job.id, { state: 'executing' })
  console.log('[settlement] Status updated to executing')

  try {
    console.log('[settlement] Calling executeSettlementTransfers')
    const transfers = await executeSettlementTransfers(job.payload, options.heartbeat)
    console.log('[settlement] executeSettlementTransfers completed', { transferCount: transfers.length })

    if (EXECUTE_SETTLEMENT) {
      const addressLower = job.payload.address.toLowerCase()
      console.log('[settlement] Marking user as settled and removing vote', { address: addressLower })
      
      // Clear user contribution stats (sets totalValueWei to 0, totalTransactions to 0)
      await markUserSettled(addressLower)
      console.log('[settlement] User marked as settled - contribution stats cleared')
      
      // Remove allocation vote (removes vote record and recalculates consensus)
      await removeAllocationVote(VOTE_PROPOSAL_ID, addressLower)
      console.log('[settlement] Allocation vote removed - consensus recalculated')
      
      // Trigger rebalance to update vault allocation based on new consensus
      await enqueueRebalance('manual', { triggeredBy: 'settlement', address: addressLower })
      console.log('[settlement] Rebalance enqueued - vault will update to new consensus')
    }

    const state: SettlementStatusState = EXECUTE_SETTLEMENT ? 'executed' : 'dry-run'
    await updateStatusPartial(job.id, { state, transactions: transfers })

    const statusRaw = await redis.get(getJobStatusKey(job.id))
    if (!statusRaw) {
      throw new Error('Settlement status missing after update.')
    }
    // Handle both string and already-parsed object cases
    if (typeof statusRaw === 'string') {
      return JSON.parse(statusRaw) as SettlementStatus
    }
    return statusRaw as SettlementStatus
  } catch (error) {
    console.error('[settlement] Failed to execute settlement job', {
      jobId: job.id,
      address: job.payload.address,
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    })
    const message = error instanceof Error ? error.message : String(error)
    await updateStatusPartial(job.id, { state: 'failed', error: message })
    const statusRaw = await redis.get(getJobStatusKey(job.id))
    if (!statusRaw) {
      throw error
    }
    // Handle both string and already-parsed object cases
    if (typeof statusRaw === 'string') {
      return JSON.parse(statusRaw) as SettlementStatus
    }
    return statusRaw as SettlementStatus
  }
}

/**
 * Clean up stale settlement statuses that are in queued/executing state for too long
 * Returns the number of statuses cleaned up
 */
export async function cleanupStaleSettlements(): Promise<number> {
  try {
    const now = Date.now()
    const keys = await redis.keys(`${USER_STATUS_PREFIX}*`)
    if (!keys || keys.length === 0) return 0

    let cleaned = 0
    for (const key of keys) {
      try {
        const raw = await redis.get(key)
        if (!raw) continue

        const status = typeof raw === 'string' ? JSON.parse(raw) : raw as SettlementStatus
        const age = now - status.updatedAt

        if ((status.state === 'queued' || status.state === 'executing' || status.state === 'failed') && age > SETTLEMENT_MAX_AGE_MS) {
          console.log('[settlement] Cleaning up stale settlement', {
            address: status.address,
            jobId: status.jobId,
            state: status.state,
            ageMinutes: Math.round(age / (60 * 1000)),
          })
          await redis.del(key)
          if (status.jobId) {
            await redis.del(getJobStatusKey(status.jobId))
          }
          cleaned++
        }
      } catch (error) {
        console.warn('[settlement] Failed to process settlement key for cleanup', { key, error })
      }
    }

    if (cleaned > 0) {
      console.info('[settlement] Cleaned up stale settlements', { count: cleaned })
    }

    return cleaned
  } catch (error) {
    console.error('[settlement] Failed to cleanup stale settlements', error)
    return 0
  }
}


