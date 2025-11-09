import { NextResponse } from 'next/server'

import { claimNextJob, type ClaimedJob } from '@/lib/jobs'
import { enqueueRebalance, processRebalanceJob, type RebalanceJobPayload } from '@/lib/rebalance'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request) {
  const url = new URL(request.url)
  const manual = url.searchParams.get('manual') === 'true'

  // Manual rebalance: enqueue and try to process immediately
  if (manual) {
    try {
      // Enqueue a manual rebalance job
      await enqueueRebalance('manual', { triggeredBy: 'api' })

      // Try to claim and process it immediately
      const claimed = await claimNextJob<RebalanceJobPayload>()
      if (!claimed) {
        return NextResponse.json(
          { ok: true, message: 'Rebalance job enqueued. It will be processed shortly.' },
          { status: 202 }
        )
      }

      if (claimed.job.type !== 'rebalance') {
        await claimed.fail(true)
        return NextResponse.json(
          { ok: false, error: `Unsupported job type ${claimed.job.type}` },
          { status: 409 }
        )
      }

      const outcome = await processRebalanceJob(claimed.job, { heartbeat: claimed.heartbeat })
      await claimed.ack()

      return NextResponse.json({ ok: true, outcome })
    } catch (error) {
      console.error('Failed to process manual rebalance', error)
      const message = error instanceof Error ? error.message : 'Failed to process manual rebalance.'
      return NextResponse.json({ ok: false, error: message }, { status: 500 })
    }
  }

  // Default: process next job from queue
  let claimed: ClaimedJob<RebalanceJobPayload> | null = null

  try {
    claimed = await claimNextJob<RebalanceJobPayload>()
    if (!claimed) {
      return new NextResponse(null, { status: 204 })
    }

    if (claimed.job.type !== 'rebalance') {
      await claimed.fail(true)
      return NextResponse.json(
        { ok: false, error: `Unsupported job type ${claimed.job.type}` },
        { status: 409 }
      )
    }

    const outcome = await processRebalanceJob(claimed.job, { heartbeat: claimed.heartbeat })
    await claimed.ack()

    return NextResponse.json({ ok: true, outcome })
  } catch (error) {
    console.error('Failed to process rebalance job', error)
    if (claimed) {
      await claimed.fail(true)
    }
    return NextResponse.json({ ok: false, error: 'Failed to process rebalance job.' }, { status: 500 })
  }
}


