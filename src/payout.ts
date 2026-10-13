import type { TransactionOrder } from './orders'

export type PayoutResponse = {
  ok: boolean
  order: TransactionOrder
  error?: string
  details?: unknown
}

export async function requestPayout(orderId: string): Promise<PayoutResponse> {
  const baseUrl = import.meta.env.VITE_PAYOUT_URL || '/api/orders'
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(orderId)}/payout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Payout request failed (${response.status})`)
  return payload
}
