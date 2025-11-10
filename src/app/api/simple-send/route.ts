import { NextResponse } from 'next/server'
import { createPublicClient, createWalletClient, http, parseEther, parseUnits, isAddress, encodeFunctionData, Address, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'wagmi/chains'
import { getTreasuryPrivateKey } from '@/lib/treasury'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const USDC_ADDRESS = getAddress('0x833589fcd6edB6e08F4c7c32D4f71B54Bda02913')
const USDC_DECIMALS = 6

const ERC20_TRANSFER_ABI = [
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
      toAddress?: string
      asset?: 'ETH' | 'USDC' | 'BATCH'
    } | null

    if (!body) {
      return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const { toAddress, asset = 'ETH' } = body

    if (!toAddress || !isAddress(toAddress)) {
      return NextResponse.json({ ok: false, error: 'A valid toAddress is required.' }, { status: 400 })
    }

    const privateKey = getTreasuryPrivateKey()
    if (!privateKey) {
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

    const account = privateKeyToAccount(privateKey)
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(baseRpcUrl),
    })
    const publicClient = createPublicClient({
      chain: base,
      transport: http(baseRpcUrl),
    })

    if (asset === 'BATCH') {
      // Batch send both ETH and USDC sequentially
      const ethAmountWei = parseEther('0.0001')
      const usdcAmountUnits = parseUnits('0.001', USDC_DECIMALS)

      console.log('[simple-send] Batch sending ETH and USDC', {
        from: account.address,
        to: toAddress,
        ethAmount: '0.0001 ETH',
        usdcAmount: '0.001 USDC',
      })

      // Send ETH first
      const ethTxHash = await walletClient.sendTransaction({
        account,
        chain: base,
        to: toAddress as `0x${string}`,
        value: ethAmountWei,
      })

      console.log('[simple-send] ETH transaction sent', { txHash: ethTxHash })
      await publicClient.waitForTransactionReceipt({ hash: ethTxHash })
      console.log('[simple-send] ETH transaction confirmed', { txHash: ethTxHash })

      // Then send USDC
      const usdcTransferData = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [toAddress as Address, usdcAmountUnits],
      })

      const usdcTxHash = await walletClient.sendTransaction({
        account,
        chain: base,
        to: USDC_ADDRESS,
        data: usdcTransferData,
      })

      console.log('[simple-send] USDC transaction sent', { txHash: usdcTxHash })
      await publicClient.waitForTransactionReceipt({ hash: usdcTxHash })
      console.log('[simple-send] USDC transaction confirmed', { txHash: usdcTxHash })

      return NextResponse.json({
        ok: true,
        txHash: ethTxHash,
        txHashes: [ethTxHash, usdcTxHash],
        message: 'Successfully sent 0.0001 ETH and 0.001 USDC',
      })
    } else if (asset === 'ETH') {
      const amountWei = parseEther('0.0001')

      console.log('[simple-send] Sending ETH', {
        from: account.address,
        to: toAddress,
        amount: '0.0001 ETH',
        amountWei: amountWei.toString(),
      })

      const txHash = await walletClient.sendTransaction({
        account,
        chain: base,
        to: toAddress as `0x${string}`,
        value: amountWei,
      })

      console.log('[simple-send] Transaction sent', { txHash })

      await publicClient.waitForTransactionReceipt({ hash: txHash })

      console.log('[simple-send] Transaction confirmed', { txHash })

      return NextResponse.json({
        ok: true,
        txHash,
        message: 'Successfully sent 0.0001 ETH',
      })
    } else {
      // USDC transfer
      const amountUnits = parseUnits('0.001', USDC_DECIMALS)

      console.log('[simple-send] Sending USDC', {
        from: account.address,
        to: toAddress,
        amount: '0.001 USDC',
        amountUnits: amountUnits.toString(),
        tokenAddress: USDC_ADDRESS,
      })

      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [toAddress as Address, amountUnits],
      })

      const txHash = await walletClient.sendTransaction({
        account,
        chain: base,
        to: USDC_ADDRESS,
        data,
      })

      console.log('[simple-send] Transaction sent', { txHash })

      await publicClient.waitForTransactionReceipt({ hash: txHash })

      console.log('[simple-send] Transaction confirmed', { txHash })

      return NextResponse.json({
        ok: true,
        txHash,
        message: 'Successfully sent 0.001 USDC',
      })
    }
  } catch (error) {
    console.error('[simple-send] Failed to send:', error)
    const message = error instanceof Error ? error.message : 'Failed to send'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

