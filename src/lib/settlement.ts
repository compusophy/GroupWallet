import { randomUUID } from 'node:crypto'

import { Address, createPublicClient, createWalletClient, encodeFunctionData, http } from 'viem'
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

function getUserStatusKey(address: string) {
  return `${USER_STATUS_PREFIX}${address.toLowerCase()}`
}

function getJobStatusKey(jobId: string) {
  return `${JOB_STATUS_PREFIX}${jobId}`
}

async function loadUserStatus(address: string): Promise<SettlementStatus | null> {
  const data = await redis.get<string>(getUserStatusKey(address))
  if (!data) return null
  try {
    return JSON.parse(data) as SettlementStatus
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
  const existing = await loadUserStatus(payload.address)
  if (existing && existing.state !== 'failed' && existing.state !== 'executed') {
    return { status: existing, queued: false }
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
  const currentRaw = await redis.get<string>(jobKey)
  if (!currentRaw) return
  let current: SettlementStatus
  try {
    current = JSON.parse(currentRaw) as SettlementStatus
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
  if (!EXECUTE_SETTLEMENT) {
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

  for (const item of payload.plan) {
    const amountWei = BigInt(item.amountWei)
    if (amountWei === BigInt(0)) continue

    await heartbeat?.()

    if (item.type === 'native') {
      const txHash = await walletClient.sendTransaction({
        account,
        chain: base,
        to: payload.address,
        value: amountWei,
      })
      await publicClient.waitForTransactionReceipt({ hash: txHash })
      results.push({
        assetId: item.assetId,
        symbol: item.symbol,
        amountWei: item.amountWei,
        txHash,
        type: item.type,
      })
      continue
    }

    if (!item.tokenAddress) {
      console.warn('Skipping ERC20 settlement without token address', item)
      continue
    }

    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [payload.address as Address, amountWei],
    })

    const txHash = await walletClient.sendTransaction({
      account,
      chain: base,
      to: item.tokenAddress as Address,
      data,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    results.push({
      assetId: item.assetId,
      symbol: item.symbol,
      amountWei: item.amountWei,
      txHash,
      type: item.type,
    })
  }

  return results
}

export async function processSettlementJob(
  job: Job<SettlementJobPayload>,
  options: { heartbeat?: HeartbeatFn } = {}
): Promise<SettlementStatus> {
  await updateStatusPartial(job.id, { state: 'executing' })

  try {
    const transfers = await executeSettlementTransfers(job.payload, options.heartbeat)

    if (EXECUTE_SETTLEMENT) {
      const addressLower = job.payload.address.toLowerCase()
      await markUserSettled(addressLower)
      await removeAllocationVote(VOTE_PROPOSAL_ID, addressLower)
      await enqueueRebalance('manual', { triggeredBy: 'settlement', address: addressLower })
    }

    const state: SettlementStatusState = EXECUTE_SETTLEMENT ? 'executed' : 'dry-run'
    await updateStatusPartial(job.id, { state, transactions: transfers })

    const statusRaw = await redis.get<string>(getJobStatusKey(job.id))
    if (!statusRaw) {
      throw new Error('Settlement status missing after update.')
    }
    return JSON.parse(statusRaw) as SettlementStatus
  } catch (error) {
    console.error('Failed to execute settlement job', { jobId: job.id, error })
    const message = error instanceof Error ? error.message : String(error)
    await updateStatusPartial(job.id, { state: 'failed', error: message })
    const statusRaw = await redis.get<string>(getJobStatusKey(job.id))
    if (!statusRaw) {
      throw error
    }
    return JSON.parse(statusRaw) as SettlementStatus
  }
}


