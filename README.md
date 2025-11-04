# next-wagmi-starter

A simple wallet connector using Wagmi and Next.js.

**Live Demo:** [https://compu-next-wagmi-starter.vercel.app/](https://compu-next-wagmi-starter.vercel.app/)

## Features

- **Wallet Connection** - Connect to injected wallets (MetaMask, Coinbase Wallet, etc.)
- **Built with Wagmi** - Powerful React Hooks for Ethereum
- **Modern UI** - Beautiful interface built with Tailwind CSS and shadcn/ui
- **Next.js 14** - App Router with Server-Side Rendering support
- **TypeScript** - Fully typed for better developer experience

## Tech Stack

- [Next.js](https://nextjs.org) - React framework
- [Wagmi](https://wagmi.sh) - React Hooks for Ethereum
- [Viem](https://viem.sh) - TypeScript Ethereum library
- [Tailwind CSS](https://tailwindcss.com) - Utility-first CSS framework
- [shadcn/ui](https://ui.shadcn.com) - Re-usable components
- [Lucide React](https://lucide.dev) - Icon library

## Getting Started

### Prerequisites

- Node.js 18+ 
- pnpm (recommended) or npm/yarn

### Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd next-wagmi-starter
```

2. Install dependencies:
```bash
pnpm install
```

3. Run the development server:
```bash
pnpm dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
next-wagmi-starter/
├── src/
│   ├── app/              # Next.js App Router pages
│   │   ├── layout.tsx    # Root layout
│   │   ├── page.tsx      # Home page
│   │   ├── providers.tsx # Wagmi & React Query providers
│   │   └── globals.css   # Global styles
│   ├── components/       # React components
│   │   └── ui/          # shadcn/ui components
│   ├── lib/             # Utility functions
│   └── wagmi.ts         # Wagmi configuration
├── public/              # Static assets
└── package.json        # Dependencies
```

## Configuration

The Wagmi configuration is located in `src/wagmi.ts`. You can customize:

- **Chains** - Currently supports Mainnet and Sepolia
- **Connectors** - Uses injected connector for browser wallets
- **Storage** - Cookie-based storage for SSR support

## Building for Production

```bash
pnpm build
pnpm start
```

## Deployment

This project is deployed on [Vercel](https://vercel.com). You can deploy your own instance by:

1. Fork this repository
2. Import it to Vercel
3. Deploy!

## License

MIT

## Resources

- [Wagmi Documentation](https://wagmi.sh)
- [Next.js Documentation](https://nextjs.org/docs)
- [Viem Documentation](https://viem.sh)
