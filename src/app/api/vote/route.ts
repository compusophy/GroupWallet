import { NextResponse } from 'next/server'
import { formatEther, isAddress, type Address, type Signature, verifyMessage } from 'viem'

import {
  getAllUserStats,
  recordAllocationVote,
  getAllocationVoteResults,
  getAllocationVoteRecord,
  resetAllocationVotes,
  resetLegacyVoteData,
  type AllocationVoteRecord,
} from '@/lib/redis'
import { enqueueRebalance } from '@/lib/rebalance'
import {
  calculateDepositWeight,
  createAllocationVoteMessage,
  VOTE_MESSAGE_EXPIRY_MS,
  VOTE_PROPOSAL_ID,
} from '@/lib/voting'

const BIGINT_ZERO = BigInt(0)

const shouldInitVotes = (process.env.VOTE_INIT ?? '').toLowerCase() === 'true'
let voteInitPromise: Promise<void> | null = null

async function ensureVotesInitialized() {
  if (!shouldInitVotes) {
    return
  }

  if (!voteInitPromise) {
    voteInitPromise = (async () => {
      try {
        await resetAllocationVotes(VOTE_PROPOSAL_ID)
        await resetLegacyVoteData(VOTE_PROPOSAL_ID)
        console.info('[vote] Allocation votes reset due to VOTE_INIT=true')
      } catch (error) {
        console.error('Failed to reset allocation votes during init', error)
      }
    })()
  }

  await voteInitPromise
}

export async function GET(request: Request) {
  try {
    await ensureVotesInitialized()
    const url = new URL(request.url)
    const addressParam = url.searchParams.get('address')

    const { totals, votes } = await getAllocationVoteResults(VOTE_PROPOSAL_ID)

    let userVote: AllocationVoteRecord | null = null
    let isEligible = false
    let depositValueWei = '0'
    let depositValueEth = '0'

    if (addressParam && isAddress(addressParam)) {
      const addressLower = addressParam.toLowerCase()
      userVote = await getAllocationVoteRecord(VOTE_PROPOSAL_ID, addressLower)

      // Check eligibility
      const userStats = await getAllUserStats()
      const voterRecord = userStats.find((stat) => stat.address === addressLower)
      
      if (voterRecord) {
        try {
          const depositWei = BigInt(voterRecord.totalValueWei)
          if (depositWei > BIGINT_ZERO) {
            isEligible = true
            depositValueWei = depositWei.toString()
            depositValueEth = formatEther(depositWei)
          }
        } catch {
          // Invalid deposit value
        }
      }
    }

    return NextResponse.json({ ok: true, proposalId: VOTE_PROPOSAL_ID, totals, votes, userVote, eligibility: { isEligible, depositValueWei, depositValueEth } })
  } catch (error) {
    console.error('Failed to load vote results', error)
    return NextResponse.json({ ok: false, error: 'Failed to load vote results' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureVotesInitialized()
    const url = new URL(request.url)
    const authHeader = request.headers.get('authorization')
    const bearerToken = authHeader?.match(/Bearer\s+(.+)/i)?.[1] ?? null
    const tokenParam = url.searchParams.get('token')
    const providedToken = bearerToken ?? tokenParam ?? null
    const requiredToken = process.env.VOTE_RESET_SECRET

    if (requiredToken) {
      if (!providedToken || providedToken !== requiredToken) {
        return NextResponse.json({ ok: false, error: 'Unauthorized vote reset request.' }, { status: 401 })
      }
    } else if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ ok: false, error: 'Vote reset disabled in production.' }, { status: 403 })
    }

    await resetAllocationVotes(VOTE_PROPOSAL_ID)
    return NextResponse.json({ ok: true, proposalId: VOTE_PROPOSAL_ID })
  } catch (error) {
    console.error('Failed to reset allocation votes', error)
    return NextResponse.json({ ok: false, error: 'Failed to reset votes.' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    await ensureVotesInitialized()
    const body = (await request.json().catch(() => null)) as {
      address?: string
      ethPercent?: number
      signature?: string
      timestamp?: number
    } | null

    if (!body) {
      return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const { address, ethPercent, signature, timestamp } = body

    if (!address || !isAddress(address)) {
      return NextResponse.json({ ok: false, error: 'A valid address is required.' }, { status: 400 })
    }

    // Validate ethPercent 0..100
    if (!Number.isFinite(ethPercent as number) || typeof ethPercent !== 'number') {
      return NextResponse.json({ ok: false, error: 'Invalid allocation percent.' }, { status: 400 })
    }
    const clampedPercent = Math.max(0, Math.min(100, Math.round(ethPercent)))

    if (!signature || typeof signature !== 'string') {
      return NextResponse.json({ ok: false, error: 'A signature is required.' }, { status: 400 })
    }

    if (!Number.isFinite(timestamp) || typeof timestamp !== 'number') {
      return NextResponse.json({ ok: false, error: 'A valid timestamp is required.' }, { status: 400 })
    }

    const now = Date.now()
    if (Math.abs(now - timestamp) > VOTE_MESSAGE_EXPIRY_MS) {
      return NextResponse.json({ ok: false, error: 'Vote signature is no longer valid.' }, { status: 400 })
    }

    const expectedMessage = createAllocationVoteMessage({
      proposalId: VOTE_PROPOSAL_ID,
      address: address as `0x${string}`,
      ethPercent: clampedPercent,
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

    const userStats = await getAllUserStats()

    const totalDepositsWei = userStats.reduce((acc, stat) => {
      try {
        return acc + BigInt(stat.totalValueWei)
      } catch {
        return acc
      }
    }, BIGINT_ZERO)

    if (totalDepositsWei === BIGINT_ZERO) {
      return NextResponse.json(
        { ok: false, error: 'Voting is not available yet. No deposits recorded.' },
        { status: 400 }
      )
    }

    const voterRecord = userStats.find((stat) => stat.address === address.toLowerCase())

    if (!voterRecord) {
      return NextResponse.json(
        { ok: false, error: 'Only depositors are eligible to vote.' },
        { status: 403 }
      )
    }

    let voterDepositWei: bigint
    try {
      voterDepositWei = BigInt(voterRecord.totalValueWei)
    } catch {
      voterDepositWei = BIGINT_ZERO
    }

    if (voterDepositWei === BIGINT_ZERO) {
      return NextResponse.json(
        { ok: false, error: 'You must have a positive deposit to vote.' },
        { status: 403 }
      )
    }

    const weight = calculateDepositWeight(voterDepositWei, totalDepositsWei)
    const depositValueEth = formatEther(voterDepositWei)

    const voteRecord: AllocationVoteRecord = {
      address: address.toLowerCase(),
      ethPercent: clampedPercent,
      weight,
      depositValueWei: voterDepositWei.toString(),
      depositValueEth,
      timestamp: now,
    }

    await recordAllocationVote(VOTE_PROPOSAL_ID, voteRecord)

    const { totals, votes } = await getAllocationVoteResults(VOTE_PROPOSAL_ID)
    const addressLower = address.toLowerCase()
    const updatedUserVote = votes.find((vote) => vote.address === addressLower) ?? null

    try {
      await enqueueRebalance('vote', { address: addressLower })
    } catch (error) {
      console.warn('Failed to enqueue rebalance after vote', error)
    }

    return NextResponse.json({
      ok: true,
      proposalId: VOTE_PROPOSAL_ID,
      totals,
      votes,
      userVote: updatedUserVote,
    })
  } catch (error) {
    console.error('Failed to record vote', error)
    return NextResponse.json({ ok: false, error: 'Failed to record vote.' }, { status: 500 })
  }
}

