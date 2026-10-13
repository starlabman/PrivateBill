import type { TransactionOrder } from './orders'
import { CORE_STATUS_FLOW, STATUS_LABELS, type TransactionStatus } from './status-engine.ts'

export type TransactionTracking = {
  id: string
  status: TransactionStatus
  statusHistory: NonNullable<TransactionOrder['statusHistory']>
  statusTimestamps: NonNullable<TransactionOrder['statusTimestamps']>
  lastError?: TransactionOrder['lastError']
  payment: NonNullable<TransactionOrder['payment']> | null
}

export async function fetchTransactionTracking(orderId: string): Promise<TransactionTracking> {
  const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, { cache: 'no-store' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Unable to load transaction status (${response.status})`)
  if (!payload.id || !payload.status) throw new Error('Transaction status response is incomplete.')
  return {
    id: payload.id,
    status: payload.status as TransactionStatus,
    statusHistory: payload.statusHistory || [],
    statusTimestamps: payload.statusTimestamps || {},
    lastError: payload.lastError || null,
    payment: payload.payment ?? null,
  }
}

export function getTrackingStages(status: TransactionStatus) {
  const currentIndex = CORE_STATUS_FLOW.indexOf(status)
  return CORE_STATUS_FLOW.slice(1).map(stage => ({
    status: stage,
    label: STATUS_LABELS[stage],
    done: currentIndex >= 0 && CORE_STATUS_FLOW.indexOf(stage) < currentIndex,
    current: stage === status,
  }))
}
