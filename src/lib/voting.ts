export const VOTE_PROPOSAL_ID = 'eth-usd-allocation-v1'
export const VOTE_MESSAGE_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

// Back-compat types/exports for legacy yes/no voting UI (still compiled in repo)
export type VoteOption = 'yes' | 'no'

export type VoteMessagePayload = {
  proposalId: string
  address: `0x${string}`
  choice: VoteOption
  timestamp: number
}

export function createVoteMessage(payload: VoteMessagePayload): string {
  const { proposalId, address, choice, timestamp } = payload
  return [
    'wagmi-vote',
    `proposal:${proposalId}`,
    `address:${address.toLowerCase()}`,
    `choice:${choice}`,
    `timestamp:${timestamp}`,
  ].join('\n')
}

export type AllocationVoteMessagePayload = {
  proposalId: string
  address: `0x${string}`
  ethPercent: number // 0..100
  timestamp: number
}

export function createAllocationVoteMessage(payload: AllocationVoteMessagePayload): string {
  const { ethPercent, timestamp } = payload
  const clampedPercent = Math.max(0, Math.min(100, Math.round(ethPercent)))
  return [
    `eth_percent:${clampedPercent}`,
    `timestamp:${timestamp}`,
  ].join('\n')
}

const WEIGHT_PRECISION = BigInt(1000000000)
const BIGINT_ZERO = BigInt(0)

export function calculateDepositWeight(depositWei: bigint, totalWei: bigint): number {
  if (depositWei <= BIGINT_ZERO || totalWei <= BIGINT_ZERO) {
    return 0
  }

  const scaled = (depositWei * WEIGHT_PRECISION) / totalWei
  return Number(scaled) / Number(WEIGHT_PRECISION)
}

