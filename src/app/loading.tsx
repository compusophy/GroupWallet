import { Skeleton } from '@/components/ui/skeleton'

export default function Loading() {
  return (
    <div className="min-h-screen relative">
      <div className="fixed top-4 md:top-8 left-1/2 -translate-x-1/2 z-50 h-10 flex items-center">
        <Skeleton className="h-8 w-40" />
      </div>

      <div className="pt-20 md:pt-28 px-4 md:px-8 pb-32">
        <div className="mx-auto max-w-5xl space-y-8">
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="text-center">
              <Skeleton className="mx-auto h-7 w-48" />
            </div>
            <div className="flex items-center justify-center gap-2">
              <Skeleton className="h-6 w-44" />
              <Skeleton className="h-6 w-6 rounded-md" />
              <Skeleton className="h-6 w-6 rounded-md" />
            </div>
            <div className="flex gap-1 w-full">
              <div className="rounded-md border-2 px-2 py-3 text-xs" style={{ width: '34%' }}>
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-3 w-1/2 mt-2" />
              </div>
              <div className="rounded-md border-2 px-2 py-3 text-xs" style={{ width: '22%' }}>
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-1/2 mt-2" />
              </div>
              <div className="rounded-md border-2 px-2 py-3 text-xs" style={{ width: '16%' }}>
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2 mt-2" />
              </div>
              <div className="rounded-md border-2 px-2 py-3 text-xs" style={{ width: '12%' }}>
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2 mt-2" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


