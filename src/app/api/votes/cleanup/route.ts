import { NextResponse } from 'next/server'
import { cleanupStaleAllocationVotes } from '@/lib/redis'
import { VOTE_PROPOSAL_ID } from '@/lib/voting'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * POST /api/votes/cleanup
 * Manually trigger cleanup of stale allocation votes
 * Removes votes from users with zero contributions or who have settled
 */
export async function POST() {
  try {
    const cleaned = await cleanupStaleAllocationVotes(VOTE_PROPOSAL_ID)
    
    return NextResponse.json({
      ok: true,
      cleaned,
      message: `Cleaned up ${cleaned} stale vote(s)`,
    })
  } catch (error) {
    console.error('[votes] Failed to cleanup stale votes', error)
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to cleanup stale votes',
      },
      { status: 500 }
    )
  }
}

