'use client'

import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSendTransaction,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { useSwitchChain, useSignMessage } from 'wagmi'
import { formatEther } from 'viem'
import { Wallet, LogOut, Copy, Check, BarChart3, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react'
import { base } from 'wagmi/chains'

// Lazy load dialog components for better initial load performance
const PlatformAnalytics = lazy(() => import('@/components/platform-analytics').then(m => ({ default: m.PlatformAnalytics })))

// Import vault assets component directly for home page display
import { VaultAssets } from '@/components/vault-assets'
import { Skeleton } from '@/components/ui/skeleton'
import { createAllocationVoteMessage, VOTE_PROPOSAL_ID } from '@/lib/voting'

const FALLBACK_SEND_AMOUNT = '0.0001' as const
type SendConfig = {
  chainId: number
  valueEth: string
  valueWei: string
  confirmations: number
  targetRecipient: `0x${string}` | null
  allowCustomRecipient: boolean
}

type ConsensusTotals = {
  weightedEthPercent: number
  totalWeight: number
  totalVoters: number
}

function formatAddress(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`
}

function formatTokenAmount(value: number, maximumFractionDigits = 6) {
  if (!Number.isFinite(value)) return '0'
  if (value === 0) return '0'
  if (value >= 1) {
    return value.toLocaleString(undefined, { maximumFractionDigits })
  }
  return value.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '')
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return '$0.00'
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function normalizeConsensusTotals(input: any): ConsensusTotals {
  const toNumber = (value: unknown, fallback = 0) => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : fallback
    }
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    return fallback
  }

  const weightedEthPercent = Math.max(0, Math.min(100, toNumber(input?.weightedEthPercent)))
  const totalWeight = Math.max(0, Math.min(1, toNumber(input?.totalWeight)))
  const totalVoters = Math.max(0, Math.round(toNumber(input?.totalVoters)))

  return {
    weightedEthPercent,
    totalWeight,
    totalVoters,
  }
}

function createClaimMessage(address: `0x${string}`, timestamp: number) {
    return [
      'wagmi-claim',
      `address:${address.toLowerCase()}`,
      `timestamp:${timestamp}`,
    ].join('\n')
  }

function App() {
  const account = useAccount()
  const { connectors, connect, status: connectStatus, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  
  const [vaultWalletAddress, setVaultWalletAddress] = useState<`0x${string}` | null>(null)
  const [vaultTotalUsd, setVaultTotalUsd] = useState(0)
  const [vaultAssets, setVaultAssets] = useState<any[]>([])
  const [userStats, setUserStats] = useState<{ totalValueEth: string; percentage: number }>({ totalValueEth: '0', percentage: 0 })
  const [vaultCopied, setVaultCopied] = useState(false)
  const [vaultLoading, setVaultLoading] = useState(true)
  const [selectedEthPercent, setSelectedEthPercent] = useState<number>(50)
  const [hasAdjustedSlider, setHasAdjustedSlider] = useState(false)
  const [initialSliderSynced, setInitialSliderSynced] = useState(false)
  const [consensusTotals, setConsensusTotals] = useState<ConsensusTotals | null>(null)
  const [submittingAllocation, setSubmittingAllocation] = useState(false)
  const [votePhase, setVotePhase] = useState<'idle' | 'signing' | 'posting'>('idle')
  const fireConfetti = useCallback(async () => {
    try {
      const mod = (await import('canvas-confetti')).default as unknown as (
        opts?: any
      ) => void
      const shoot = (particleRatio: number, opts: any) => {
        mod({
          spread: 60,
          startVelocity: 45,
          decay: 0.9,
          gravity: 1.1,
          scalar: 0.9,
          ticks: 200,
          zIndex: 9999,
          ...opts,
          particleCount: Math.floor(200 * particleRatio),
        })
      }
      shoot(0.25, { origin: { y: 0.7 } })
      shoot(0.2, { spread: 100, origin: { y: 0.6 } })
      shoot(0.35, { spread: 120, startVelocity: 55, origin: { y: 0.5 } })
      shoot(0.1, { spread: 130, origin: { y: 0.7 } })
      shoot(0.1, { spread: 130, origin: { y: 0.7 } })
    } catch {
      // no-op if library not available
    }
  }, [])

  const handleVaultSummaryUpdate = useCallback((summary: { totalUsd: number; walletAddress: `0x${string}` | null }) => {
    setVaultTotalUsd(summary.totalUsd)
    setVaultWalletAddress(summary.walletAddress)
  }, [])

  const handleVaultAssetsUpdate = useCallback((assets: any[]) => {
    setVaultAssets(assets)
  }, [])

  const [vaultRefreshKey, setVaultRefreshKey] = useState(0)
  const triggerVaultRefresh = useCallback(() => {
    setVaultRefreshKey(prev => prev + 1)
  }, [])

  useEffect(() => {
    if (hasAdjustedSlider || initialSliderSynced) return
    const totals = consensusTotals
    if (totals && totals.totalWeight > 0) {
      const pct = Math.max(0, Math.min(100, Math.round(totals.weightedEthPercent)))
      setSelectedEthPercent(pct)
      setInitialSliderSynced(true)
    }
  }, [consensusTotals, hasAdjustedSlider, initialSliderSynced])

  useEffect(() => {
    if (hasAdjustedSlider || initialSliderSynced) return
    const eth = vaultAssets.find((a: any) => (a?.symbol || '').toUpperCase() === 'ETH')
    if (eth && Number.isFinite(eth.share)) {
      const pct = Math.max(0, Math.min(100, Math.round(eth.share * 100)))
      if (Math.abs(selectedEthPercent - pct) > 0.05) {
        setSelectedEthPercent(pct)
      }
    }
  }, [vaultAssets, hasAdjustedSlider, initialSliderSynced, selectedEthPercent])

  const fetchUserStats = useCallback(async () => {
    if (!account?.addresses?.[0]) {
      setUserStats({ totalValueEth: '0', percentage: 0 })
      return
    }

    try {
      const voteResponse = await fetch(`/api/vote?address=${account.addresses[0]}`, { cache: 'no-store' })
      const analyticsResponse = await fetch('/api/analytics', { cache: 'no-store' })

      if (!voteResponse.ok || !analyticsResponse.ok) {
        return
      }

      const voteData = await voteResponse.json()
      const analyticsData = await analyticsResponse.json()

      if (voteData.ok && analyticsData.ok) {
        const userVote = voteData.userVote
        const eligibility = voteData.eligibility

        let userDepositEth = '0'
        if (userVote?.depositValueEth) {
          userDepositEth = userVote.depositValueEth
        } else if (eligibility?.isEligible) {
          userDepositEth = eligibility.depositValueEth
        }

        const userDeposits = parseFloat(userDepositEth)
        const totalDeposits = parseFloat(analyticsData.totalDeposits?.eth || '0')
        const percentage = totalDeposits > 0 ? (userDeposits / totalDeposits) * 100 : 0

        setUserStats({ totalValueEth: userDepositEth, percentage })
      } else {
        setUserStats({ totalValueEth: '0', percentage: 0 })
      }
    } catch (error) {
      console.error('Failed to fetch user stats:', error)
      setUserStats({ totalValueEth: '0', percentage: 0 })
    }
  }, [account?.addresses])

  // Load user's saved allocation vote (if any) and prefill slider
  useEffect(() => {
    let cancelled = false
    const loadUserVote = async () => {
      const addr = account?.addresses?.[0]
      if (!addr) return
      try {
        const res = await fetch(`/api/vote?address=${addr}`, { cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json()
        const pct = json?.userVote?.ethPercent
        if (!cancelled && !hasAdjustedSlider && Number.isFinite(pct)) {
          setSelectedEthPercent(Math.max(0, Math.min(100, Math.round(Number(pct)))))
          setInitialSliderSynced(true)
        }
        if (!cancelled && json?.totals) {
          setConsensusTotals(normalizeConsensusTotals(json.totals))
        }
      } catch {}
    }
    void loadUserVote()
    return () => {
      cancelled = true
    }
  }, [account?.addresses, hasAdjustedSlider, initialSliderSynced])
  
  const handleCopyVaultAddress = useCallback(() => {
    if (!vaultWalletAddress) return
    navigator.clipboard
      .writeText(vaultWalletAddress)
      .then(() => {
        setVaultCopied(true)
        setTimeout(() => setVaultCopied(false), 2000)
      })
      .catch((err) => {
        console.error('Failed to copy wallet address', err)
      })
  }, [vaultWalletAddress])

  const targetChainId = account.chainId ?? chainId

  const [sendConfig, setSendConfig] = useState<SendConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [treasuryAddress, setTreasuryAddress] = useState<`0x${string}` | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  const [txError, setTxError] = useState<string | null>(null)
  const [serverStatus, setServerStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')
  const [serverError, setServerError] = useState<string | null>(null)
  const [hasServerSynced, setHasServerSynced] = useState(false)
  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [analyticsDialogOpen, setAnalyticsDialogOpen] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [claimResult, setClaimResult] = useState<null | { mode: 'quote' | 'executed'; share: number; plan: Array<{ symbol: string; amountFormatted: string }>; transactions?: Array<{ symbol: string; hash: string }> }>(null)
  const [swapPending, setSwapPending] = useState(false)
  const [swapResult, setSwapResult] = useState<null | { ok: boolean; txHash?: string; error?: string }>(null)
  const [rebalancePending, setRebalancePending] = useState(false)
  const [rebalanceResult, setRebalanceResult] = useState<null | { ok: boolean; message?: string; error?: string }>(null)

  // Preload components on hover for faster dialog opening
  const preloadAnalytics = () => {
    import('@/components/platform-analytics')
  }
  // Preload components after initial page load
  useEffect(() => {
    preloadAnalytics()
  }, [])

  // Detect Mini App environment
  const [isMiniApp, setIsMiniApp] = useState(false)
  useEffect(() => {
    let cancelled = false
    import('@farcaster/miniapp-sdk')
      .then(async ({ sdk }) => {
        const inMini = await sdk.isInMiniApp().catch(() => false)
        if (!cancelled) setIsMiniApp(Boolean(inMini))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Farcaster Mini App: show UI immediately (we'll handle intermediate states with skeletons)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const mod = await import('@farcaster/miniapp-sdk')
        const s = (mod as any).default ?? (mod as any).sdk
        if (!cancelled && s?.actions?.ready) {
          await s.actions.ready()
        }
      } catch {}
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Remove auto switch on load; handle on click to avoid initial jitter

  useEffect(() => {
    let cancelled = false

    const loadConfig = async () => {
      setConfigLoading(true)
      try {
        const response = await fetch('/api/send-config', { cache: 'no-store' })
        if (!response.ok) {
          const message = await response.text()
          throw new Error(message || 'Failed to load send configuration')
        }
        const data = (await response.json()) as SendConfig
        if (cancelled) return
        setSendConfig(data)
        setConfigError(null)
        if (data.targetRecipient) {
          setTreasuryAddress(data.targetRecipient)
        } else {
          setTreasuryAddress(null)
        }
      } catch (error) {
        if (cancelled) return
        setSendConfig(null)
        setConfigError(error instanceof Error ? error.message : 'Failed to load send configuration')
      } finally {
        if (!cancelled) {
          setConfigLoading(false)
        }
      }
    }

    void loadConfig()

    return () => {
      cancelled = true
    }
  }, [])

  const {
    sendTransactionAsync,
    isPending: isSending,
    error: sendError,
  } = useSendTransaction()

  const {
    data: transactionReceipt,
    isPending: isWaitingForReceipt,
    isSuccess: isReceiptSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    chainId: (sendConfig?.chainId ?? base.id) as typeof base.id,
    hash: txHash,
    confirmations: sendConfig?.confirmations ?? 1,
    query: {
      enabled: Boolean(txHash),
    },
  })

  useEffect(() => {
    if (!txHash || !transactionReceipt || !isReceiptSuccess || hasServerSynced) {
      return
    }

    let cancelled = false

    const notifyServer = async () => {
      try {
        setServerStatus('pending')
        setServerError(null)
        
        const response = await fetch('/api/transaction', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ hash: txHash }),
        })

        if (!response.ok) {
          const text = await response.text()
          throw new Error(text || 'Server notification failed')
        }

        const result = await response.json()
        console.log('Server response:', result)

        if (!cancelled) {
          setServerStatus('success')
          void fireConfetti()
          // Dispatch event to notify voting section to refresh
          window.dispatchEvent(new Event('deposit-confirmed'))
        }
      } catch (error) {
        console.error('Failed to notify server:', error)
        if (!cancelled) {
          setServerStatus('error')
          setServerError(error instanceof Error ? error.message : 'Server notification failed')
        }
      } finally {
        if (!cancelled) {
          setHasServerSynced(true)
        }
      }
    }

    void notifyServer()

    return () => {
      cancelled = true
    }
  }, [txHash, transactionReceipt, isReceiptSuccess, hasServerSynced, fireConfetti])

  const requiredAmountLabel = sendConfig?.valueEth ?? FALLBACK_SEND_AMOUNT

  const isConnected = account.status === 'connected'

  // Fetch user stats when connected
  useEffect(() => {
    if (isConnected && vaultTotalUsd > 0) {
      fetchUserStats()
    }
  }, [isConnected, vaultTotalUsd, fetchUserStats])

  const isOnBase = sendConfig ? targetChainId === sendConfig.chainId : false
  const isRecipientReady = Boolean(treasuryAddress)
  const isAwaitingConfirmation = Boolean(isWaitingForReceipt && txHash)

  // Optimistic button: show as Deposit by default, only change for connect/switch or explicit progress states
  const depositButtonDisabled =
    isSending || isAwaitingConfirmation || serverStatus === 'pending'

  const depositButtonLabel = (() => {
    if (isSending) return 'Sending...'
    if (isAwaitingConfirmation) return 'Confirming...'
    if (serverStatus === 'pending') return 'Syncing...'
    return 'Contribute'
  })()

  const shareMultiplier = userStats.percentage / 100
  const shareTotalUsd = vaultAssets.reduce((acc, asset) => acc + asset.usdValue * shareMultiplier, 0)

  // Ensure ETH is shown first, USDC second in asset lists (for both summary and settle cards)
  const assetsOrderedForDisplay = useMemo(() => {
    const priority = (symbol: string) => {
      const s = (symbol || '').toUpperCase()
      if (s === 'ETH' || s === 'WETH') return 0
      if (s === 'USDC' || s === 'USDBC') return 1
      return 2
    }
    return [...vaultAssets].sort((a, b) => {
      const pa = priority(a.symbol)
      const pb = priority(b.symbol)
      if (pa !== pb) return pa - pb
      return 0
    })
  }, [vaultAssets])

  const hasConsensusPlan = Boolean(consensusTotals && consensusTotals.totalWeight > 0)
  const consensusEthPercent = hasConsensusPlan
    ? Math.max(0, Math.min(100, Math.round(consensusTotals!.weightedEthPercent)))
    : null
  const consensusEthFraction = consensusEthPercent !== null ? consensusEthPercent / 100 : null
  const consensusUsdcFraction = consensusEthFraction !== null ? Math.max(0, Math.min(1, 1 - consensusEthFraction)) : null

  const handleCopyAddress = () => {
    const address = account.addresses?.[0]
    if (!address) return
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const { signMessageAsync } = useSignMessage()

  const handleClaimShare = async () => {
    if (!account?.addresses?.[0]) return
    const addr = account.addresses[0] as `0x${string}`
    const timestamp = Date.now()
    const message = createClaimMessage(addr, timestamp)
    setClaimResult(null)
    setClaiming(true)
    try {
      const signature = await signMessageAsync({ message })
      const res = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, signature, timestamp }),
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || 'Claim failed')
      }
      const plan = (json.plan as Array<{ symbol: string; amountFormatted: string }> | undefined) ?? []
      setClaimResult({ mode: json.mode, share: json.share, plan, transactions: json.transactions })
    } catch (e) {
      console.error('Claim failed', e)
      setClaimResult({ mode: 'quote', share: 0, plan: [] })
    } finally {
      setClaiming(false)
    }
  }

  const handleSendTransaction = async () => {
    if (!sendConfig) {
      setTxError('Send configuration is not available. Please reload and try again.')
      return
    }

    if (!isRecipientReady || !treasuryAddress) {
      setTxError('Treasury address unavailable. Please reload and try again.')
      return
    }
    if (!isOnBase) {
      try {
        await switchChainAsync({ chainId: sendConfig.chainId as typeof base.id })
      } catch (e) {
        setTxError('Switch to the Base network to send a transaction')
        return
      }
    }

    setTxError(null)
    setTxHash(undefined)
    setServerStatus('idle')
    setServerError(null)
    setHasServerSynced(false)

    try {
      const hash = await sendTransactionAsync({
        to: treasuryAddress,
        value: BigInt(sendConfig.valueWei),
        chainId: sendConfig.chainId as typeof base.id,
      })
      setTxHash(hash)
    } catch (error) {
      const message =
        (error as { shortMessage?: string; message?: string })?.shortMessage ??
        (error as Error)?.message ??
        'Failed to send transaction'
      setTxError(message)
    }
  }

  return (
    <div className="min-h-screen relative">
      <div className="pt-4 md:pt-6 px-4 md:px-6 pb-4">
          <div className="mx-auto max-w-5xl space-y-6">
            <div className="max-w-2xl mx-auto relative h-[calc(100dvh-32px)] md:h-[calc(100dvh-40px)]">
            <div className="absolute inset-x-0 top-0">
              <div className="bg-card rounded-lg border p-4 space-y-4">
              <div className="mt-1 text-center">
                {vaultLoading ? (
                  <Skeleton className="h-8 w-24 mx-auto" />
                ) : (
                  <span className="text-3xl font-semibold">{formatUsd(vaultTotalUsd)}</span>
                )}
              </div>

              {!vaultLoading && vaultAssets.length > 0 && (
                <div className="space-y-4">
                  {assetsOrderedForDisplay.map((asset) => (
                    <div key={`summary-${asset.id}`} className="flex justify-between items-center">
                      <span className="text-sm font-medium">
                        {formatTokenAmount(asset.balance)} {asset.symbol}
                      </span>
                      <span className="text-sm text-muted-foreground">{formatUsd(asset.usdValue)}</span>
                    </div>
                  ))}
                </div>
              )}

              <Button
                type="button"
                className="w-full"
                disabled={depositButtonDisabled}
                onClick={() => {
                  if (!isConnected) {
                    setAccountDialogOpen(true)
                    return
                  }
                  if (sendConfig && !isOnBase) {
                    void (async () => {
                      try {
                        await switchChainAsync({ chainId: sendConfig.chainId as typeof base.id })
                        await handleSendTransaction()
                      } catch {
                        void handleSendTransaction()
                      }
                    })()
                    return
                  }
                  void handleSendTransaction()
                }}
              >
                <span>{depositButtonLabel}</span>
              </Button>
              </div>
            </div>

            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2">
              <div className="bg-card rounded-lg border p-4 space-y-4">
              <div className="mt-1">
                  <VaultAssets
                    key={vaultRefreshKey}
                    onSummaryUpdate={handleVaultSummaryUpdate}
                    onLoadingChange={setVaultLoading}
                    onAssetsUpdate={handleVaultAssetsUpdate}
                    onConsensusUpdate={setConsensusTotals}
                  />
              </div>

              {/* Slider to pick ETH/USDC ratio */}
              <div className="mt-1 text-center text-sm text-muted-foreground">
                {`ETH ${Math.round(selectedEthPercent)}% · USDC ${Math.round(100 - selectedEthPercent)}%`}
              </div>
              <div className="mt-1 px-1">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.1}
                  value={selectedEthPercent}
                  onChange={(e) => {
                    setHasAdjustedSlider(true)
                    setSelectedEthPercent(Number(e.target.value))
                  }}
                  className="allocation-slider w-full"
                  style={{
                    background: `linear-gradient(to right, var(--eth-color) 0%, var(--eth-color) ${selectedEthPercent}%, var(--usdc-color) ${selectedEthPercent}%, var(--usdc-color) 100%)`,
                  }}
                />
              </div>

              <Button
                type="button"
                className="w-full"
                disabled={vaultLoading || vaultAssets.length === 0 || submittingAllocation || votePhase !== 'idle'}
                onClick={async () => {
                  if (!isConnected) {
                    setAccountDialogOpen(true)
                    return
                  }
                  const addr = account.addresses?.[0]
                  if (!addr) return
                  setSubmittingAllocation(true)
                  try {
                    setVotePhase('signing')
                    const timestamp = Date.now()
                    const message = createAllocationVoteMessage({
                      proposalId: VOTE_PROPOSAL_ID,
                      address: addr as `0x${string}`,
                      ethPercent: Math.round(selectedEthPercent),
                      timestamp,
                    })
                    const signature = await signMessageAsync({ message })
                    setVotePhase('posting')
                    const res = await fetch('/api/vote', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ address: addr, ethPercent: Math.round(selectedEthPercent), signature, timestamp }),
                    })
                    let json: any = null
                    try {
                      json = await res.json()
                    } catch (parseErr) {
                      console.error('Failed to parse allocation vote response', parseErr)
                    }

                    if (res.ok && json?.ok) {
                      if (json?.totals) {
                        setConsensusTotals(normalizeConsensusTotals(json.totals))
                      }
                      window.dispatchEvent(new Event('allocation-vote-updated'))
                      void fireConfetti()
                    } else {
                      const message = json?.error || 'Allocation vote submission failed'
                      console.error(message)
                    }
                  } catch (e) {
                    console.error('Allocation vote failed', e)
                  } finally {
                    setSubmittingAllocation(false)
                    setVotePhase('idle')
                  }
                }}
              >
                {votePhase === 'signing'
                  ? 'Confirming...'
                  : votePhase === 'posting'
                    ? 'Syncing...'
                    : isConnected
                      ? 'Vote'
                      : 'Connect to vote'}
              </Button>

              <Button
                type="button"
                className="w-full"
                disabled={swapPending}
                onClick={async () => {
                  setSwapResult(null)
                  setSwapPending(true)
                  try {
                    const res = await fetch('/api/swap', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ direction: 'usdc_to_eth', amount: '0.50' }),
                    })
                    const json = await res.json().catch(() => ({}))
                    if (res.ok && json?.ok) {
                      setSwapResult({ ok: true, txHash: json.txHash as string })
                    } else {
                      setSwapResult({ ok: false, error: (json?.error as string) || 'Swap failed' })
                    }
                  } catch (e) {
                    setSwapResult({ ok: false, error: e instanceof Error ? e.message : 'Swap failed' })
                  } finally {
                    setSwapPending(false)
                  }
                }}
              >
                {swapPending ? 'Swapping…' : 'Test Swap (USDC → ETH $0.50)'}
              </Button>
              {swapResult && (
                <div className="text-xs text-center text-muted-foreground">
                  {swapResult.ok ? (
                    <span>Swap sent: {swapResult.txHash?.slice(0, 10)}…</span>
                  ) : (
                    <span>Swap error: {swapResult.error}</span>
                  )}
                </div>
              )}

              <Button
                type="button"
                className="w-full"
                disabled={rebalancePending}
                onClick={async () => {
                  setRebalanceResult(null)
                  setRebalancePending(true)
                  try {
                    const res = await fetch('/api/rebalance?manual=true', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                    })
                    const json = await res.json().catch(() => ({}))
                    if (res.ok && json?.ok) {
                      setRebalanceResult({ 
                        ok: true, 
                        message: json.outcome?.message || json.message || 'Rebalance completed successfully' 
                      })
                      // Trigger vault refresh to show updated balances
                      setTimeout(() => triggerVaultRefresh(), 2000) // Wait 2s for transaction to be indexed
                    } else {
                      setRebalanceResult({ ok: false, error: (json?.error as string) || 'Rebalance failed' })
                    }
                  } catch (e) {
                    setRebalanceResult({ ok: false, error: e instanceof Error ? e.message : 'Rebalance failed' })
                  } finally {
                    setRebalancePending(false)
                  }
                }}
              >
                {rebalancePending ? 'Rebalancing…' : 'Smart Swap to Consensus Rebalance'}
              </Button>
              {rebalanceResult && (
                <div className="text-xs text-center text-muted-foreground">
                  {rebalanceResult.ok ? (
                    <span>{rebalanceResult.message || 'Rebalance completed'}</span>
                  ) : (
                    <span>Rebalance error: {rebalanceResult.error}</span>
                  )}
                </div>
              )}

              </div>
            </div>

            {isConnected && (
              <>
                <div className="absolute inset-x-0 bottom-0">
                  <div className="bg-card rounded-lg border p-4 space-y-4">
                  <div className="mt-1 text-center">
                    {vaultLoading ? (
                      <Skeleton className="h-8 w-24 mx-auto" />
                    ) : (
                      <span className="text-3xl font-semibold">{formatUsd(shareTotalUsd)}</span>
                    )}
                  </div>
                  <div className="space-y-4">
                    {vaultLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-5 w-32 mx-auto" />
                        <Skeleton className="h-5 w-40 mx-auto" />
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {vaultAssets.length > 0 ? (
                          assetsOrderedForDisplay.map((asset) => {
                            let claimTokenAmount = asset.balance * shareMultiplier
                            let claimUsdAmount = asset.usdValue * shareMultiplier

                            return (
                              <div key={`share-${asset.id}`} className="flex justify-between items-center">
                                <span className="text-sm font-medium">
                                  {formatTokenAmount(claimTokenAmount)} {asset.symbol}
                                </span>
                                <span className="text-sm text-muted-foreground">{formatUsd(claimUsdAmount)}</span>
                              </div>
                            )
                          })
                        ) : (
                          <div className="text-sm text-muted-foreground text-center">No assets available yet</div>
                        )}
                      </div>
                    )}

                    <Button
                      type="button"
                      className="w-full"
                      disabled={claiming || vaultLoading || vaultAssets.length === 0}
                      onClick={handleClaimShare}
                    >
                    {claiming ? 'Processing…' : 'Settle'}
                    </Button>

                    {claimResult && !vaultLoading && (
                      <div className="space-y-1 text-center text-xs text-muted-foreground">
                        <div>
                          {claimResult.mode === 'executed' ? 'Settlement executed' : 'Settlement preview'} — share:{' '}
                          {(claimResult.share * 100).toFixed(2)}%
                        </div>
                        {claimResult.plan.length > 0 && (
                          <div className="space-y-1">
                            {claimResult.plan.map((p, i) => (
                              <div key={`claim-${p.symbol}-${i}`} className="flex justify-between">
                                <span>{p.symbol}</span>
                                <span>{p.amountFormatted}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  </div>
                </div>

                {/* Allocation voting UI replaces previous yes/no card */}
              </>
            )}

            {/* Voting section removed per new allocation voting design */}
          </div>

          <Dialog open={analyticsDialogOpen} onOpenChange={setAnalyticsDialogOpen}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5" />
                  Platform Analytics
                </DialogTitle>
                <DialogDescription>Overview of deposits and contributor share.</DialogDescription>
                {vaultWalletAddress && (
                  <div className="flex items-center gap-2 pt-2">
                    <span className="text-sm text-muted-foreground">Vault address:</span>
                    <code className="rounded bg-muted px-2 py-1 text-xs font-mono">
                      {formatAddress(vaultWalletAddress)}
                    </code>
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted flex-shrink-0"
                      onClick={handleCopyVaultAddress}
                      title="Copy wallet address"
                    >
                      {vaultCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    </button>
                    <a
                      href={`https://basescan.org/address/${vaultWalletAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted flex-shrink-0"
                      title="View on Basescan"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </DialogHeader>
              <Suspense
                fallback={
                  <div className="space-y-3">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                  </div>
                }
              >
                <PlatformAnalytics />
              </Suspense>
            </DialogContent>
          </Dialog>

          <Dialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Wallet className="h-5 w-5" />
                  {account.status === 'connected' ? 'Account' : 'Connect Wallet'}
                </DialogTitle>
                <DialogDescription>
                  {account.status === 'connected'
                    ? 'Your connected wallet information'
                    : 'Select a wallet to get started.'}
                </DialogDescription>
              </DialogHeader>
              {account.status === 'connected' ? (
                <div className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between py-2">
                      <span className="text-sm font-medium text-muted-foreground">Status</span>
                      <span className="rounded-full bg-green-500/10 px-2 py-1 text-xs font-semibold text-green-500">
                        Connected
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-sm font-medium text-muted-foreground">Address</span>
                      <div className="flex items-center gap-2">
                        <code className="rounded bg-muted px-2 py-1 text-sm">
                          {account.addresses?.[0] ? formatAddress(account.addresses[0]) : 'N/A'}
                        </code>
                        <Button
                          aria-label="Copy address"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={handleCopyAddress}
                        >
                          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-sm font-medium text-muted-foreground">Chain ID</span>
                      <span className="font-mono text-sm">{account.chainId}</span>
                    </div>
                  </div>
                  <Button
                    variant="destructive"
                    className="w-full"
                    onClick={() => {
                      disconnect()
                      setAccountDialogOpen(false)
                    }}
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    Disconnect
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {connectors.map((connector) => (
                    <Button
                      key={connector.uid}
                      onClick={() => {
                        connect({ connector })
                        setAccountDialogOpen(false)
                      }}
                      className="w-full justify-start"
                      variant="outline"
                      disabled={connectStatus === 'pending'}
                    >
                      <Wallet className="mr-2 h-4 w-4" />
                      {connector.name}
                    </Button>
                  ))}
                  {connectStatus === 'pending' && (
                    <p className="py-2 text-center text-sm text-muted-foreground">Connecting...</p>
                  )}
                  {connectError && (
                    <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                      {connectError.message}
                    </div>
                  )}
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}

export default App
