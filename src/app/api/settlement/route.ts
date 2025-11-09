import { NextResponse } from 'next/server'

import { claimNextJob, type ClaimedJob } from '@/lib/jobs'
import { processSettlementJob, type SettlementJobPayload } from '@/lib/settlement'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST() {
  let claimed: ClaimedJob<SettlementJobPayload> | null = null

  try {
    claimed = await claimNextJob<SettlementJobPayload>()
    if (!claimed) {
      return new NextResponse(null, { status: 204 })
    }

    if (claimed.job.type !== 'settlement') {
      await claimed.fail(true)
      return NextResponse.json(
        { ok: false, error: `Unsupported job type ${claimed.job.type}` },
        { status: 409 }
      )
    }

    const status = await processSettlementJob(claimed.job, { heartbeat: claimed.heartbeat })
    await claimed.ack()

    return NextResponse.json({ ok: true, status })
  } catch (error) {
    console.error('Failed to process settlement job', error)
    if (claimed) {
      await claimed.fail(true)
    }
    return NextResponse.json({ ok: false, error: 'Failed to process settlement job.' }, { status: 500 })
  }
}


