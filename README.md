# GroupWallet

GroupWallet is a Next.js 14 web application that tracks a shared Base mainnet treasury. It aggregates on-chain balances, normalises USD values, and exposes simple controls for contributors to review analytics, deposit ETH, and vote on allocation proposals.

## Features

- **Live Treasury Snapshot** – Server API reads ETH and ERC-20 balances at the `finalized` block and returns USD totals.
- **Vault Overview Dialog** – Detailed asset breakdown with historical voting context.
- **Horizontal Allocation Bars** – ETH and USDC weights visualised with responsive sizing and accessible colour pairing.
- **Deposit Workflow** – Guided ETH deposit flow with transaction status, receipt polling, and explorer links.
- **Voting Module** – Signature-based voting backed by Upstash Redis for persistence and weighting.
- **Help & Status Guards** – UI cues for wallet connection, network alignment, and copy-to-clipboard actions.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Blockchain Tooling**: wagmi, viem
- **Styling & UI**: Tailwind CSS, shadcn/ui, Lucide icons
- **Data & Storage**: Upstash Redis, custom Next.js API routes
- **Build Tooling**: TypeScript, pnpm, ESLint

## Architecture Overview

```
app/
├── page.tsx          # Home dashboard (vault summary + module dialogs)
├── api/
│   ├── treasury/     # Finalized block balances + USD pricing
│   ├── analytics/    # Deposit stats aggregated from Redis
│   ├── vote/         # Vote eligibility + casting endpoints
│   └── transaction/  # Deposit webhook for post-transaction sync
components/
├── vault-assets.tsx       # Horizontal allocation bars + summary bridge
├── platform-analytics.tsx # Depositor stats visualisation
├── treasury-overview.tsx  # Dialog rendering server API data
├── voting-section.tsx     # Vote UI wiring to signing + API
└── ui/                    # shadcn/ui primitives (button, dialog, etc.)
lib/
├── treasury.ts  # Asset metadata + address helpers
├── redis.ts     # Upstash client + persistence helpers
└── voting.ts    # Vote message helpers + weight maths
```

All sensitive operations (treasury reads, Redis mutations) execute exclusively on the server via Next.js route handlers. Client components consume typed responses and memoise ordering while avoiding direct private key usage.

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 8+
- Access to the Base mainnet RPC (public or private)
- Upstash Redis database
- Optional: Coinbase Token Balances API credentials for future integration

### Installation

```bash
git clone https://github.com/compusophy/GroupWallet.git
cd GroupWallet
pnpm install
```

### Environment Variables

Create a `.env` file at the project root:

```
# Base RPC endpoint used by server-side viem clients
BASE_RPC_URL=https://mainnet.base.org

# Chainlink price feed addresses (Base mainnet)
CHAINLINK_FEED_ETH=0xYourEthUsdFeedAddress
CHAINLINK_FEED_USDC=0xYourUsdcUsdFeedAddress

# Rebalance execution controls
REBALANCE_EXECUTE=false
REBALANCE_SLIPPAGE_BPS=50
REBALANCE_MIN_USD_DELTA=5
REBALANCE_TOLERANCE_PERCENT=1
ZEROX_BASE_URL=https://base.api.0x.org
# Optional if you have a 0x API key
ZEROX_API_KEY=
CLAIM_EXECUTE=false
SETTLEMENT_HISTORY_LIMIT=50

# Treasury wallet private key (server only). Used to derive the vault address when
# TARGET_RECIPIENT is not provided. Never expose to the client.
TREASURY_PRIVATE_KEY=0xexample...

# Optional explicit treasury recipient. Must be checksummed when provided.
TARGET_RECIPIENT=0xVaultAddress...

# ETH amount required for deposits (defaults to 0.0001 if omitted)
NEXT_PUBLIC_SEND_AMOUNT_ETH=0.0001

# Required confirmation count for deposits (defaults to 1)
NEXT_PUBLIC_SEND_CONFIRMATIONS=1

# Upstash Redis credentials
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token

# Optional fixed ETH price override
ETH_PRICE_USD=3000
```

| Variable | Required | Scope | Description |
|----------|----------|-------|-------------|
| `BASE_RPC_URL` | ✅ | Server | RPC endpoint for finalized balance reads |
| `CHAINLINK_FEED_ETH` | ✅ | Server | Chainlink ETH/USD aggregator address on Base |
| `CHAINLINK_FEED_USDC` | ✅ | Server | Chainlink USDC/USD (or equivalent stable) aggregator address on Base |
| `REBALANCE_EXECUTE` | ⚪ | Server | Set to `true` to allow automated treasury rebalances |
| `REBALANCE_SLIPPAGE_BPS` | ⚪ | Server | Max slippage for swaps (basis points, default 50 = 0.5%) |
| `REBALANCE_MIN_USD_DELTA` | ⚪ | Server | Minimum USD delta required before rebalancing |
| `REBALANCE_TOLERANCE_PERCENT` | ⚪ | Server | Percentage band around target allocation that is treated as balanced |
| `ZEROX_BASE_URL` | ⚪ | Server | 0x Swap API base URL (defaults to Base mainnet endpoint) |
| `ZEROX_API_KEY` | ⚪ | Server | Optional 0x API key for higher rate limits |
| `CLAIM_EXECUTE` | ⚪ | Server | Set to `true` to allow settlement worker to transfer funds |
| `SETTLEMENT_HISTORY_LIMIT` | ⚪ | Server | Number of settlement history items to keep in Redis |
| `TREASURY_PRIVATE_KEY` | ✅* | Server | Private key for deriving vault address (*required unless `TARGET_RECIPIENT` is set) |
### Background Workers

- `POST /api/rebalance`: process the next queued rebalance job. Configure a cron or manual trigger after deposits/votes.
- `POST /api/settlement`: process the next queued settlement job. Requires `CLAIM_EXECUTE=true` and treasury private key on the server.

| `TARGET_RECIPIENT` | ⚪ | Server | Explicit vault recipient address |
| `NEXT_PUBLIC_SEND_AMOUNT_ETH` | ⚪ | Client | Minimum ETH amount for deposit flow |
| `NEXT_PUBLIC_SEND_CONFIRMATIONS` | ⚪ | Client | Confirmation threshold before recording a deposit |
| `UPSTASH_REDIS_REST_URL` | ✅ | Server | Upstash REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ | Server | Upstash auth token |
| `ETH_PRICE_USD` | ⚪ | Server | Manual ETH price override in USD |

### Development

```bash
pnpm dev
```

The development server starts on `http://localhost:3000`. Hot reloading is enabled for both client and server modules.

### Linting & Type Safety

```bash
pnpm lint
pnpm typecheck
```

### Production Build

```bash
pnpm build
pnpm start
```

`pnpm build` enforces linting/type checks and generates the production bundle. `pnpm start` runs the compiled app.

## Key Workflows

### Treasury API (`/api/treasury`)

- Completes asset lookups at the `finalized` block for deterministic USD totals.
- Deduplicates ERC-20 tokens by address and computes share percentages server-side.
- Utilises DefiLlama pricing (`coins.llama.fi`) with cached fallbacks.
- Returns an object consumed by both the homepage summary and `TreasuryOverview` dialog.

### Transaction Webhook (`/api/transaction`)

1. Receives a transaction hash from the client post-deposit.
2. Verifies success status, ensures value matches required amount, and validates chain ID.
3. Computes confirmations by comparing latest block height to the receipt block.
4. Records the deposit in Upstash Redis and emits a `deposit-confirmed` browser event to refresh balances.

### Voting Flow (`/api/vote`)

- Uses a deterministic message (`createVoteMessage`) that includes proposal ID, choice, and timestamp.
- Requires a valid EIP-191 signature from the submitting wallet.
- Enforces expiry (`VOTE_MESSAGE_EXPIRY_MS`) and ensures only depositors with positive weight can vote.
- Persists votes and aggregates weighted totals in Redis.

## Deployment Notes

- The project has been tested with Vercel builds (`pnpm build`).
- Ensure `BASE_RPC_URL` and Upstash credentials are configured as **Server Environment Variables** in Vercel.
- For deterministic builds, avoid `no-store` fetches in static routes; API routes are dynamic by design.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit changes with clear messages
4. Push and open a pull request

## License

MIT © GroupWallet contributors