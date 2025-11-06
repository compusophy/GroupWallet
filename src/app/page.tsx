'use client'

import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSendTransaction,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { Wallet, LogOut, Copy, Check, Send, BarChart3, Vault, Vote, ExternalLink } from 'lucide-react'
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
import { useCallback, useEffect, useState, lazy, Suspense } from 'react'
import { base } from 'wagmi/chains'

// Lazy load dialog components for better initial load performance
const PlatformAnalytics = lazy(() => import('@/components/platform-analytics').then(m => ({ default: m.PlatformAnalytics })))
const TreasuryOverview = lazy(() => import('@/components/treasury-overview').then(m => ({ default: m.TreasuryOverview })))
const VotingSection = lazy(() => import('@/components/voting-section').then(m => ({ default: m.VotingSection })))

// Import vault assets component directly for home page display
import { VaultAssets } from '@/components/vault-assets'

const FALLBACK_SEND_AMOUNT = '0.0001' as const
const BASE_EXPLORER_TX_URL = 'https://basescan.org/tx/'

type SendConfig = {
  chainId: number
  valueEth: string
  valueWei: string
  confirmations: number
  targetRecipient: `0x${string}` | null
  allowCustomRecipient: boolean
}

function formatAddress(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`
}

function formatHash(hash: `0x${string}`) {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
}

function App() {
  const account = useAccount()
  const { connectors, connect, status: connectStatus, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const chainId = useChainId()
  
  const [vaultWalletAddress, setVaultWalletAddress] = useState<`0x${string}` | null>(null)
  const [vaultTotalUsd, setVaultTotalUsd] = useState(0)
  const [vaultCopied, setVaultCopied] = useState(false)

  const handleVaultSummaryUpdate = useCallback((summary: { totalUsd: number; walletAddress: `0x${string}` | null }) => {
    setVaultTotalUsd(summary.totalUsd)
    setVaultWalletAddress(summary.walletAddress)
  }, [])
  
  function formatUsd(value: number) {
    if (!Number.isFinite(value)) return '$0.00'
    return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  }

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
  const [treasuryDialogOpen, setTreasuryDialogOpen] = useState(false)
  const [depositDialogOpen, setDepositDialogOpen] = useState(false)
  const [votingDialogOpen, setVotingDialogOpen] = useState(false)

  // Preload components on hover for faster dialog opening
  const preloadAnalytics = () => {
    import('@/components/platform-analytics')
  }
  const preloadTreasury = () => {
    import('@/components/treasury-overview')
  }
  const preloadVoting = () => {
    import('@/components/voting-section')
  }

  // Preload all components after initial page load
  useEffect(() => {
    const timer = setTimeout(() => {
      preloadAnalytics()
      preloadTreasury()
      preloadVoting()
    }, 2000) // Preload after 2 seconds
    return () => clearTimeout(timer)
  }, [])

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
    status: receiptStatus,
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
  }, [txHash, transactionReceipt, isReceiptSuccess, hasServerSynced])

  const requiredAmountLabel = sendConfig?.valueEth ?? FALLBACK_SEND_AMOUNT

  const isConnected = account.status === 'connected'
  const isOnBase = sendConfig ? targetChainId === sendConfig.chainId : false
  const isRecipientReady = Boolean(treasuryAddress)
  const sendErrorMessage = (() => {
    if (txError) return txError
    if (sendError && typeof sendError === 'object' && 'shortMessage' in sendError) {
      const shortMessage = (sendError as { shortMessage?: string }).shortMessage
      if (shortMessage) return shortMessage
    }
    return sendError?.message ?? null
  })()
  const receiptErrorMessage = receiptError?.message ?? null
  const explorerUrl = txHash ? `${BASE_EXPLORER_TX_URL}${txHash}` : null
  const isAwaitingConfirmation = Boolean(isWaitingForReceipt && txHash)

  const handleCopyAddress = () => {
    const address = account.addresses?.[0]
    if (!address) return
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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
      setTxError('Switch to the Base network to send a transaction')
      return
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
      <div className="fixed top-4 md:top-8 left-1/2 -translate-x-1/2 z-50 h-10 flex items-center">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">GroupWallet</h1>
      </div>

      
      {/* Main Content Area */}
      <div className="pt-20 md:pt-28 px-4 md:px-8 pb-8">
        <div className="mx-auto max-w-5xl space-y-8">
          {/* Vault Assets - At the top */}
          <div className="max-w-2xl mx-auto space-y-4">
            {/* Vault Total USD Value */}
            <div className="text-center">
              <p className="text-xl md:text-2xl font-semibold">{formatUsd(vaultTotalUsd)}</p>
            </div>
            
            {/* Wallet Address */}
            {vaultWalletAddress && (
              <div className="flex items-center justify-center gap-2">
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
            <VaultAssets onSummaryUpdate={handleVaultSummaryUpdate} />
          </div>
          
          {/* Button Array - Centered below assets */}
          <div className="flex justify-center">
            <div className="w-2/3 flex flex-col gap-1">
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-3 h-auto py-3 px-4"
            onClick={() => setAnalyticsDialogOpen(true)}
            onMouseEnter={preloadAnalytics}
          >
            <BarChart3 className="h-5 w-5 flex-shrink-0" />
            <span className="text-sm font-medium">Platform Analytics</span>
          </Button>
          
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-3 h-auto py-3 px-4"
            onClick={() => setTreasuryDialogOpen(true)}
            onMouseEnter={preloadTreasury}
          >
            <Vault className="h-5 w-5 flex-shrink-0" />
            <span className="text-sm font-medium">Vault Overview</span>
          </Button>
          
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-3 h-auto py-3 px-4"
            onClick={() => setDepositDialogOpen(true)}
          >
            <Send className="h-5 w-5 flex-shrink-0" />
            <span className="text-sm font-medium">Deposit ETH</span>
          </Button>
          
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-3 h-auto py-3 px-4"
            onClick={() => setVotingDialogOpen(true)}
            onMouseEnter={preloadVoting}
          >
            <Vote className="h-5 w-5 flex-shrink-0" />
            <span className="text-sm font-medium">Allocation Vote</span>
          </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={analyticsDialogOpen} onOpenChange={setAnalyticsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Platform Analytics
            </DialogTitle>
            <DialogDescription>Overview of deposits and contributor share.</DialogDescription>
          </DialogHeader>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading analytics...</p>}>
            <PlatformAnalytics />
          </Suspense>
        </DialogContent>
      </Dialog>

      <Dialog open={treasuryDialogOpen} onOpenChange={setTreasuryDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Vault className="h-5 w-5" />
              Vault Overview
            </DialogTitle>
            <DialogDescription>Breakdown of the group wallet holdings.</DialogDescription>
          </DialogHeader>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading treasury data...</p>}>
            <TreasuryOverview />
          </Suspense>
        </DialogContent>
      </Dialog>

      <Dialog open={depositDialogOpen} onOpenChange={setDepositDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Deposit ETH
            </DialogTitle>
            <DialogDescription>Transfer {requiredAmountLabel} ETH to Vault</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void handleSendTransaction()
              }}
            >
              <Button
                type="submit"
                className="w-full"
                disabled={
                  !sendConfig ||
                  configLoading ||
                  !isConnected ||
                  !isOnBase ||
                  !isRecipientReady ||
                  isSending ||
                  isAwaitingConfirmation ||
                  serverStatus === 'pending'
                }
              >
                {serverStatus === 'pending'
                  ? 'Syncing...'
                  : isAwaitingConfirmation
                    ? 'Confirming...'
                    : isSending
                      ? 'Sending...'
                      : 'Send'}
              </Button>
            </form>

            {configLoading && (
              <p className="text-xs text-muted-foreground">Loading send configuration...</p>
            )}
            {configError && <div className="text-xs text-destructive">{configError}</div>}
            {!isConnected && (
              <p className="text-xs text-muted-foreground">Connect your wallet to send a transaction.</p>
            )}
            {isConnected && sendConfig && !isOnBase && (
              <p className="text-xs text-amber-500">Switch to the Base network to continue.</p>
            )}
            {sendErrorMessage && (
              <div className="text-xs text-destructive">{sendErrorMessage}</div>
            )}
            {txError && !sendErrorMessage && (
              <div className="text-xs text-destructive">{txError}</div>
            )}
            {txHash && (
              <div className="text-xs text-muted-foreground">
                Transaction hash:{' '}
                <a
                  href={explorerUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline"
                >
                  {formatHash(txHash)}
                </a>
              </div>
            )}
            {isReceiptSuccess && transactionReceipt && (
              <p className="text-xs text-green-600">
                Confirmed in block {Number(transactionReceipt.blockNumber).toLocaleString()}.
              </p>
            )}
            {receiptErrorMessage && (
              <div className="text-xs text-destructive">{receiptErrorMessage}</div>
            )}
            {serverStatus === 'success' && (
              <p className="text-xs text-green-600">Server sync complete.</p>
            )}
            {serverStatus === 'error' && serverError && (
              <div className="text-xs text-destructive">{serverError}</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={votingDialogOpen} onOpenChange={setVotingDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Vote className="h-5 w-5" />
              Allocation Vote
            </DialogTitle>
            <DialogDescription>Eligible depositors can vote once and update their choice at any time.</DialogDescription>
          </DialogHeader>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading voting...</p>}>
            <VotingSection />
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
  )
}

export default App
