import { NextResponse } from 'next/server'
import { base } from 'wagmi/chains'
import {
  Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseEther,
  parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ZEROX_BASE_URL = 'https://api.0x.org'
const ZEROX_API_KEY = process.env.ZEROX_API_KEY

// Base tokens
const USDC_ADDRESS = getAddress('0x833589fcd6edB6e08F4c7c32D4f71B54Bda02913')
const WETH_ADDRESS = getAddress('0x4200000000000000000000000000000000000006')

const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const WETH_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
] as const

type Direction = 'eth_to_usdc' | 'usdc_to_eth'

type QuoteResponse = {
  sellAmount: string
  buyAmount: string
  issues?: {
    allowance?: { spender?: string; actual?: string } | null
  }
  transaction: {
    to: string
    data: `0x${string}`
    gas?: string
    gasPrice?: string
    value?: string
  }
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { direction?: Direction; amount?: string }
      | null

    const direction: Direction =
      body?.direction === 'usdc_to_eth' ? 'usdc_to_eth' : 'eth_to_usdc'

    // Small defaults suitable for a quick local test
    const amountHuman =
      typeof body?.amount === 'string' && body.amount.trim().length > 0
        ? body.amount.trim()
        : direction === 'eth_to_usdc'
          ? '0.00005' // 0.00005 ETH -> USDC
          : '0.50' // 0.50 USDC -> ETH

    const privateKeyRaw = process.env.TREASURY_PRIVATE_KEY ?? null
    if (!privateKeyRaw) {
      return NextResponse.json(
        { ok: false, error: 'TREASURY_PRIVATE_KEY is not configured.' },
        { status: 500 }
      )
    }
    const baseRpcUrl = process.env.BASE_RPC_URL
    if (!baseRpcUrl) {
      return NextResponse.json(
        { ok: false, error: 'BASE_RPC_URL is not configured.' },
        { status: 500 }
      )
    }

    const privateKey = (privateKeyRaw.startsWith('0x')
      ? privateKeyRaw
      : `0x${privateKeyRaw}`) as `0x${string}`
    const account = privateKeyToAccount(privateKey)

    const walletClient = createWalletClient({
      account: account as any, // Type assertion to work around viem version mismatch
      chain: base,
      transport: http(baseRpcUrl),
    })
    const publicClient = createPublicClient({
      chain: base,
      transport: http(baseRpcUrl),
    })

    // Build token pair using WETH address for ETH-side (v2 requires addresses)
    const sellToken =
      direction === 'eth_to_usdc' ? WETH_ADDRESS : USDC_ADDRESS
    const buyToken =
      direction === 'eth_to_usdc' ? USDC_ADDRESS : WETH_ADDRESS

    const sellAmount =
      direction === 'eth_to_usdc'
        ? parseEther(amountHuman).toString() // amount in ETH to wrap
        : parseUnits(amountHuman, 6).toString() // USDC has 6 decimals

    // Do not pre-wrap; let 0x handle ETH semantics

    const params = new URLSearchParams({
      sellToken: sellToken,
      buyToken: buyToken,
      sellAmount,
      // v2 uses `taker`
      taker: account.address,
    })

    // Always specify chainId for cross-chain host
    params.set('chainId', base.id.toString())

    const headers: Record<string, string> = {
      accept: 'application/json',
      '0x-version': 'v2',
    }
    if (ZEROX_API_KEY) {
      headers['0x-api-key'] = ZEROX_API_KEY
    }

    const url = `${ZEROX_BASE_URL}/swap/allowance-holder/quote?${params.toString()}`
    console.info('[swap] 0x quote URL', url)
    const quoteResponse = await fetch(url, { headers })

    if (!quoteResponse.ok) {
      const text = await quoteResponse.text()
      return NextResponse.json(
        { ok: false, error: `0x quote failed: ${quoteResponse.status} ${text}` },
        { status: 502 }
      )
    }

    const quote = (await quoteResponse.json()) as QuoteResponse

    // Approve USDC for AllowanceHolder if needed (selling USDC)
    const spender = quote.issues?.allowance?.spender
    if (direction === 'usdc_to_eth' && spender && walletClient.account) {
      const approveHash = await walletClient.writeContract({
        account: walletClient.account as any, // Type assertion to work around viem version mismatch
        chain: base,
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [getAddress(spender), BigInt(quote.sellAmount)],
      })
      await publicClient.waitForTransactionReceipt({ hash: approveHash })
    }

    if (!walletClient.account) {
      return NextResponse.json(
        { ok: false, error: 'Wallet client account is not available.' },
        { status: 500 }
      )
    }

    const txHash = await walletClient.sendTransaction({
      account: walletClient.account as any, // Type assertion to work around viem version mismatch
      chain: base,
      to: getAddress(quote.transaction.to),
      data: quote.transaction.data,
      value: BigInt(quote.transaction.value ?? '0'),
      gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
      gasPrice: quote.transaction.gasPrice ? BigInt(quote.transaction.gasPrice) : undefined,
    })

    await publicClient.waitForTransactionReceipt({ hash: txHash })

    // Do not force unwrap; 0x may deliver ETH directly

    return NextResponse.json({ ok: true, txHash, direction, amount: amountHuman })
  } catch (error) {
    console.error('Swap failed', error)
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}


