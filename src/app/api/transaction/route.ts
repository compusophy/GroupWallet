import { NextResponse } from 'next/server'
import { base } from 'wagmi/chains'
import { createPublicClient, http, type Hash, parseEther, formatEther, isAddress } from 'viem'

import { recordSuccessfulTransaction } from '@/lib/redis'
import { getTreasuryAddress } from '@/lib/treasury'

const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org'
const DEFAULT_SEND_AMOUNT_ETH = '0.0001'
const DEFAULT_CONFIRMATIONS = 1
const BIGINT_ZERO = BigInt(0)
const BIGINT_ONE = BigInt(1)

const baseRpcUrl = process.env.BASE_RPC_URL ?? DEFAULT_BASE_RPC_URL
const requiredAmountEth = process.env.NEXT_PUBLIC_SEND_AMOUNT_ETH ?? DEFAULT_SEND_AMOUNT_ETH
const requiredAmountWei = parseEther(requiredAmountEth)
const parsedConfirmations = Number(
  process.env.NEXT_PUBLIC_SEND_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS
)
const requiredConfirmations = Number.isFinite(parsedConfirmations) && parsedConfirmations > 0
  ? Math.round(parsedConfirmations)
  : DEFAULT_CONFIRMATIONS
const targetRecipient = (() => {
  const fromEnv = process.env.NEXT_PUBLIC_TARGET_RECIPIENT ?? process.env.TARGET_RECIPIENT
  if (fromEnv && isAddress(fromEnv)) {
    return fromEnv
  }

  try {
    return getTreasuryAddress()
  } catch (error) {
    console.warn('Transaction validation will allow custom recipients. Reason:', error)
    return null
  }
})()

const publicClient = createPublicClient({
  chain: base,
  transport: http(baseRpcUrl),
})

function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { hash?: unknown } | null

    if (!body || !isHash(body.hash)) {
      return NextResponse.json(
        { ok: false, error: 'A valid transaction hash is required.' },
        { status: 400 }
      )
    }

    const hash = body.hash

    const receipt = await publicClient.getTransactionReceipt({ hash })

    if (receipt.status !== 'success') {
      return NextResponse.json(
        { ok: false, error: 'Transaction did not succeed.' },
        { status: 400 }
      )
    }

    let confirmationCount: number | null = null

    try {
      const latestBlockNumber = await publicClient.getBlockNumber()
      const receiptBlockNumber = receipt.blockNumber

      if (typeof receiptBlockNumber === 'bigint') {
        const diff = latestBlockNumber >= receiptBlockNumber
          ? latestBlockNumber - receiptBlockNumber + BIGINT_ONE
          : BIGINT_ZERO
        confirmationCount = Number(diff)
      }
    } catch (error) {
      console.warn('Unable to determine transaction confirmations', error)
    }

    if (confirmationCount !== null && confirmationCount < requiredConfirmations) {
      return NextResponse.json(
        {
          ok: false,
          error: `Transaction must have at least ${requiredConfirmations} confirmation(s).`,
        },
        { status: 400 }
      )
    }

    const transaction = await publicClient.getTransaction({ hash })

    if (!transaction) {
      return NextResponse.json(
        { ok: false, error: 'Unable to load transaction details.' },
        { status: 400 }
      )
    }

    // Validate chain ID - check transaction chainId or receipt chainId
    // Since we're querying from Base RPC, if chainId is missing, we trust it's Base
    const txChainIdRaw = (transaction as { chainId?: number | bigint | undefined }).chainId
    const receiptChainIdRaw = (receipt as { chainId?: number | bigint | undefined }).chainId
    
    // Convert to number for comparison (chainId can be number or BigInt)
    const txChainIdNum = txChainIdRaw !== undefined ? Number(txChainIdRaw) : undefined
    const receiptChainIdNum = receiptChainIdRaw !== undefined ? Number(receiptChainIdRaw) : undefined
    
    if (txChainIdNum !== undefined && txChainIdNum !== base.id) {
      console.error('Chain ID mismatch:', {
        expected: base.id,
        got: txChainIdNum,
        receiptChainId: receiptChainIdNum,
      })
      return NextResponse.json(
        { ok: false, error: `Transaction was sent on an unexpected chain (got ${txChainIdNum}, expected ${base.id}).` },
        { status: 400 }
      )
    }
    
    if (receiptChainIdNum !== undefined && receiptChainIdNum !== base.id) {
      console.error('Receipt chain ID mismatch:', {
        expected: base.id,
        got: receiptChainIdNum,
      })
      return NextResponse.json(
        { ok: false, error: `Transaction receipt is from an unexpected chain (got ${receiptChainIdNum}, expected ${base.id}).` },
        { status: 400 }
      )
    }

    if (transaction.value !== requiredAmountWei) {
      return NextResponse.json(
        { ok: false, error: `Transaction must send exactly ${requiredAmountEth} ETH.` },
        { status: 400 }
      )
    }

    if (targetRecipient) {
      if (!transaction.to || transaction.to.toLowerCase() !== targetRecipient.toLowerCase()) {
        return NextResponse.json(
          { ok: false, error: 'Transaction recipient does not match the expected address.' },
          { status: 400 }
        )
      }
    } else if (!transaction.to) {
      return NextResponse.json(
        { ok: false, error: 'Transaction recipient is missing.' },
        { status: 400 }
      )
    }

    console.log('Validated transaction:', {
      hash,
      from: transaction.from,
      to: transaction.to,
      value: transaction.value.toString(),
      confirmations: confirmationCount,
      txChainId: txChainIdRaw !== undefined ? txChainIdRaw.toString() : undefined,
      receiptChainId: receiptChainIdRaw !== undefined ? receiptChainIdRaw.toString() : undefined,
      expectedChainId: base.id,
    })

    // Record successful transaction in Redis
    try {
      // Fetch block to get timestamp
      const block = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      })

      const blockTimestamp = Number(block.timestamp) * 1000 // Convert to milliseconds

      await recordSuccessfulTransaction({
        hash,
        from: transaction.from,
        to: transaction.to ?? '',
        value: transaction.value.toString(),
        valueEth: formatEther(transaction.value),
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        timestamp: blockTimestamp,
        chainId: base.id,
        confirmations: confirmationCount ?? undefined,
      })

      console.log('Transaction recorded successfully:', hash)
    } catch (redisError) {
      // Log Redis errors but don't fail the API response
      // The transaction is still valid, we just couldn't record it
      console.error('Failed to record transaction in Redis:', redisError)
    }

    return NextResponse.json({ ok: true, hash })
  } catch (error) {
    console.error('Failed to handle transaction notification', error)
    return NextResponse.json(
      { ok: false, error: 'Failed to process transaction notification' },
      { status: 500 }
    )
  }
}
