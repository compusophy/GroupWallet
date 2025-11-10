import { NextResponse } from 'next/server'
import { isRebalanceProcessing } from '@/lib/jobs'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  try {
    const processing = await isRebalanceProcessing()
    return NextResponse.json({ ok: true, processing })
  } catch (error) {
    console.error('Failed to check rebalance status', error)
    return NextResponse.json({ ok: false, error: 'Failed to check rebalance status' }, { status: 500 })
  }
}

