import type { Currency } from './conversion'
import type { TransactionStatus } from './status-engine.ts'

export type OrderStatus = TransactionStatus

export type RecipientPaymentInfo = {
  providerName: string
  providerCode: string
  providerType: string
  accountNumber: string
  accountName: string
  country: string
  currency: Currency
}

export type TransactionOrder = {
  id: string
  fiatCurrency: Currency
  fiatAmount: number
  requiredZec: number
  recipient: RecipientPaymentInfo
  status: OrderStatus
  statusHistory?: Array<{ from: OrderStatus | null; to: OrderStatus; at: string; reason: string }>
  statusTimestamps?: Partial<Record<OrderStatus, string>>
  createdAt: string
  expiresAt: string
  depositAddress?: string
  depositAddressIndex?: number
  depositAddressMode?: 'unique' | 'shared-demo'
  network?: 'mainnet' | 'testnet' | 'regtest'
  payout?: {
    currency: 'NGN' | 'GHS'
    amount: number
    provider: string
    status: 'PROCESSING' | 'SENT' | 'FAILED'
    providerReference?: string
    lastAttemptId?: string
    sentAt?: string
    failedAt?: string
    error?: string
    attempts: Array<{
      attemptId: string
      provider: string
      providerReference?: string
      status: 'PROCESSING' | 'SENT' | 'FAILED'
      requestedAt: string
      completedAt?: string
      error?: string
      recipient: RecipientPaymentInfo
    }>
    createdAt: string
    updatedAt: string
  }
  lastError?: { code: string; message: string; retryable: boolean; at: string; details?: unknown } | null
  errorHistory?: Array<{ code: string; message: string; retryable: boolean; at: string; details?: unknown }>
  payment?: {
    txid: string
    receivedZec: number
    confirmations: number
    requiredConfirmations: number
    detectedAt: string
    address?: string
    simulated?: boolean
  }
}

const STORAGE_KEY = 'private-bill:orders:v1'
const ORDER_TTL_MS = 30 * 60 * 1000

function createOrderId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `PB-${uuid.replace(/-/g, '').slice(0, 16).toUpperCase()}`
  return `PB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

function readOrders(): TransactionOrder[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeOrders(orders: TransactionOrder[]) {
  const maskRecipient = (recipient: TransactionOrder['recipient']) => ({
    ...recipient,
    accountNumber: `•••• ${recipient.accountNumber.replace(/\s/g, '').slice(-4)}`
  })
  const privacySafeOrders = orders.slice(-25).map(order => ({
    ...order,
    recipient: maskRecipient(order.recipient),
    ...(order.payout ? {
      payout: {
        ...order.payout,
        attempts: order.payout.attempts.map(attempt => ({ ...attempt, recipient: maskRecipient(attempt.recipient) }))
      }
    } : {})
  }))
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(privacySafeOrders))
}

export function createTransactionOrder(input: Omit<TransactionOrder, 'id' | 'status' | 'createdAt' | 'expiresAt'>): TransactionOrder {
  const createdAt = new Date()
  const order: TransactionOrder = {
    ...input,
    id: createOrderId(),
    status: 'AWAITING_ZEC',
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ORDER_TTL_MS).toISOString(),
  }

  return order
}

export function persistTransactionOrder(order: TransactionOrder) {
  const orders = readOrders().filter(existing => existing.id !== order.id)
  writeOrders([...orders, order])
  return order
}

export function getMostRecentTransactionOrder() {
  const orders = readOrders()
  if (!orders.length) return null
  const latest = orders[orders.length - 1]
  writeOrders(orders)
  return latest
}

export function getTransactionOrder(id: string) {
  return readOrders().find(order => order.id === id) ?? null
}

export function listTransactionOrders() {
  return readOrders()
}

export function updateTransactionPayment(id: string, payment: NonNullable<TransactionOrder['payment']>, status: OrderStatus) {
  const orders = readOrders()
  const index = orders.findIndex(order => order.id === id)
  if (index < 0) return null

  const existing = orders[index]
  // Idempotency: do not replace an already-recorded payment with a different
  // observation unless the same txid is being updated with newer confirmations.
  if (existing.payment && existing.payment.txid !== payment.txid) return existing

  const updated = { ...existing, payment, status }
  orders[index] = updated
  writeOrders(orders)
  return updated
}

export function syncTransactionStatus(
  id: string,
  status: OrderStatus,
  statusHistory?: TransactionOrder['statusHistory'],
  statusTimestamps?: TransactionOrder['statusTimestamps'],
) {
  const orders = readOrders()
  const index = orders.findIndex(order => order.id === id)
  if (index < 0) return null
  const updated = {
    ...orders[index],
    status,
    ...(statusHistory ? { statusHistory } : {}),
    ...(statusTimestamps ? { statusTimestamps } : {}),
  }
  orders[index] = updated
  writeOrders(orders)
  return updated
}
