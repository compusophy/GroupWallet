export const CLAIM_MESSAGE_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

export type ClaimMessagePayload = {
  address: `0x${string}`
  timestamp: number
}

export function createClaimMessage(payload: ClaimMessagePayload): string {
  const { address, timestamp } = payload
  return [
    'wagmi-claim',
    `address:${address.toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join('\n')
}


