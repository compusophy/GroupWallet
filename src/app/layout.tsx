import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { headers } from 'next/headers'
import { type ReactNode } from 'react'
import { cookieToInitialState } from 'wagmi'

import { getConfig } from '../wagmi'
import { Providers } from './providers'

export async function generateMetadata(): Promise<Metadata> {
  const origin =
    process.env.NEXT_PUBLIC_APP_ORIGIN ||
    process.env.NEXT_PUBLIC_URL ||
    'https://compu-custom-hooks.vercel.app'

  const miniapp = {
    version: '1',
    imageUrl: `${origin}/image.png`,
    button: {
      title: 'Open App',
      action: {
        type: 'launch_miniapp',
        name: 'GroupWallet',
        url: origin,
        splashImageUrl: `${origin}/icon.png`,
        splashBackgroundColor: '#ffffff',
      },
    },
  }

  return {
    title: 'GroupWallet',
    openGraph: {
      title: 'GroupWallet',
      images: [`${origin}/image.png`],
    },
    other: {
      'fc:miniapp': JSON.stringify(miniapp),
      'fc:frame': JSON.stringify(miniapp),
    },
  }
}

const inter = Inter({ subsets: ['latin'] })

export default async function RootLayout(props: { children: ReactNode }) {
  const initialState = cookieToInitialState(
    getConfig(),
    (await headers()).get('cookie'),
  )
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <Providers initialState={initialState}>{props.children}</Providers>
      </body>
    </html>
  )
}
