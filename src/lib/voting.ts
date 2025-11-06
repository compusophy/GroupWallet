export const VOTE_PROPOSAL_ID = 'eth-usd-allocation-v1'
export const VOTE_MESSAGE_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

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

const WEIGHT_PRECISION = BigInt(1000000000)
const BIGINT_ZERO = BigInt(0)

export function calculateDepositWeight(depositWei: bigint, totalWei: bigint): number {
  if (depositWei <= BIGINT_ZERO || totalWei <= BIGINT_ZERO) {
    return 0
  }

  const scaled = (depositWei * WEIGHT_PRECISION) / totalWei
  return Number(scaled) / Number(WEIGHT_PRECISION)
}

