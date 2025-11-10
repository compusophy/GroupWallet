import { randomUUID } from 'node:crypto'

import { NextResponse } from 'next/server'
import { Address, Signature, formatUnits, getAddress, isAddress, verifyMessage } from 'viem'

import { CLAIM_MESSAGE_EXPIRY_MS, createClaimMessage } from '@/lib/claim'
import { enqueueSettlement, processSettlementJob, type SettlementAssetPlan, type SettlementStatus, type SettlementJobPayload } from '@/lib/settlement'
import { getAllUserStats } from '@/lib/redis'
import { fetchTreasuryState } from '@/lib/treasury-state'
import { acquireOperationLock } from '@/lib/locks'

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

    // Acquire lock to prevent concurrent settlement operations
    // Use address-specific lock since each user can only have one settlement at a time
    const lock = await acquireOperationLock('settlement', address)
    if (!lock.acquired) {
      return NextResponse.json(
        { ok: false, error: 'A settlement operation is already in progress for this address. Please wait for it to complete.' },
        { status: 429 },
      )
    }

    try {
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
      
      console.log('[claim] Enqueueing settlement', {
        address: checksumAddress,
        share,
        planItems: plan.length,
        requestId,
      })
      
      const { status, queued } = await enqueueSettlement({
        address: checksumAddress,
        share,
        plan,
        totalDepositsWei: totalDepositsWei.toString(),
        requestId,
        requestedAt: Date.now(),
      })

      console.log('[claim] Settlement enqueued', {
        queued,
        jobId: status.jobId,
        state: status.state,
      })

      // Process settlement job immediately after enqueueing (similar to rebalance)
      // Process if we have a jobId, regardless of whether it was newly queued or already existed
      let finalStatus = status
      if (status.jobId && status.state === 'queued') {
        console.log('[claim] Attempting to process settlement job immediately', {
          jobId: status.jobId,
          wasNewlyQueued: queued,
        })
        try {
          // Try to claim the specific settlement job by ID
          // This will skip non-matching jobs temporarily (move them to back of queue)
          const { claimJobById } = await import('@/lib/jobs')
          const claimed = await claimJobById<SettlementJobPayload>(status.jobId, 10)
          
          if (claimed && claimed.job.type === 'settlement' && claimed.job.id === status.jobId) {
            // Found our settlement job - process it
            console.log('[claim] Found matching settlement job, processing...')
            finalStatus = await processSettlementJob(claimed.job, { heartbeat: claimed.heartbeat })
            console.log('[claim] Settlement job processed', {
              finalState: finalStatus.state,
              transactionCount: finalStatus.transactions?.length ?? 0,
            })
            await claimed.ack()
          } else {
            console.log('[claim] Settlement job not found in queue (may be processed by worker)', {
              jobId: status.jobId,
            })
            // Job will be processed by worker - return queued status
          }
        } catch (error) {
          console.error('[claim] Failed to process settlement job immediately', {
            error: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          })
          // Continue with queued status - job will be processed by worker
        }
      } else {
        console.log('[claim] Settlement not processed', {
          hasJobId: !!status.jobId,
          state: status.state,
          reason: !status.jobId ? 'no jobId' : status.state !== 'queued' ? `state is ${status.state}` : 'unknown',
        })
      }

      const modeMap: Record<SettlementStatus['state'], string> = {
        'queued': 'queued',
        'executing': 'pending',
        'executed': 'executed',
        'dry-run': 'dry-run',
        'failed': 'failed',
      }

      return NextResponse.json({
        ok: true,
        mode: modeMap[finalStatus.state] ?? 'queued',
        share,
        plan,
        settlement: finalStatus,
        queued,
        transactions: finalStatus.transactions ?? [],
      })
    } finally {
      await lock.release()
    }
  } catch (error) {
    console.error('Failed to process claim:', error)
    return NextResponse.json({ ok: false, error: 'Failed to process claim' }, { status: 500 })
  }
}


