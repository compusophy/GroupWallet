import { createPublicClient, formatUnits, getAddress, http } from 'viem'
import { base } from 'wagmi/chains'

const rpcUrl = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'

console.log('Using RPC', rpcUrl)

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
})

const VAULT_ADDRESS = getAddress('0xe815308Ac85A573F7aF1D4008C590948E69E124f')
const TOKENS = {
  USDC: getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  USDbC: getAddress('0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'),
}

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
]

for (const [label, tokenAddress] of Object.entries(TOKENS)) {
  const code = await client.getBytecode({ address: tokenAddress })
  if (!code || code === '0x') {
    console.log(label, 'bytecode missing')
    continue
  }

  const balance = await client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [VAULT_ADDRESS],
  })

  console.log(
    label,
    'raw',
    balance.toString(),
    'formatted',
    formatUnits(balance, 6)
  )
}

