import type { TransactionOrder } from './orders'
import type { TransactionStatus } from './status-engine.ts'

export type PaymentState = TransactionStatus

export type NodeName = 'zebra' | 'zakura' | 'zallet'
export type NetworkName = 'mainnet' | 'testnet' | 'regtest'

export type DetectedPayment = {
  txid: string
  amountZec: number
  confirmations: number
  requiredConfirmations: number
  detectedAt?: string
  address: string
  blockHeight?: number | null
  simulated?: boolean
}

export type PaymentCheck = {
  state: PaymentState
  payment: DetectedPayment | null
  checkedAt: string
  simulated?: boolean
  source: NodeName | 'unavailable'
  network: NetworkName
  error?: string
  errorCode?: string
  nodeErrors?: Array<{ node: string; error: string }>
  retryable?: boolean
  statusHistory?: TransactionOrder['statusHistory']
  statusTimestamps?: TransactionOrder['statusTimestamps']
}

export interface PaymentMonitor {
  check(order: TransactionOrder): Promise<PaymentCheck>
}

export class BackendPaymentMonitor implements PaymentMonitor {
  constructor(private readonly baseUrl = import.meta.env.VITE_PAYMENT_MONITOR_URL || '/api/payment-monitor') {}

  async check(order: TransactionOrder): Promise<PaymentCheck> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(order.id)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    const data = await response.json() as Partial<PaymentCheck>
    if (!response.ok && response.status !== 503) {
      throw new Error(data.error || `Payment monitor returned ${response.status}`)
    }
    const validStates: PaymentState[] = ['CREATED', 'AWAITING_ZEC', 'ZEC_DETECTED', 'CONFIRMING', 'ZEC_CONFIRMED', 'PAYOUT_PROCESSING', 'FIAT_SENT', 'COMPLETED', 'EXPIRED', 'UNDERPAID', 'OVERPAID', 'PAYOUT_FAILED', 'CANCELLED']
    if (!data.state || !validStates.includes(data.state)) throw new Error('Payment monitor returned an invalid state.')
    return {
      state: data.state,
      payment: data.payment ?? null,
      checkedAt: data.checkedAt ?? new Date().toISOString(),
      simulated: data.simulated === true || data.payment?.simulated === true,
      source: data.source === 'zebra' || data.source === 'zakura' || data.source === 'zallet' ? data.source : 'unavailable',
      network: data.network === 'mainnet' || data.network === 'regtest' ? data.network : 'testnet',
      error: data.error,
      errorCode: data.errorCode,
      retryable: data.retryable,
      statusHistory: data.statusHistory,
      statusTimestamps: data.statusTimestamps,
    }
  }
}

export function paymentStatusLabel(state: PaymentState | TransactionOrder['status']) {
  const labels: Record<PaymentState, string> = {
    CREATED: 'Transaction created',
    AWAITING_ZEC: 'Awaiting ZEC',
    ZEC_DETECTED: 'ZEC detected',
    CONFIRMING: 'Confirming on-chain',
    ZEC_CONFIRMED: 'ZEC confirmed',
    PAYOUT_PROCESSING: 'Payout processing',
    FIAT_SENT: 'Fiat sent',
    COMPLETED: 'Completed',
    EXPIRED: 'Order expired',
    UNDERPAID: 'Payment underpaid',
    OVERPAID: 'Payment overpaid',
    PAYOUT_FAILED: 'Payout failed',
    CANCELLED: 'Transaction cancelled',
  }
  return labels[state as PaymentState] ?? 'Transaction status'
}
