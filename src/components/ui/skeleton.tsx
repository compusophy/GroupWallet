'use client'

import * as React from 'react'

type SkeletonProps = React.HTMLAttributes<HTMLDivElement>

export function Skeleton({ className = '', ...props }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded-md bg-muted ${className}`}
      {...props}
    />
  )
}

export function SkeletonText({ className = '' }: { className?: string }) {
  return <Skeleton className={`h-4 ${className}`} />
}

export function SkeletonButton({ className = '' }: { className?: string }) {
  return <Skeleton className={`h-10 ${className}`} />
}

export function SkeletonCard({ className = '' }: { className?: string }) {
  return <Skeleton className={`h-24 ${className}`} />
}


