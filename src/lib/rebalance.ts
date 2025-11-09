import { base } from 'wagmi/chains'
import { Address, createPublicClient, createWalletClient, getAddress, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { enqueueJob, type Job } from './jobs'
import { getPricesForAssets } from './pricing'
import { fetchTreasuryState } from './treasury-state'
import { getAllocationVoteResults } from './redis'
import { VOTE_PROPOSAL_ID } from './voting'
import { getTreasuryConfig, getTreasuryPrivateKey } from './treasury'
import { redis } from './redis'

const PERCENT_SCALE = BigInt(10000)
const ZEROX_BASE_URL = process.env.ZEROX_BASE_URL ?? 'https://api.0x.org'
const ZEROX_API_KEY = process.env.ZEROX_API_KEY

// Base tokens
const WETH_ADDRESS = getAddress('0x4200000000000000000000000000000000000006')
// Native token placeholder address for 0x API (ETH)
const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address
const EXECUTE_REBALANCE = (process.env.REBALANCE_EXECUTE ?? '').toLowerCase() === 'true'
const REBALANCE_SLIPPAGE_BPS = Number.parseInt(process.env.REBALANCE_SLIPPAGE_BPS ?? '50', 10) // 0.50%
const REBALANCE_MIN_USD_DELTA = Number.parseFloat(process.env.REBALANCE_MIN_USD_DELTA ?? '5')
const REBALANCE_TOLERANCE_PERCENT = Number.parseFloat(process.env.REBALANCE_TOLERANCE_PERCENT ?? '1')
const REBALANCE_HISTORY_LIMIT = Number.parseInt(process.env.REBALANCE_HISTORY_LIMIT ?? '20', 10)

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

type HeartbeatFn = () => Promise<void>

export type RebalanceReason = 'deposit' | 'vote' | 'manual'

export type RebalanceJobPayload = {
  reason: RebalanceReason
  context?: Record<string, unknown>
}

export type RebalanceActionPlan = {
  sellAssetId: string
  sellAssetSymbol: string
  buyAssetId: string
  buyAssetSymbol: string
  sellAmountWei: string
  buyAmountWei: string
  deltaUsdRaw: string
  priceDecimals: number
}

export type RebalanceActionResult = RebalanceActionPlan & {
  txHash?: string
  quote?: {
    sellAmount: string
    buyAmount: string
    allowanceTarget?: string
    estimatedGas?: string
    sources?: Array<{ name: string; proportion: string }>
  }
}

export type RebalanceOutcome = {
  jobId: string
  reason: RebalanceReason
  mode: 'executed' | 'dry-run' | 'skipped'
  timestamp: number
  totals: {
    totalUsdRaw: string
    totalUsd: number
    priceDecimals: number
    targetPercents: Record<string, number>
  }
  message?: string
  actions: RebalanceActionResult[]
}

export async function enqueueRebalance(reason: RebalanceReason, context?: Record<string, unknown>) {
  // Do not dedupe aggressively; always enqueue and let the worker serialize execution via locks.
  console.info('[rebalance] enqueue request', { reason, context })
  await enqueueJob<RebalanceJobPayload>('rebalance', { reason, context })
}

type QuoteResponseV2 = {
  blockNumber?: string
  buyAmount: string
  buyToken?: string
  sellAmount: string
  sellToken?: string
  minBuyAmount?: string
  route?: {
    fills?: Array<{ from: string; to: string; source: string; proportionBps: string }>
    tokens?: Array<{ address: string; symbol: string }>
  }
  issues?: {
    allowance?: {
      spender?: string
      actual?: string
    } | null
    balance?: unknown
    simulationIncomplete?: boolean
    invalidSourcesPassed?: string[]
  }
  transaction: {
    to: string
    data: `0x${string}`
    gas?: string
    gasPrice?: string
    value?: string
  }
}

function pow10BigInt(n: number): bigint {
  let result = BigInt(1)
  const ten = BigInt(10)
  for (let i = 0; i < n; i += 1) {
    result *= ten
  }
  return result
}

function pickAssetTargets(weightedEthPercent: number): Map<string, number> {
  const config = getTreasuryConfig()
  const weights = new Map<string, number>()
  const ethAsset = config.assets.find((asset) => asset.symbol.toUpperCase() === 'ETH' || asset.id.toLowerCase() === 'eth')
  const usdcAsset = config.assets.find((asset) => asset.symbol.toUpperCase() === 'USDC' || asset.id.toLowerCase() === 'usdc')

  const ethPercent = Math.max(0, Math.min(100, Number.isFinite(weightedEthPercent) ? weightedEthPercent : 50))
  const remaining = Math.max(0, 100 - ethPercent)

  if (ethAsset) {
    weights.set(ethAsset.id, ethPercent)
  }
  if (usdcAsset) {
    weights.set(usdcAsset.id, remaining)
  }

  // For any remaining assets, distribute remaining proportionally (currently zero)
  for (const asset of config.assets) {
    if (!weights.has(asset.id)) {
      weights.set(asset.id, 0)
    }
  }

  return weights
}

function calculateUsdRaw(balanceWei: bigint, assetDecimals: number, priceRaw: bigint): bigint {
  const unit = pow10BigInt(assetDecimals)
  if (unit === BigInt(0)) return BigInt(0)
  return (balanceWei * priceRaw) / unit
}

function convertUsdRawToWei(usdRaw: bigint, priceRaw: bigint, assetDecimals: number): bigint {
  if (priceRaw === BigInt(0)) return BigInt(0)
  const unit = pow10BigInt(assetDecimals)
  return (usdRaw * unit) / priceRaw
}

async function ensureAllowance(
  tokenAddress: Address,
  owner: Address,
  spender: Address,
  requiredAmount: bigint,
  publicClient: any,
  walletClient: any,
  heartbeat?: HeartbeatFn
) {
  const currentAllowance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  }) as bigint

  if (currentAllowance >= requiredAmount) {
    return
  }

  await heartbeat?.()

  // Use the account from walletClient (same as swap route)
  const txHash = await walletClient.writeContract({
    account: walletClient.account, // Use walletClient's account, not the owner address
    chain: base,
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, requiredAmount],
  })

  await publicClient.waitForTransactionReceipt({ hash: txHash })
}

function clampSlippage(): string {
  const bps = Number.isFinite(REBALANCE_SLIPPAGE_BPS) ? Math.max(1, Math.min(500, REBALANCE_SLIPPAGE_BPS)) : 50
  const percentage = bps / 10_000
  return percentage.toString()
}

function computeTolerance(totalUsdRaw: bigint, priceDecimals: number): bigint {
  const percentScaled = BigInt(Math.round((Number.isFinite(REBALANCE_TOLERANCE_PERCENT) ? REBALANCE_TOLERANCE_PERCENT : 1) * Number(PERCENT_SCALE)))
  const toleranceFromPercent = (totalUsdRaw * percentScaled) / (BigInt(100) * PERCENT_SCALE)
  const usdScale = pow10BigInt(priceDecimals)
  const minUsdRaw = BigInt(Math.round((Number.isFinite(REBALANCE_MIN_USD_DELTA) ? REBALANCE_MIN_USD_DELTA : 5) * Number(usdScale)))
  return toleranceFromPercent > minUsdRaw ? toleranceFromPercent : minUsdRaw
}

function summarizeOutcome(outcome: RebalanceOutcome) {
  const key = 'rebalance:last'
  const historyKey = 'rebalance:history'
  void redis
    .multi()
    .set(key, JSON.stringify(outcome))
    .lpush(historyKey, JSON.stringify(outcome))
    .ltrim(historyKey, 0, REBALANCE_HISTORY_LIMIT - 1)
    .exec()
    .catch((error) => {
      console.warn('[rebalance] Failed to store outcome', error)
    })
}

export async function processRebalanceJob(
  job: Job<RebalanceJobPayload>,
  options: { heartbeat?: HeartbeatFn } = {}
): Promise<RebalanceOutcome> {
  const { reason } = job.payload
  console.log('[rebalance] Starting rebalance job', { jobId: job.id, reason })
  
  const config = getTreasuryConfig()
  const { totals } = await getAllocationVoteResults(VOTE_PROPOSAL_ID)
  console.log('[rebalance] Consensus totals', { weightedEthPercent: totals.weightedEthPercent, totalWeight: totals.totalWeight })
  
  const targetWeights = pickAssetTargets(totals.weightedEthPercent)
  console.log('[rebalance] Target weights', Object.fromEntries(targetWeights.entries()))

  const treasuryState = await fetchTreasuryState()
  console.log('[rebalance] Treasury state', {
    balances: treasuryState.balances.map(b => ({
      asset: b.asset.id,
      balanceWei: b.balance.toString(),
      decimals: b.asset.decimals
    }))
  })
  
  const priceSnapshots = await getPricesForAssets(config.assets.map((asset) => asset.id))
  console.log('[rebalance] Price snapshots', Array.from(priceSnapshots.entries()).map(([id, snap]) => ({
    assetId: id,
    priceUsd: snap.priceUsd,
    rawPrice: snap.rawPrice
  })))

  if (priceSnapshots.size === 0) {
    throw new Error('Price snapshots unavailable. Configure price feeds before rebalancing.')
  }

  const priceDecimalsSet = new Set<number>()
  priceSnapshots.forEach((snapshot) => {
    priceDecimalsSet.add(snapshot.priceDecimals)
  })

  if (priceDecimalsSet.size > 1) {
    throw new Error('Mismatched price feed decimals across assets. Unsupported configuration.')
  }

  const iterator = priceDecimalsSet.values()
  const first = iterator.next()
  const priceDecimals = first.done ? 0 : (first.value as number)
  const assetStates = treasuryState.balances.map((entry) => {
    const snapshot = priceSnapshots.get(entry.asset.id)
    if (!snapshot) {
      throw new Error(`Missing price snapshot for asset ${entry.asset.id}`)
    }
    const priceRaw = BigInt(snapshot.rawPrice)
    const currentUsdRaw = calculateUsdRaw(entry.balance, entry.asset.decimals, priceRaw)
    const currentUsd = Number(currentUsdRaw) / Number(10 ** priceDecimals)
    return {
      asset: entry.asset,
      balanceWei: entry.balance,
      priceRaw,
      priceDecimals: snapshot.priceDecimals,
      currentUsdRaw,
      currentUsd,
    }
  })

  const totalUsdRaw = assetStates.reduce((acc, item) => acc + item.currentUsdRaw, BigInt(0))
  const totalsNumber = assetStates.reduce((acc, item) => acc + item.currentUsd, 0)
  
  console.log('[rebalance] Asset states calculated', assetStates.map(state => ({
    asset: state.asset.id,
    symbol: state.asset.symbol,
    balanceWei: state.balanceWei.toString(),
    currentUsd: state.currentUsd.toFixed(2),
    currentUsdRaw: state.currentUsdRaw.toString()
  })))
  console.log('[rebalance] Total USD', { totalUsdRaw: totalUsdRaw.toString(), totalUsd: totalsNumber.toFixed(2) })

  if (totalUsdRaw === BigInt(0)) {
    console.log('[rebalance] Skipping: zero balance')
    const outcome: RebalanceOutcome = {
      jobId: job.id,
      reason,
      mode: 'skipped',
      timestamp: Date.now(),
      totals: {
        totalUsdRaw: totalUsdRaw.toString(),
        totalUsd: 0,
        priceDecimals,
        targetPercents: Object.fromEntries(targetWeights.entries()),
      },
      message: 'Treasury has zero balance. Skipping rebalance.',
      actions: [],
    }
    summarizeOutcome(outcome)
    return outcome
  }

  const toleranceUsdRaw = computeTolerance(totalUsdRaw, priceDecimals)
  const toleranceUsd = Number(toleranceUsdRaw) / Number(10 ** priceDecimals)
  console.log('[rebalance] Tolerance', { toleranceUsdRaw: toleranceUsdRaw.toString(), toleranceUsd: toleranceUsd.toFixed(2) })

  const targetEntries = assetStates.map((state) => {
    const percent = targetWeights.get(state.asset.id) ?? 0
    const percentScaled = BigInt(Math.round(percent * Number(PERCENT_SCALE)))
    let targetUsdRaw = (totalUsdRaw * percentScaled) / (BigInt(100) * PERCENT_SCALE)
    return {
      ...state,
      targetPercent: percent,
      percentScaled,
      targetUsdRaw,
    }
  })
  
  console.log('[rebalance] Target entries', targetEntries.map(entry => ({
    asset: entry.asset.id,
    symbol: entry.asset.symbol,
    targetPercent: entry.targetPercent.toFixed(1),
    targetUsdRaw: entry.targetUsdRaw.toString(),
    targetUsd: (Number(entry.targetUsdRaw) / Number(10 ** priceDecimals)).toFixed(2),
    currentUsd: entry.currentUsd.toFixed(2)
  })))

  const sumTargets = targetEntries.reduce((acc, entry) => acc + entry.targetUsdRaw, BigInt(0))
  const remainder = totalUsdRaw - sumTargets
  if (remainder !== BigInt(0) && targetEntries.length > 0) {
    targetEntries[0].targetUsdRaw += remainder
  }

  const enriched = targetEntries.map((entry) => {
    const deltaUsdRaw = entry.currentUsdRaw - entry.targetUsdRaw
    const absDeltaUsdRaw = deltaUsdRaw >= BigInt(0) ? deltaUsdRaw : -deltaUsdRaw
    const deltaUsd = Number(absDeltaUsdRaw) / Number(10 ** entry.priceDecimals)
    return {
      ...entry,
      deltaUsdRaw,
      absDeltaUsdRaw,
      deltaUsd,
    }
  })
  
  console.log('[rebalance] Enriched entries (deltas)', enriched.map(entry => ({
    asset: entry.asset.id,
    symbol: entry.asset.symbol,
    currentUsd: entry.currentUsd.toFixed(2),
    targetUsd: (Number(entry.targetUsdRaw) / Number(10 ** priceDecimals)).toFixed(2),
    deltaUsd: entry.deltaUsd.toFixed(2),
    deltaUsdRaw: entry.deltaUsdRaw.toString(),
    absDeltaUsdRaw: entry.absDeltaUsdRaw.toString()
  })))

  const overweight = enriched.filter((entry) => entry.deltaUsdRaw > toleranceUsdRaw)
  const underweight = enriched.filter((entry) => entry.deltaUsdRaw < -toleranceUsdRaw)
  
  console.log('[rebalance] Overweight assets', overweight.map(e => ({ asset: e.asset.id, symbol: e.asset.symbol, deltaUsd: e.deltaUsd.toFixed(2) })))
  console.log('[rebalance] Underweight assets', underweight.map(e => ({ asset: e.asset.id, symbol: e.asset.symbol, deltaUsd: e.deltaUsd.toFixed(2) })))

  if (overweight.length === 0 || underweight.length === 0) {
    console.log('[rebalance] Skipping: within tolerance', { overweightCount: overweight.length, underweightCount: underweight.length })
    const outcome: RebalanceOutcome = {
      jobId: job.id,
      reason,
      mode: 'skipped',
      timestamp: Date.now(),
      totals: {
        totalUsdRaw: totalUsdRaw.toString(),
        totalUsd: totalsNumber,
        priceDecimals,
        targetPercents: Object.fromEntries(targetWeights.entries()),
      },
      message: 'Allocation within tolerance. No rebalance required.',
      actions: [],
    }
    summarizeOutcome(outcome)
    return outcome
  }

  const seller = overweight[0]
  const buyer = underweight[0]
  
  console.log('[rebalance] Selected swap pair', {
    seller: { asset: seller.asset.id, symbol: seller.asset.symbol, currentUsd: seller.currentUsd.toFixed(2), targetUsd: (Number(seller.targetUsdRaw) / Number(10 ** priceDecimals)).toFixed(2), deltaUsd: seller.deltaUsd.toFixed(2) },
    buyer: { asset: buyer.asset.id, symbol: buyer.asset.symbol, currentUsd: buyer.currentUsd.toFixed(2), targetUsd: (Number(buyer.targetUsdRaw) / Number(10 ** priceDecimals)).toFixed(2), deltaUsd: buyer.deltaUsd.toFixed(2) }
  })
  
  // Iterative approach: use actual quotes to account for slippage/price impact
  // Start with the delta we need to swap
  let usdRawToSwap = seller.absDeltaUsdRaw < buyer.absDeltaUsdRaw ? seller.absDeltaUsdRaw : buyer.absDeltaUsdRaw
  let sellAmountWei = convertUsdRawToWei(usdRawToSwap, seller.priceRaw, seller.asset.decimals)
  let finalSellAmountWei = sellAmountWei
  let finalBuyAmountWei = BigInt(0)
  const maxIterations = 3 // Limit iterations to avoid infinite loops
  
  console.log('[rebalance] Initial swap calculation', {
    usdRawToSwap: usdRawToSwap.toString(),
    usdToSwap: (Number(usdRawToSwap) / Number(10 ** priceDecimals)).toFixed(2),
    sellAmountWei: sellAmountWei.toString(),
    sellerBalanceWei: seller.balanceWei.toString()
  })
  
  if (sellAmountWei === BigInt(0)) {
    console.log('[rebalance] Skipping: sell amount is zero')
    const outcome: RebalanceOutcome = {
      jobId: job.id,
      reason,
      mode: 'skipped',
      timestamp: Date.now(),
      totals: {
        totalUsdRaw: totalUsdRaw.toString(),
        totalUsd: totalsNumber,
        priceDecimals,
        targetPercents: Object.fromEntries(targetWeights.entries()),
      },
      message: 'Calculated swap amount rounded to zero. Skipping execution.',
      actions: [],
    }
    summarizeOutcome(outcome)
    return outcome
  }

  // Prepare for quote fetching (need clients first)
  const privateKey = getTreasuryPrivateKey()
  if (!privateKey) {
    throw new Error('Treasury private key is required to execute rebalances.')
  }

  const account = privateKeyToAccount(privateKey)
  const baseRpcUrl = process.env.BASE_RPC_URL
  if (!baseRpcUrl) {
    throw new Error('BASE_RPC_URL must be configured for rebalancing.')
  }

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(baseRpcUrl),
  })
  const publicClient = createPublicClient({
    chain: base,
    transport: http(baseRpcUrl),
  })

  // Use native token address for native ETH (per 0x API documentation)
  // When selling native ETH, use 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
  // When buying native ETH, use 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
  // The 0x API handles wrapping/unwrapping automatically
  const sellToken = seller.asset.type === 'native' 
    ? NATIVE_TOKEN_ADDRESS 
    : getAddress(seller.asset.address!)
  const buyToken = buyer.asset.type === 'native'
    ? NATIVE_TOKEN_ADDRESS
    : getAddress(buyer.asset.address!)

  // Prepare headers for quote requests (same as swap route)
  const headers: Record<string, string> = {
    accept: 'application/json',
    '0x-version': 'v2',
  }
  if (ZEROX_API_KEY) {
    headers['0x-api-key'] = ZEROX_API_KEY
  }

  // Iterative refinement: get quotes and adjust until balanced
  console.log('[rebalance] Starting iterative refinement (max iterations:', maxIterations, ')')
  console.log('[rebalance] Token addresses', { sellToken, buyToken, sellAssetType: seller.asset.type })
  
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    console.log(`[rebalance] Iteration ${iteration + 1}/${maxIterations}`, {
      sellAmountWei: sellAmountWei.toString(),
      sellAmountHuman: (Number(sellAmountWei) / Number(10 ** seller.asset.decimals)).toFixed(6)
    })
    const params = new URLSearchParams({
      sellToken: sellToken,
      buyToken: buyToken,
      sellAmount: sellAmountWei.toString(),
      taker: account.address,
    })
    params.set('chainId', base.id.toString())

    // Use same endpoint as working swap route
    const quoteResponse = await fetch(`${ZEROX_BASE_URL}/swap/allowance-holder/quote?${params.toString()}`, {
      headers,
    })

    if (!quoteResponse.ok) {
      const text = await quoteResponse.text()
      throw new Error(`0x quote request failed: ${quoteResponse.status} ${text}`)
    }

    const quote = (await quoteResponse.json()) as QuoteResponseV2
    const actualBuyAmountWei = BigInt(quote.buyAmount)
    
    console.log(`[rebalance] Iteration ${iteration + 1} quote received`, {
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      buyAmountHuman: (Number(actualBuyAmountWei) / Number(10 ** buyer.asset.decimals)).toFixed(6)
    })
    
    // Calculate what the final USD values would be after this swap
    const sellAmountAfterSwap = seller.balanceWei - sellAmountWei
    const buyAmountAfterSwap = buyer.balanceWei + actualBuyAmountWei
    
    const sellUsdAfterSwap = calculateUsdRaw(sellAmountAfterSwap, seller.asset.decimals, seller.priceRaw)
    const buyUsdAfterSwap = calculateUsdRaw(buyAmountAfterSwap, buyer.asset.decimals, buyer.priceRaw)
    
    // Check if we're balanced now (within tolerance)
    const sellTargetUsdRaw = targetEntries.find(e => e.asset.id === seller.asset.id)!.targetUsdRaw
    const buyTargetUsdRaw = targetEntries.find(e => e.asset.id === buyer.asset.id)!.targetUsdRaw
    
    const sellDeltaAfterSwap = sellUsdAfterSwap > sellTargetUsdRaw 
      ? sellUsdAfterSwap - sellTargetUsdRaw 
      : sellTargetUsdRaw - sellUsdAfterSwap
    const buyDeltaAfterSwap = buyUsdAfterSwap > buyTargetUsdRaw 
      ? buyUsdAfterSwap - buyTargetUsdRaw 
      : buyTargetUsdRaw - buyUsdAfterSwap
    
    console.log(`[rebalance] Iteration ${iteration + 1} projected final state`, {
      sellUsdAfterSwap: (Number(sellUsdAfterSwap) / Number(10 ** priceDecimals)).toFixed(2),
      sellTargetUsd: (Number(sellTargetUsdRaw) / Number(10 ** priceDecimals)).toFixed(2),
      sellDeltaAfterSwap: (Number(sellDeltaAfterSwap) / Number(10 ** priceDecimals)).toFixed(2),
      buyUsdAfterSwap: (Number(buyUsdAfterSwap) / Number(10 ** priceDecimals)).toFixed(2),
      buyTargetUsd: (Number(buyTargetUsdRaw) / Number(10 ** priceDecimals)).toFixed(2),
      buyDeltaAfterSwap: (Number(buyDeltaAfterSwap) / Number(10 ** priceDecimals)).toFixed(2),
      toleranceUsd: toleranceUsd.toFixed(2),
      withinTolerance: sellDeltaAfterSwap <= toleranceUsdRaw && buyDeltaAfterSwap <= toleranceUsdRaw
    })
    
    // If both are within tolerance, we're done
    if (sellDeltaAfterSwap <= toleranceUsdRaw && buyDeltaAfterSwap <= toleranceUsdRaw) {
      console.log(`[rebalance] Iteration ${iteration + 1}: Balanced! Stopping.`)
      finalSellAmountWei = sellAmountWei
      finalBuyAmountWei = actualBuyAmountWei
      break
    }
    
    // Otherwise, adjust the sell amount for next iteration
    // Calculate how much more/less USD we need to swap
    const avgDelta = (sellDeltaAfterSwap + buyDeltaAfterSwap) / BigInt(2)
    const adjustmentNeeded = avgDelta
    
    // If seller is still overweight, we need to swap more
    // If seller is now underweight, we need to swap less
    if (sellUsdAfterSwap > sellTargetUsdRaw) {
      // Still overweight, swap more
      const additionalSellWei = convertUsdRawToWei(adjustmentNeeded, seller.priceRaw, seller.asset.decimals)
      sellAmountWei = sellAmountWei + additionalSellWei
    } else {
      // Now underweight, swap less (but we can't undo, so use current)
      finalSellAmountWei = sellAmountWei
      finalBuyAmountWei = actualBuyAmountWei
      break
    }
    
    // Store final values for this iteration
    finalSellAmountWei = sellAmountWei
    finalBuyAmountWei = actualBuyAmountWei
    
    // Small safety check: don't swap more than we have
    if (sellAmountWei > seller.balanceWei) {
      sellAmountWei = seller.balanceWei
      finalSellAmountWei = sellAmountWei
      break
    }
  }

  console.log('[rebalance] Iterative refinement complete', {
    finalSellAmountWei: finalSellAmountWei.toString(),
    finalBuyAmountWei: finalBuyAmountWei.toString(),
    iterationsUsed: 'completed or max reached'
  })
  
  // Use the actual buyAmount from the last quote (accounts for slippage)
  // Get one more quote to ensure we have the latest
  const finalParams = new URLSearchParams({
    sellToken: sellToken,
    buyToken: buyToken,
    sellAmount: finalSellAmountWei.toString(),
    taker: account.address,
  })
  finalParams.set('chainId', base.id.toString())

  // Use same endpoint as working swap route
  const finalQuoteResponse = await fetch(`${ZEROX_BASE_URL}/swap/allowance-holder/quote?${finalParams.toString()}`, {
    headers,
  })

  if (!finalQuoteResponse.ok) {
    const text = await finalQuoteResponse.text()
    throw new Error(`0x final quote request failed: ${finalQuoteResponse.status} ${text}`)
  }

  const finalQuote = (await finalQuoteResponse.json()) as QuoteResponseV2
  finalBuyAmountWei = BigInt(finalQuote.buyAmount) // Use actual buyAmount from quote
  
  console.log('[rebalance] Final quote received', {
    sellAmount: finalQuote.sellAmount,
    buyAmount: finalQuote.buyAmount,
    transactionValue: finalQuote.transaction?.value || '0',
    transactionTo: finalQuote.transaction?.to,
    hasTransaction: !!finalQuote.transaction
  })
  
  // Recalculate USD delta for the final swap using actual quote values
  const finalSellUsdRaw = calculateUsdRaw(finalSellAmountWei, seller.asset.decimals, seller.priceRaw)
  const finalBuyUsdRaw = calculateUsdRaw(finalBuyAmountWei, buyer.asset.decimals, buyer.priceRaw)
  const finalUsdRawToSwap = (finalSellUsdRaw + finalBuyUsdRaw) / BigInt(2) // Average for reporting

  const actionPlan: RebalanceActionPlan = {
    sellAssetId: seller.asset.id,
    sellAssetSymbol: seller.asset.symbol,
    buyAssetId: buyer.asset.id,
    buyAssetSymbol: buyer.asset.symbol,
    sellAmountWei: finalSellAmountWei.toString(),
    buyAmountWei: finalBuyAmountWei.toString(),
    deltaUsdRaw: finalUsdRawToSwap.toString(),
    priceDecimals,
  }

  if (!EXECUTE_REBALANCE) {
    console.log('[rebalance] Dry-run mode: execution disabled')
    const outcome: RebalanceOutcome = {
      jobId: job.id,
      reason,
      mode: 'dry-run',
      timestamp: Date.now(),
      totals: {
        totalUsdRaw: totalUsdRaw.toString(),
        totalUsd: totalsNumber,
        priceDecimals,
        targetPercents: Object.fromEntries(targetWeights.entries()),
      },
      message: 'Rebalance execution disabled (REBALANCE_EXECUTE not set).',
      actions: [actionPlan],
    }
    summarizeOutcome(outcome)
    return outcome
  }
  
  console.log('[rebalance] Executing swap', {
    sellAsset: seller.asset.symbol,
    buyAsset: buyer.asset.symbol,
    sellAmountWei: finalSellAmountWei.toString(),
    buyAmountWei: finalBuyAmountWei.toString()
  })

  await options.heartbeat?.()

  // Use the final quote we already fetched
  const quote = finalQuote

  await options.heartbeat?.()

  const allowanceSpender =
    quote.issues?.allowance?.spender

  if (seller.asset.type === 'erc20' && seller.asset.address && allowanceSpender) {
    await ensureAllowance(
      getAddress(seller.asset.address), // Use getAddress for checksumming
      account.address,
      getAddress(allowanceSpender), // Use getAddress for checksumming
      BigInt(quote.sellAmount),
      publicClient,
      walletClient,
      options.heartbeat
    )
  }

  await options.heartbeat?.()

  // When selling native ETH, we MUST include ETH value in the transaction
  // The quote may return value: '0', but we need to send ETH to wrap to WETH
  let txValue = BigInt(quote.transaction.value ?? '0')
  if (seller.asset.type === 'native') {
    // For native ETH swaps, the transaction value MUST be the sell amount
    // This ETH will be wrapped to WETH as part of the swap
    txValue = finalSellAmountWei
    console.log('[rebalance] Selling native ETH - setting transaction value to sell amount', {
      txValue: txValue.toString(),
      sellAmountWei: finalSellAmountWei.toString(),
      quoteValue: quote.transaction.value,
      note: 'ETH must be sent to wrap to WETH for the swap'
    })
  }

  console.log('[rebalance] Transaction details', {
    to: quote.transaction.to,
    value: txValue.toString(),
    valueEth: seller.asset.type === 'native' ? (Number(txValue) / Number(10 ** seller.asset.decimals)).toFixed(6) : '0',
    dataLength: quote.transaction.data.length,
    gas: quote.transaction.gas,
    gasPrice: quote.transaction.gasPrice
  })

  const txHash = await walletClient.sendTransaction({
    account,
    chain: base,
    to: getAddress(quote.transaction.to), // Use getAddress for checksumming
    data: quote.transaction.data,
    value: txValue,
    gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
    gasPrice: quote.transaction.gasPrice ? BigInt(quote.transaction.gasPrice) : undefined,
  })

  console.log('[rebalance] Transaction sent', { txHash })
  await publicClient.waitForTransactionReceipt({ hash: txHash })
  console.log('[rebalance] Transaction confirmed')

  // Refresh treasury state after swap to get actual final balances
  await options.heartbeat?.()
  console.log('[rebalance] Fetching final treasury state after swap...')
  const finalTreasuryState = await fetchTreasuryState()
  console.log('[rebalance] Final treasury balances', {
    balances: finalTreasuryState.balances.map(b => ({
      asset: b.asset.id,
      balanceWei: b.balance.toString(),
      decimals: b.asset.decimals
    }))
  })
  
  const finalPriceSnapshots = await getPricesForAssets(config.assets.map((asset) => asset.id))
  
  // Recalculate final USD values with actual balances
  const finalAssetStates = finalTreasuryState.balances.map((entry) => {
    const snapshot = finalPriceSnapshots.get(entry.asset.id)
    if (!snapshot) {
      throw new Error(`Missing price snapshot for asset ${entry.asset.id}`)
    }
    const priceRaw = BigInt(snapshot.rawPrice)
    const currentUsdRaw = calculateUsdRaw(entry.balance, entry.asset.decimals, priceRaw)
    const currentUsd = Number(currentUsdRaw) / Number(10 ** priceDecimals)
    return {
      asset: entry.asset,
      balanceWei: entry.balance,
      priceRaw,
      priceDecimals: snapshot.priceDecimals,
      currentUsdRaw,
      currentUsd,
    }
  })

  const finalTotalUsdRaw = finalAssetStates.reduce((acc, item) => acc + item.currentUsdRaw, BigInt(0))
  const finalTotalsNumber = finalAssetStates.reduce((acc, item) => acc + item.currentUsd, 0)
  
  console.log('[rebalance] Final asset states', finalAssetStates.map(state => ({
    asset: state.asset.id,
    symbol: state.asset.symbol,
    balanceWei: state.balanceWei.toString(),
    currentUsd: state.currentUsd.toFixed(2),
    targetPercent: targetWeights.get(state.asset.id)?.toFixed(1) || '0'
  })))
  console.log('[rebalance] Final total USD', { totalUsdRaw: finalTotalUsdRaw.toString(), totalUsd: finalTotalsNumber.toFixed(2) })

  const actionResult: RebalanceActionResult = {
    ...actionPlan,
    txHash,
    quote: {
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      allowanceTarget: allowanceSpender,
      estimatedGas: quote.transaction.gas,
      sources: quote.route?.fills?.map((f) => ({ name: f.source, proportion: (Number(f.proportionBps) / 10000).toString() })),
    },
  }

  const outcome: RebalanceOutcome = {
    jobId: job.id,
    reason,
    mode: 'executed',
    timestamp: Date.now(),
    totals: {
      totalUsdRaw: finalTotalUsdRaw.toString(), // Use final balances
      totalUsd: finalTotalsNumber, // Use final balances
      priceDecimals,
      targetPercents: Object.fromEntries(targetWeights.entries()),
    },
    message: 'Rebalance executed successfully.',
    actions: [actionResult],
  }

  console.log('[rebalance] Rebalance complete', {
    mode: outcome.mode,
    message: outcome.message,
    totalUsd: outcome.totals.totalUsd.toFixed(2),
    actions: outcome.actions.length
  })
  
  summarizeOutcome(outcome)
  return outcome
}


