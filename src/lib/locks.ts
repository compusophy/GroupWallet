import { redis } from './redis'

const OPERATION_LOCK_PREFIX = 'lock:operation:'
const DEFAULT_LOCK_TTL_SECONDS = 30 // 30 seconds max for any operation
const LOCK_RETRY_DELAY_MS = 100 // Wait 100ms between retries
const MAX_LOCK_RETRIES = 10 // Try up to 10 times (1 second total)

export type OperationType = 'vote' | 'transaction' | 'settlement' | 'rebalance'

function getLockKey(operation: OperationType, identifier?: string): string {
  if (identifier) {
    return `${OPERATION_LOCK_PREFIX}${operation}:${identifier.toLowerCase()}`
  }
  return `${OPERATION_LOCK_PREFIX}${operation}:global`
}

export type LockResult = {
  acquired: boolean
  release: () => Promise<void>
}

/**
 * Acquire a distributed lock for an operation.
 * Returns a lock result with a release function.
 * 
 * @param operation - Type of operation (vote, transaction, settlement, rebalance)
 * @param identifier - Optional identifier (e.g., user address for user-specific locks)
 * @param ttlSeconds - Lock TTL in seconds (default: 30)
 * @returns Lock result with acquired status and release function
 */
export async function acquireOperationLock(
  operation: OperationType,
  identifier?: string,
  ttlSeconds: number = DEFAULT_LOCK_TTL_SECONDS
): Promise<LockResult> {
  const lockKey = getLockKey(operation, identifier)
  const lockValue = `${Date.now()}-${Math.random()}` // Unique value to verify ownership

  try {
    // Try to acquire lock with SET NX EX (set if not exists, with expiration)
    const result = await redis.set(lockKey, lockValue, {
      nx: true,
      ex: ttlSeconds,
    })

    if (result === 'OK') {
      return {
        acquired: true,
        release: async () => {
          try {
            // Only delete if we still own the lock (check value matches)
            const currentValue = await redis.get(lockKey)
            if (currentValue === lockValue) {
              await redis.del(lockKey)
            }
          } catch (error) {
            console.error(`[locks] Failed to release lock ${lockKey}`, error)
          }
        },
      }
    }

    return {
      acquired: false,
      release: async () => {
        // No-op if we didn't acquire the lock
      },
    }
  } catch (error) {
    console.error(`[locks] Failed to acquire lock ${lockKey}`, error)
    return {
      acquired: false,
      release: async () => {
        // No-op on error
      },
    }
  }
}

/**
 * Acquire a lock with retries. Useful for operations that need to wait.
 * 
 * @param operation - Type of operation
 * @param identifier - Optional identifier
 * @param maxRetries - Maximum number of retries (default: 10)
 * @param retryDelayMs - Delay between retries in ms (default: 100)
 * @returns Lock result
 */
export async function acquireOperationLockWithRetry(
  operation: OperationType,
  identifier?: string,
  maxRetries: number = MAX_LOCK_RETRIES,
  retryDelayMs: number = LOCK_RETRY_DELAY_MS
): Promise<LockResult> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const lock = await acquireOperationLock(operation, identifier)
    if (lock.acquired) {
      return lock
    }

    if (attempt < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }

  return {
    acquired: false,
    release: async () => {
      // No-op if we never acquired the lock
    },
  }
}

/**
 * Check if an operation is currently locked.
 */
export async function isOperationLocked(
  operation: OperationType,
  identifier?: string
): Promise<boolean> {
  const lockKey = getLockKey(operation, identifier)
  try {
    const exists = await redis.exists(lockKey)
    return exists === 1
  } catch (error) {
    console.error(`[locks] Failed to check lock ${lockKey}`, error)
    return false
  }
}

