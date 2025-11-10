import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { loadUserStatus } from '@/lib/settlement'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/settlement-status?address=0x...
 * Returns the settlement status for a given address
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const addressParam = url.searchParams.get('address')

    if (!addressParam || !isAddress(addressParam)) {
      return NextResponse.json(
        { ok: false, error: 'A valid address parameter is required.' },
        { status: 400 }
      )
    }

    const status = await loadUserStatus(addressParam)

    return NextResponse.json({
      ok: true,
      status: status
        ? {
            state: status.state,
            executed: status.state === 'executed',
            jobId: status.jobId,
            createdAt: status.createdAt,
            updatedAt: status.updatedAt,
            transactions: status.transactions,
          }
        : null,
    })
  } catch (error) {
    console.error('Failed to load settlement status', error)
    return NextResponse.json(
      { ok: false, error: 'Failed to load settlement status' },
      { status: 500 }
    )
  }
}

