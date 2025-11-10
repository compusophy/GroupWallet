import { NextResponse } from 'next/server'
import { clearQueue, cleanupStaleJobs } from '@/lib/jobs'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * POST /api/queue/clear
 * Clears all jobs from the queue and cleans up stale jobs
 * Useful for manual cleanup when queue is stuck
 */
export async function POST(request: Request) {
  try {
    // First cleanup stale jobs
    const staleCount = await cleanupStaleJobs()
    console.log('[queue] Cleaned up stale jobs', { count: staleCount })

    // Then clear the entire queue
    const clearedCount = await clearQueue()
    console.log('[queue] Cleared queue', { count: clearedCount })

    return NextResponse.json({
      ok: true,
      cleared: clearedCount,
      staleCleaned: staleCount,
      message: `Cleared ${clearedCount} jobs from queue and cleaned up ${staleCount} stale jobs`,
    })
  } catch (error) {
    console.error('[queue] Failed to clear queue', error)
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to clear queue',
      },
      { status: 500 }
    )
  }
}

