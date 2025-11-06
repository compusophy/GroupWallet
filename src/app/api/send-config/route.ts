import { NextResponse } from 'next/server'
import { base } from 'wagmi/chains'
import { isAddress, parseEther } from 'viem'

import { getTreasuryAddress } from '@/lib/treasury'

const DEFAULT_SEND_AMOUNT_ETH = '0.0001'
const DEFAULT_CONFIRMATIONS = 1

const valueEth = process.env.NEXT_PUBLIC_SEND_AMOUNT_ETH ?? DEFAULT_SEND_AMOUNT_ETH
const valueWei = parseEther(valueEth)
const parsedConfirmations = Number(process.env.NEXT_PUBLIC_SEND_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS)
const confirmations = Number.isFinite(parsedConfirmations) && parsedConfirmations > 0
  ? Math.round(parsedConfirmations)
  : DEFAULT_CONFIRMATIONS
function resolveTargetRecipient(): `0x${string}` | null {
  const fromEnv = process.env.NEXT_PUBLIC_TARGET_RECIPIENT ?? process.env.TARGET_RECIPIENT
  if (fromEnv && isAddress(fromEnv)) {
    return fromEnv as `0x${string}`
  }

  try {
    return getTreasuryAddress()
  } catch (error) {
    console.warn('Falling back to allowing custom recipient. Reason:', error)
    return null
  }
}

export async function GET() {
  const targetRecipient = resolveTargetRecipient()

  return NextResponse.json({
    chainId: base.id,
    valueEth,
    valueWei: valueWei.toString(),
    confirmations,
    targetRecipient,
    allowCustomRecipient: targetRecipient === null,
  })
}
