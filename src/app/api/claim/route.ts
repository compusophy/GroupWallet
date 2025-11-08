import { NextResponse } from 'next/server'
import { base } from 'wagmi/chains'
import {
  Address,
  Signature,
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  verifyMessage,
  createWalletClient,
  encodeFunctionData,
  parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { getAllUserStats } from '@/lib/redis'
import { CLAIM_MESSAGE_EXPIRY_MS, createClaimMessage } from '@/lib/claim'
import { getTreasuryConfig, getTreasuryPrivateKey } from '@/lib/treasury'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const baseRpcUrl = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'
const EXECUTE_CLAIM = process.env.CLAIM_EXECUTE === 'true'

const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      address?: string
      signature?: string
      timestamp?: number
    } | null

    if (!body) {
      return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const { address, signature, timestamp } = body

    if (!address || !isAddress(address)) {
      return NextResponse.json({ ok: false, error: 'A valid address is required.' }, { status: 400 })
    }

    if (!signature || typeof signature !== 'string') {
      return NextResponse.json({ ok: false, error: 'A signature is required.' }, { status: 400 })
    }

    if (!Number.isFinite(timestamp) || typeof timestamp !== 'number') {
      return NextResponse.json({ ok: false, error: 'A valid timestamp is required.' }, { status: 400 })
    }

    const now = Date.now()
    if (Math.abs(now - timestamp) > CLAIM_MESSAGE_EXPIRY_MS) {
      return NextResponse.json({ ok: false, error: 'Claim signature is no longer valid.' }, { status: 400 })
    }

    const expectedMessage = createClaimMessage({
      address: address as `0x${string}`,
      timestamp,
    })

    const isValidSignature = await verifyMessage({
      address: address as Address,
      message: expectedMessage,
      signature: signature as unknown as Signature,
    })

    if (!isValidSignature) {
      return NextResponse.json({ ok: false, error: 'Signature verification failed.' }, { status: 401 })
    }

    // Compute user share from validated deposits
    const userStats = await getAllUserStats()
    const totalDepositsWei = userStats.reduce((acc, stat) => {
      try {
        return acc + BigInt(stat.totalValueWei)
      } catch {
        return acc
      }
    }, BigInt(0))

    if (totalDepositsWei === BigInt(0)) {
      return NextResponse.json(
        { ok: false, error: 'No validated deposits found. Nothing to claim.' },
        { status: 400 },
      )
    }

    const claimant = userStats.find((s) => s.address === address.toLowerCase())
    const claimantWei = claimant ? BigInt(claimant.totalValueWei) : BigInt(0)

    if (claimantWei === BigInt(0)) {
      return NextResponse.json(
        { ok: false, error: 'You have no validated deposits. Nothing to claim.' },
        { status: 403 },
      )
    }

    const share = Number(claimantWei) / Number(totalDepositsWei)

    // Fetch current treasury balances
    const config = getTreasuryConfig()
    const publicClient = createPublicClient({ chain: base, transport: http(baseRpcUrl) })
    const walletAddress = getAddress(config.address)

    const balances = await Promise.all(
      config.assets.map(async (asset) => {
        if (asset.type === 'native') {
          const bal = await publicClient.getBalance({ address: walletAddress })
          return { asset, balance: bal }
        }
        if (!asset.address) return { asset, balance: BigInt(0) }
        const balance = await publicClient.readContract({
          address: getAddress(asset.address),
          abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const,
          functionName: 'balanceOf',
          args: [walletAddress],
        })
        return { asset, balance: (balance as bigint) ?? BigInt(0) }
      }),
    )

    const plan = balances.map(({ asset, balance }) => {
      const userAmountWei = BigInt(Math.floor(Number(balance) * share))
      return {
        symbol: asset.symbol,
        type: asset.type,
        tokenAddress: asset.address ?? null,
        decimals: asset.decimals,
        amountWei: userAmountWei.toString(),
        amountFormatted: formatUnits(userAmountWei, asset.decimals),
      }
    })

    // Optionally execute transfers
    let txs: Array<{ symbol: string; hash: string }> = []
    if (EXECUTE_CLAIM) {
      const pk = getTreasuryPrivateKey()
      if (!pk) {
        return NextResponse.json(
          { ok: false, error: 'Server is not configured to execute claims.' },
          { status: 500 },
        )
      }
      const account = privateKeyToAccount(pk)
      const walletClient = createWalletClient({ account, chain: base, transport: http(baseRpcUrl) })

      for (const p of plan) {
        const amt = BigInt(p.amountWei)
        if (amt === BigInt(0)) continue
        if (p.type === 'native') {
          const hash = await walletClient.sendTransaction({
            to: address as Address,
            value: amt,
          })
          txs.push({ symbol: p.symbol, hash })
        } else if (p.tokenAddress) {
          const data = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'transfer',
            args: [address as Address, amt],
          })
          const hash = await walletClient.sendTransaction({ to: p.tokenAddress as Address, data })
          txs.push({ symbol: p.symbol, hash })
        }
      }
    }

    return NextResponse.json({
      ok: true,
      mode: EXECUTE_CLAIM ? 'executed' : 'quote',
      share,
      plan,
      transactions: txs,
    })
  } catch (error) {
    console.error('Failed to process claim:', error)
    return NextResponse.json({ ok: false, error: 'Failed to process claim' }, { status: 500 })
  }
}


