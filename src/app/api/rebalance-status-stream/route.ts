import { NextRequest } from 'next/server'
import { isRebalanceProcessing, isSettlementProcessing, isAnyOperationProcessing } from '@/lib/jobs'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  // Set up Server-Sent Events
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let intervalId: NodeJS.Timeout | null = null
      let isClosed = false

      const send = (data: object) => {
        if (isClosed) {
          return // Don't try to send if stream is already closed
        }
        try {
          const message = `data: ${JSON.stringify(data)}\n\n`
          controller.enqueue(encoder.encode(message))
        } catch (error) {
          // If controller is closed, mark as closed and stop trying to send
          if (error instanceof Error && error.message.includes('closed')) {
            isClosed = true
            cleanup()
          } else {
            console.error('Error sending SSE message', error)
          }
        }
      }

      const cleanup = () => {
        if (intervalId) {
          clearInterval(intervalId)
          intervalId = null
        }
        isClosed = true
      }

      // Send initial status
      try {
        const processing = await isAnyOperationProcessing()
        send({ ok: true, processing })
      } catch (error) {
        console.error('Error getting initial operation status', error)
        send({ ok: false, error: 'Failed to check operation status' })
        cleanup()
        if (!isClosed) {
          try {
            controller.close()
          } catch (closeError) {
            // Ignore errors on close
          }
        }
        return
      }

      // Poll Redis for changes (check every 200ms for faster updates)
      // Check for both rebalance and settlement processing
      let lastStatus = await isAnyOperationProcessing()
      intervalId = setInterval(async () => {
        if (isClosed) {
          cleanup()
          return
        }
        try {
          const currentStatus = await isAnyOperationProcessing()
          if (currentStatus !== lastStatus) {
            lastStatus = currentStatus
            send({ ok: true, processing: currentStatus })
          }
        } catch (error) {
          console.error('Error checking operation status in stream', error)
          // Don't close on error, just log it
        }
      }, 200) // Check every 200ms for faster detection

      // Clean up on client disconnect
      request.signal.addEventListener('abort', () => {
        cleanup()
        if (!isClosed) {
          try {
            controller.close()
          } catch (error) {
            // Ignore errors on close
          }
        }
      })
    },
    cancel() {
      // Stream cancellation handled in abort listener
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable buffering for nginx
    },
  })
}

