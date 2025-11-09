import { randomUUID } from 'node:crypto'

import { redis } from './redis'

export type JobType = 'rebalance' | 'settlement'

export type Job<TPayload = unknown> = {
  id: string
  type: JobType
  payload: TPayload
  attempts: number
  enqueuedAt: number
  lastAttemptAt?: number
}

export type EnqueueJobOptions = {
  dedupeKey?: string
  dedupeTtlSeconds?: number
}

const JOB_QUEUE_KEY = 'jobs:queue:main'
const JOB_LOCK_KEY = 'jobs:lock:main'
const JOB_PROCESSING_KEY_PREFIX = 'jobs:processing:'
const DEFAULT_LOCK_TTL_SECONDS = Number.parseInt(process.env.JOB_LOCK_TTL_SECONDS ?? '120', 10)
const DEFAULT_DEDUPE_TTL_SECONDS = Number.parseInt(process.env.JOB_DEDUPE_TTL_SECONDS ?? '300', 10)

function getProcessingKey(jobId: string) {
  return `${JOB_PROCESSING_KEY_PREFIX}${jobId}`
}

function getDedupeKey(raw: string) {
  return `jobs:dedupe:${raw}`
}

function serializeJob<TPayload>(job: Job<TPayload>): string {
  return JSON.stringify(job)
}

function parseJob(raw: string | object): Job {
  if (typeof raw === 'object' && raw !== null) {
    return raw as Job
  }
  if (typeof raw === 'string') {
    return JSON.parse(raw) as Job
  }
  throw new Error(`Invalid job format: ${typeof raw}`)
}

async function acquireLock(): Promise<boolean> {
  try {
    const result = await redis.set(JOB_LOCK_KEY, Date.now().toString(), {
      nx: true,
      ex: DEFAULT_LOCK_TTL_SECONDS,
    })
    return result === 'OK'
  } catch (error) {
    console.error('[jobs] Failed to acquire lock', error)
    return false
  }
}

async function extendLock(): Promise<void> {
  try {
    await redis.expire(JOB_LOCK_KEY, DEFAULT_LOCK_TTL_SECONDS)
  } catch (error) {
    console.warn('[jobs] Failed to extend lock TTL', error)
  }
}

async function releaseLock(): Promise<void> {
  try {
    await redis.del(JOB_LOCK_KEY)
  } catch (error) {
    console.error('[jobs] Failed to release lock', error)
  }
}

export async function enqueueJob<TPayload>(
  type: JobType,
  payload: TPayload,
  options: EnqueueJobOptions = {}
): Promise<Job<TPayload> | null> {
  try {
    if (options.dedupeKey) {
      const normalized = getDedupeKey(options.dedupeKey)
      const setResult = await redis.set(
        normalized,
        '1',
        {
          nx: true,
          ex: options.dedupeTtlSeconds ?? DEFAULT_DEDUPE_TTL_SECONDS,
        }
      )
      if (setResult !== 'OK') {
        return null
      }
    }

    const job: Job<TPayload> = {
      id: randomUUID(),
      type,
      payload,
      attempts: 0,
      enqueuedAt: Date.now(),
    }

    await redis.rpush(JOB_QUEUE_KEY, serializeJob(job))
    console.info('[jobs] Enqueued job', { id: job.id, type: job.type, enqueuedAt: job.enqueuedAt })
    return job
  } catch (error) {
    console.error('[jobs] Failed to enqueue job', { type, error })
    return null
  }
}

export type ClaimedJob<TPayload = unknown> = {
  job: Job<TPayload>
  ack: () => Promise<void>
  fail: (requeue?: boolean) => Promise<void>
  heartbeat: () => Promise<void>
}

export async function claimNextJob<TPayload = unknown>(): Promise<ClaimedJob<TPayload> | null> {
  const lockAcquired = await acquireLock()
  if (!lockAcquired) {
    return null
  }

  try {
    const raw = await redis.lpop(JOB_QUEUE_KEY)
    if (!raw) {
      await releaseLock()
      return null
    }

    let job = parseJob(raw) as Job<TPayload>
    job = {
      ...job,
      attempts: (job.attempts ?? 0) + 1,
      lastAttemptAt: Date.now(),
    }

    await redis.set(getProcessingKey(job.id), serializeJob(job), { ex: DEFAULT_LOCK_TTL_SECONDS })

    const ack = async () => {
      try {
        await redis.del(getProcessingKey(job.id))
      } finally {
        await releaseLock()
      }
    }

    const fail = async (requeue = true) => {
      try {
        await redis.del(getProcessingKey(job.id))
        if (requeue) {
          await redis.lpush(JOB_QUEUE_KEY, serializeJob(job))
        }
      } finally {
        await releaseLock()
      }
    }

    const heartbeat = async () => {
      await Promise.all([redis.expire(getProcessingKey(job.id), DEFAULT_LOCK_TTL_SECONDS), extendLock()])
    }

    return { job, ack, fail, heartbeat }
  } catch (error) {
    console.error('[jobs] Failed to claim next job', error)
    await releaseLock()
    return null
  }
}

export async function getQueueSize(): Promise<number> {
  try {
    const length = await redis.llen(JOB_QUEUE_KEY)
    return typeof length === 'number' ? length : Number(length ?? 0)
  } catch (error) {
    console.error('[jobs] Failed to get queue size', error)
    return 0
  }
}

export async function clearQueue(): Promise<number> {
  try {
    const length = await redis.llen(JOB_QUEUE_KEY)
    if (length === 0) {
      return 0
    }
    // Delete all items from the queue
    await redis.del(JOB_QUEUE_KEY)
    console.info('[jobs] Cleared queue', { clearedCount: length })
    return typeof length === 'number' ? length : Number(length ?? 0)
  } catch (error) {
    console.error('[jobs] Failed to clear queue', error)
    throw error
  }
}

export async function peekJobs<TPayload = unknown>(limit = 10): Promise<Array<Job<TPayload>>> {
  try {
    const raws = await redis.lrange(JOB_QUEUE_KEY, 0, Math.max(0, limit - 1))
    if (!raws || raws.length === 0) return []
    const jobs: Array<Job<TPayload>> = []
    for (const raw of raws) {
      try {
        jobs.push(parseJob(raw) as Job<TPayload>)
      } catch (error) {
        console.warn('[jobs] Skipping unparsable job entry', { rawSnippet: String(raw).slice(0, 64) })
      }
    }
    return jobs
  } catch (error) {
    console.error('[jobs] Failed to peek jobs', error)
    return []
  }
}


