import { NextResponse } from 'next/server'

import { clearQueue, getQueueSize, peekJobs } from '@/lib/jobs'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  try {
    const size = await getQueueSize()
    const head = await peekJobs(5)
    return NextResponse.json({
      ok: true,
      size,
      head: head.map((j) => ({ id: j.id, type: j.type, attempts: j.attempts, enqueuedAt: j.enqueuedAt })),
    })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Failed to peek jobs' }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    const cleared = await clearQueue()
    return NextResponse.json({
      ok: true,
      cleared,
      message: `Cleared ${cleared} job(s) from queue`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to clear queue'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}


