import { NextResponse } from 'next/server'

import { redis } from '@/lib/redis'

export const dynamic = 'force-dynamic'
export const revalidate = 0

async function scanKeys(match: string, count = 200): Promise<string[]> {
  try {
    let cursor = 0
    const keys: string[] = []
    do {
      const [nextCursor, batch] = await redis.scan(cursor, { match, count })
      if (batch && batch.length > 0) keys.push(...batch)
      cursor = Number(nextCursor)
    } while (cursor !== 0)
    return keys
  } catch (error) {
    console.error('[admin:reset] Failed to scan keys', { match, error })
    return []
  }
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const tokenParam = url.searchParams.get('token')
    const authHeader = request.headers.get('authorization')
    const bearer = authHeader?.match(/Bearer\s+(.+)/i)?.[1] ?? null
    const provided = tokenParam ?? bearer ?? null
    const required = process.env.RESET_SECRET

    if (!required) {
      return NextResponse.json(
        { ok: false, error: 'RESET_SECRET is not configured on the server.' },
        { status: 500 }
      )
    }
    if (!provided || provided !== required) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 })
    }

    const patterns = [
      'user:stats:*',
      'user:tx:*',
      'tx:*',
      'vote:*',
      'allocvote:*',
      'rebalance:*',
      'settlement:user:*',
      'settlement:job:*',
      'jobs:*',
      'price:snapshot:*',
    ]

    const allKeys = (
      await Promise.all(patterns.map((p) => scanKeys(p)))
    ).flat()

    let deleted = 0
    if (allKeys.length > 0) {
      const chunks: string[][] = []
      for (let i = 0; i < allKeys.length; i += 1000) {
        chunks.push(allKeys.slice(i, i + 1000))
      }
      for (const chunk of chunks) {
        try {
          deleted += Number(await redis.del(...chunk))
        } catch (error) {
          console.warn('[admin:reset] Failed to delete chunk', { size: chunk.length, error })
        }
      }
    }

    return NextResponse.json({
      ok: true,
      deleted,
      patterns,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[admin:reset] Failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to reset data.' }, { status: 500 })
  }
}


