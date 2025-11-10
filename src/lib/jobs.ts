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
const JOB_MAX_AGE_MS = Number.parseInt(process.env.JOB_MAX_AGE_MINUTES ?? '5', 10) * 60 * 1000 // Default 5 minutes

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
    // Cleanup stale jobs periodically (10% chance to avoid overhead)
    if (Math.random() < 0.1) {
      await cleanupStaleJobs()
    }

    const raw = await redis.lpop(JOB_QUEUE_KEY)
    if (!raw) {
      await releaseLock()
      return null
    }

    // Handle both string and object cases (Upstash Redis may auto-parse JSON)
    let job: Job<TPayload>
    if (typeof raw === 'string') {
      job = parseJob(raw) as Job<TPayload>
    } else if (typeof raw === 'object' && raw !== null) {
      // Already parsed by Redis
      job = raw as Job<TPayload>
    } else {
      await releaseLock()
      return null
    }
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

/**
 * Claim a specific job by ID, skipping non-matching jobs temporarily
 * Non-matching jobs are moved to the back of the queue
 * Returns null if the job is not found or lock cannot be acquired
 */
export async function claimJobById<TPayload = unknown>(targetJobId: string, maxSkips = 10): Promise<ClaimedJob<TPayload> | null> {
  const lockAcquired = await acquireLock()
  if (!lockAcquired) {
    return null
  }

  try {
    // Cleanup stale jobs first
    await cleanupStaleJobs()

    const skippedJobs: string[] = []
    let found = false
    let targetJob: Job<TPayload> | null = null

    // Look through the queue for our target job
    for (let i = 0; i < maxSkips; i++) {
      const raw = await redis.lpop(JOB_QUEUE_KEY)
      if (!raw) {
        // Queue is empty, restore skipped jobs
        if (skippedJobs.length > 0) {
          await redis.rpush(JOB_QUEUE_KEY, ...skippedJobs)
        }
        await releaseLock()
        return null
      }

      // Handle both string and object cases (Upstash Redis may auto-parse JSON)
      let job: Job<TPayload> | null = null
      try {
        if (typeof raw === 'string') {
          job = parseJob(raw) as Job<TPayload>
        } else if (typeof raw === 'object' && raw !== null) {
          // Already parsed by Redis
          job = raw as Job<TPayload>
        } else {
          throw new Error(`Invalid job format: ${typeof raw}`)
        }
      } catch (parseError) {
        // Invalid job - skip it (don't restore)
        console.warn('[jobs] Skipping invalid job entry while searching', {
          rawSnippet: typeof raw === 'string' ? raw.slice(0, 64) : String(raw).slice(0, 64),
          error: parseError instanceof Error ? parseError.message : String(parseError),
        })
        continue
      }
      
      if (!job) {
        continue
      }
      
      try {
        if (job.id === targetJobId) {
          // Found our target job!
          targetJob = {
            ...job,
            attempts: (job.attempts ?? 0) + 1,
            lastAttemptAt: Date.now(),
          }
          found = true
          break
        } else {
          // Not our job - save it to restore later (serialize if needed)
          const jobString = typeof raw === 'string' ? raw : serializeJob(job)
          skippedJobs.push(jobString)
        }
      } catch (error) {
        // Error processing job - skip it (don't restore)
        console.warn('[jobs] Error processing job while searching', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Restore skipped jobs to the back of the queue
    if (skippedJobs.length > 0) {
      await redis.rpush(JOB_QUEUE_KEY, ...skippedJobs)
    }

    if (!found || !targetJob) {
      await releaseLock()
      return null
    }

    // Mark job as processing
    await redis.set(getProcessingKey(targetJob.id), serializeJob(targetJob), { ex: DEFAULT_LOCK_TTL_SECONDS })

    const ack = async () => {
      try {
        await redis.del(getProcessingKey(targetJob!.id))
      } finally {
        await releaseLock()
      }
    }

    const fail = async (requeue = true) => {
      try {
        await redis.del(getProcessingKey(targetJob!.id))
        if (requeue) {
          await redis.rpush(JOB_QUEUE_KEY, serializeJob(targetJob!))
        }
      } finally {
        await releaseLock()
      }
    }

    const heartbeat = async () => {
      await Promise.all([redis.expire(getProcessingKey(targetJob!.id), DEFAULT_LOCK_TTL_SECONDS), extendLock()])
    }

    return { job: targetJob, ack, fail, heartbeat }
  } catch (error) {
    console.error('[jobs] Failed to claim job by ID', { targetJobId, error })
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

export async function isRebalanceProcessing(): Promise<boolean> {
  try {
    // Check for any processing jobs that are rebalance type
    const keys = await redis.keys(`${JOB_PROCESSING_KEY_PREFIX}*`)
    if (!keys || keys.length === 0) return false
    
    for (const key of keys) {
      try {
        const raw = await redis.get<string>(key)
        if (raw) {
          const job = parseJob(raw)
          if (job.type === 'rebalance') {
            return true
          }
        }
      } catch (error) {
        // Skip invalid job entries
        continue
      }
    }
    return false
  } catch (error) {
    console.error('[jobs] Failed to check rebalance processing status', error)
    return false
  }
}

export async function isSettlementProcessing(): Promise<boolean> {
  try {
    // Check for any processing jobs that are settlement type
    const keys = await redis.keys(`${JOB_PROCESSING_KEY_PREFIX}*`)
    if (!keys || keys.length === 0) return false
    
    for (const key of keys) {
      try {
        const raw = await redis.get<string>(key)
        if (raw) {
          const job = parseJob(raw)
          if (job.type === 'settlement') {
            return true
          }
        }
      } catch (error) {
        // Skip invalid job entries
        continue
      }
    }
    return false
  } catch (error) {
    console.error('[jobs] Failed to check settlement processing status', error)
    return false
  }
}

export async function isAnyOperationProcessing(): Promise<boolean> {
  try {
    const [rebalance, settlement] = await Promise.all([
      isRebalanceProcessing(),
      isSettlementProcessing(),
    ])
    return rebalance || settlement
  } catch (error) {
    console.error('[jobs] Failed to check operation processing status', error)
    return false
  }
}

/**
 * Clean up stale jobs from the queue that are older than JOB_MAX_AGE_MS
 * Returns the number of jobs cleaned up
 */
export async function cleanupStaleJobs(): Promise<number> {
  try {
    const now = Date.now()
    const allJobs = await redis.lrange(JOB_QUEUE_KEY, 0, -1)
    if (!allJobs || allJobs.length === 0) return 0

    const staleJobIds: string[] = []
    const validJobs: string[] = []

    for (const raw of allJobs) {
      try {
        const job = parseJob(raw)
        const age = now - job.enqueuedAt
        if (age > JOB_MAX_AGE_MS) {
          staleJobIds.push(job.id)
          console.log('[jobs] Found stale job', {
            id: job.id,
            type: job.type,
            ageMinutes: Math.round(age / (60 * 1000)),
            enqueuedAt: new Date(job.enqueuedAt).toISOString(),
          })
        } else {
          validJobs.push(raw)
        }
      } catch (error) {
        // Invalid job entry - treat as stale
        console.warn('[jobs] Found invalid job entry, treating as stale', {
          rawSnippet: String(raw).slice(0, 64),
        })
        staleJobIds.push('invalid')
      }
    }

    if (staleJobIds.length === 0) return 0

    // Rebuild queue with only valid jobs
    await redis.del(JOB_QUEUE_KEY)
    if (validJobs.length > 0) {
      await redis.rpush(JOB_QUEUE_KEY, ...validJobs)
    }

    console.info('[jobs] Cleaned up stale jobs', {
      removed: staleJobIds.length,
      remaining: validJobs.length,
    })

    return staleJobIds.length
  } catch (error) {
    console.error('[jobs] Failed to cleanup stale jobs', error)
    return 0
  }
}


