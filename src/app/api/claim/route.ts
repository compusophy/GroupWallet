import { randomUUID } from 'node:crypto'

import { NextResponse } from 'next/server'
import { Address, Signature, formatUnits, getAddress, isAddress, verifyMessage } from 'viem'

import { CLAIM_MESSAGE_EXPIRY_MS, createClaimMessage } from '@/lib/claim'
import { enqueueSettlement, type SettlementAssetPlan, type SettlementStatus } from '@/lib/settlement'
import { getAllUserStats } from '@/lib/redis'
import { fetchTreasuryState } from '@/lib/treasury-state'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      address?: string
      signature?: string
      timestamp?: number
    } | null

    if (!body) {
      return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const { address, signature, timestamp } = body

    if (!address || !isAddress(address)) {
      return NextResponse.json({ ok: false, error: 'A valid address is required.' }, { status: 400 })
    }

    if (!signature || typeof signature !== 'string') {
      return NextResponse.json({ ok: false, error: 'A signature is required.' }, { status: 400 })
    }

    if (!Number.isFinite(timestamp) || typeof timestamp !== 'number') {
      return NextResponse.json({ ok: false, error: 'A valid timestamp is required.' }, { status: 400 })
    }

    const now = Date.now()
    if (Math.abs(now - timestamp) > CLAIM_MESSAGE_EXPIRY_MS) {
      return NextResponse.json({ ok: false, error: 'Claim signature is no longer valid.' }, { status: 400 })
    }

    const expectedMessage = createClaimMessage({
      address: address as `0x${string}`,
      timestamp,
    })

    const isValidSignature = await verifyMessage({
      address: address as Address,
      message: expectedMessage,
      signature: signature as unknown as Signature,
    })

    if (!isValidSignature) {
      return NextResponse.json({ ok: false, error: 'Signature verification failed.' }, { status: 401 })
    }

    // Compute user share from validated deposits
    const userStats = await getAllUserStats()
    const totalDepositsWei = userStats.reduce((acc, stat) => {
      try {
        return acc + BigInt(stat.totalValueWei)
      } catch {
        return acc
      }
    }, BigInt(0))

    if (totalDepositsWei === BigInt(0)) {
      return NextResponse.json(
        { ok: false, error: 'No validated deposits found. Nothing to claim.' },
        { status: 400 },
      )
    }

    const claimant = userStats.find((s) => s.address === address.toLowerCase())
    const claimantWei = claimant ? BigInt(claimant.totalValueWei) : BigInt(0)

    if (claimantWei === BigInt(0)) {
      return NextResponse.json(
        { ok: false, error: 'You have no validated deposits. Nothing to claim.' },
        { status: 403 },
      )
    }

    const share = Number(claimantWei) / Number(totalDepositsWei)

    const treasuryState = await fetchTreasuryState()
    const plan: SettlementAssetPlan[] = treasuryState.balances.map(({ asset, balance }) => {
      const userAmountWei = (balance * claimantWei) / totalDepositsWei
      return {
        assetId: asset.id,
        symbol: asset.symbol,
        type: asset.type,
        tokenAddress: asset.address ?? null,
        decimals: asset.decimals,
        amountWei: userAmountWei.toString(),
        amountFormatted: formatUnits(userAmountWei, asset.decimals),
      }
    })

    const requestId = randomUUID()
    const checksumAddress = getAddress(address)
    const { status, queued } = await enqueueSettlement({
      address: checksumAddress,
      share,
      plan,
      totalDepositsWei: totalDepositsWei.toString(),
      requestId,
      requestedAt: Date.now(),
    })

    const modeMap: Record<SettlementStatus['state'], string> = {
      'queued': 'queued',
      'executing': 'pending',
      'executed': 'executed',
      'dry-run': 'dry-run',
      'failed': 'failed',
    }

    return NextResponse.json({
      ok: true,
      mode: modeMap[status.state] ?? 'queued',
      share,
      plan,
      settlement: status,
      queued,
      transactions: status.transactions ?? [],
    })
  } catch (error) {
    console.error('Failed to process claim:', error)
    return NextResponse.json({ ok: false, error: 'Failed to process claim' }, { status: 500 })
  }
}


