import { NextResponse } from 'next/server'
import { formatEther, isAddress, type Address, type Signature, verifyMessage } from 'viem'

import {
  getAllUserStats,
  getVoteResults,
  recordVote,
  type VoteChoice,
  type VoteRecord,
} from '@/lib/redis'
import {
  calculateDepositWeight,
  createVoteMessage,
  VOTE_MESSAGE_EXPIRY_MS,
  VOTE_PROPOSAL_ID,
} from '@/lib/voting'

const BIGINT_ZERO = BigInt(0)

function normalizeChoice(choice: string | undefined): VoteChoice | null {
  if (!choice) return null
  const lower = choice.toLowerCase()
  if (lower === 'yes' || lower === 'no') {
    return lower
  }
  return null
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const addressParam = url.searchParams.get('address')

    const { totals, votes } = await getVoteResults(VOTE_PROPOSAL_ID)

    let userVote: VoteRecord | null = null
    let isEligible = false
    let depositValueWei = '0'
    let depositValueEth = '0'

    if (addressParam && isAddress(addressParam)) {
      const addressLower = addressParam.toLowerCase()
      userVote = votes.find((vote) => vote.address === addressLower) ?? null

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

    return NextResponse.json({
      ok: true,
      proposalId: VOTE_PROPOSAL_ID,
      totals,
      votes,
      userVote,
      eligibility: {
        isEligible,
        depositValueWei,
        depositValueEth,
      },
    })
  } catch (error) {
    console.error('Failed to load vote results', error)
    return NextResponse.json({ ok: false, error: 'Failed to load vote results' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      address?: string
      choice?: string
      signature?: string
      timestamp?: number
    } | null

    if (!body) {
      return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const { address, choice, signature, timestamp } = body

    if (!address || !isAddress(address)) {
      return NextResponse.json({ ok: false, error: 'A valid address is required.' }, { status: 400 })
    }

    const normalizedChoice = normalizeChoice(choice)
    if (!normalizedChoice) {
      return NextResponse.json({ ok: false, error: 'Invalid vote choice.' }, { status: 400 })
    }

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

    const expectedMessage = createVoteMessage({
      proposalId: VOTE_PROPOSAL_ID,
      address: address as `0x${string}`,
      choice: normalizedChoice,
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

    const voteRecord: VoteRecord = {
      address: address.toLowerCase(),
      choice: normalizedChoice,
      weight,
      depositValueWei: voterDepositWei.toString(),
      depositValueEth,
      timestamp: now,
    }

    await recordVote(VOTE_PROPOSAL_ID, voteRecord)

    const { totals, votes } = await getVoteResults(VOTE_PROPOSAL_ID)
    const addressLower = address.toLowerCase()
    const updatedUserVote = votes.find((vote) => vote.address === addressLower) ?? null

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

