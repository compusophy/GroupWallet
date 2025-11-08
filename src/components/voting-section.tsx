'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

import { Button } from '@/components/ui/button'
import { createVoteMessage, VOTE_PROPOSAL_ID, type VoteOption } from '@/lib/voting'

type VoteRecord = {
  address: string
  choice: VoteOption
  weight: number
  depositValueWei: string
  depositValueEth: string
  timestamp: number
}

type VoteTotals = {
  yes: number
  no: number
  totalWeight: number
  totalVoters: number
}

type VoteResponse = {
  ok: boolean
  proposalId: string
  totals: VoteTotals
  votes: VoteRecord[]
  userVote: VoteRecord | null
  eligibility?: {
    isEligible: boolean
    depositValueWei: string
    depositValueEth: string
  }
  error?: string
}

function formatPercentage(value: number) {
  if (!Number.isFinite(value)) return '0%'
  const clamped = Math.max(0, Math.min(value, 1))
  return `${(clamped * 100).toFixed(2)}%`
}

function formatEthValue(value: string) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return '0.0000'
  if (parsed >= 1) {
    return parsed.toLocaleString(undefined, { maximumFractionDigits: 4 })
  }
  return parsed.toFixed(4)
}

function VotingSectionContent() {
  const account = useAccount()
  const { signMessageAsync, isPending: isSigning } = useSignMessage()

  const [data, setData] = useState<VoteResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const loadingRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  const loadVotes = useCallback(
    async (address?: string) => {
      // Prevent duplicate concurrent requests
      if (loadingRef.current) {
        return
      }

      // Cancel any previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      loadingRef.current = true
      setLoading(true)
      setError(null)

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        const params = address ? `?address=${encodeURIComponent(address)}` : ''
        const response = await fetch(`/api/vote${params}`, { 
          cache: 'no-store',
          signal: abortController.signal
        })
        if (!response.ok) {
          throw new Error('Failed to load vote data')
        }
        const json = (await response.json()) as VoteResponse
        setData(json)
      } catch (err: any) {
        // Don't set error if request was aborted
        if (err?.name !== 'AbortError') {
          console.error('Failed to load vote data', err)
          setError('Unable to load vote data')
        }
      } finally {
        loadingRef.current = false
        setLoading(false)
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null
        }
      }
    },
    []
  )

  useEffect(() => {
    void loadVotes(account.address)
    
    // Cleanup: cancel request on unmount or address change
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
      loadingRef.current = false
    }
  }, [account.address, loadVotes])

  // Listen for deposit confirmation events to refresh eligibility
  useEffect(() => {
    const handleDepositConfirmed = () => {
      void loadVotes(account.address)
    }
    window.addEventListener('deposit-confirmed', handleDepositConfirmed)
    return () => {
      window.removeEventListener('deposit-confirmed', handleDepositConfirmed)
    }
  }, [account.address, loadVotes])

  const isConnected = account.status === 'connected' && Boolean(account.address)
  const userVote = data?.userVote ?? null
  const isEligible = data?.eligibility?.isEligible ?? false
  const canVote = isConnected && isEligible && !submitting && !isSigning
  const hasVotedYes = userVote?.choice === 'yes'
  const hasVotedNo = userVote?.choice === 'no'

  const yesShare = useMemo(() => {
    if (!data?.totals) return 0
    const { yes, totalWeight } = data.totals
    if (totalWeight === 0) return 0
    return yes / totalWeight
  }, [data])

  const noShare = useMemo(() => {
    if (!data?.totals) return 0
    const { no, totalWeight } = data.totals
    if (totalWeight === 0) return 0
    return no / totalWeight
  }, [data])

  const handleVote = async (choice: VoteOption) => {
    if (!isConnected || !account.address) {
      setError('Connect your wallet to vote.')
      return
    }

    if (!isEligible) {
      setError('Only depositors are eligible to vote. Make a deposit first.')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const timestamp = Date.now()
      const message = createVoteMessage({
        proposalId: VOTE_PROPOSAL_ID,
        address: account.address,
        choice,
        timestamp,
      })

      const signature = await signMessageAsync({ message })

      const response = await fetch('/api/vote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          address: account.address,
          choice,
          signature,
          timestamp,
        }),
      })

      const json = (await response.json()) as VoteResponse

      if (!response.ok || !json.ok) {
        const message = json.error ?? 'Failed to record vote'
        throw new Error(message)
      }

      setData(json)
      // Reload vote data to ensure we have the latest state
      await loadVotes(account.address)
    } catch (err) {
      console.error('Failed to submit vote', err)
      setError(err instanceof Error ? err.message : 'Failed to submit vote')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
        {!isConnected && (
          <p className="text-sm text-muted-foreground">Connect your wallet to participate in voting.</p>
        )}

        {(loading || submitting || isSigning) && (
          <p className="text-sm text-muted-foreground">{loading ? 'Loading votes...' : 'Submitting vote...'}</p>
        )}

        {error && <div className="text-sm text-destructive">{error}</div>}

        {!loading && !error && (
          <>
            {isConnected && !isEligible && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-600">
                Only depositors are eligible to vote. Make a deposit first to participate.
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <Button
                variant={hasVotedYes ? 'default' : 'outline'}
                className="w-full"
                disabled={!canVote || hasVotedYes}
                onClick={() => handleVote('yes')}
              >
                {hasVotedYes ? 'Voted Yes' : userVote ? 'Change to Yes' : 'Vote Yes'}
              </Button>
              <Button
                variant={hasVotedNo ? 'default' : 'outline'}
                className="w-full"
                disabled={!canVote || hasVotedNo}
                onClick={() => handleVote('no')}
              >
                {hasVotedNo ? 'Voted No' : userVote ? 'Change to No' : 'Vote No'}
              </Button>
            </div>

            {userVote && (
              <p className="text-xs text-muted-foreground">
                Your vote: <span className="font-semibold uppercase">{userVote.choice}</span> · Voting power:{' '}
                {formatPercentage(userVote.weight)} (based on {formatEthValue(userVote.depositValueEth)} ETH deposited)
              </p>
            )}

            {data && (
              <div className="rounded-lg border border-border p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Yes</span>
                  <span className="text-sm font-semibold">{formatPercentage(yesShare)}</span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-green-500"
                    style={{ width: `${Math.min(yesShare * 100, 100)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">No</span>
                  <span className="text-sm font-semibold">{formatPercentage(noShare)}</span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-red-500"
                    style={{ width: `${Math.min(noShare * 100, 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Total voting power engaged: {formatPercentage(data.totals.totalWeight || 0)} · Voters:{' '}
                  {data.totals.totalVoters.toLocaleString()}
                </p>
              </div>
            )}
          </>
        )}
    </div>
  )
}

export function VotingSection() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <p className="text-sm text-muted-foreground">Loading...</p>
  }

  return <VotingSectionContent />
}

