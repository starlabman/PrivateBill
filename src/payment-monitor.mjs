import { canTransition } from './status-engine.mjs'
import { ERROR_CODES, makeError } from './error-codes.mjs'

export const STATES = [
  'CREATED',
  'AWAITING_ZEC',
  'ZEC_DETECTED',
  'CONFIRMING',
  'ZEC_CONFIRMED',
  'PAYOUT_PROCESSING',
  'FIAT_SENT',
  'COMPLETED',
  'EXPIRED',
  'UNDERPAID',
  'OVERPAID',
  'PAYOUT_FAILED',
  'CANCELLED'
]

const EPSILON = 1e-12

export function stateFor({ receivedZec, confirmedZec, requiredZec, pendingPayment, expired }) {
  // Once an order expires, never silently accept a late payment as a valid
  // funding event. This prevents a late on-chain payment from moving an order
  // into payout/completed states without an explicit recovery flow.
  if (expired) return 'EXPIRED'
  if (receivedZec <= EPSILON) return 'AWAITING_ZEC'
  if (receivedZec > requiredZec + EPSILON) return 'OVERPAID'
  if (confirmedZec + EPSILON >= requiredZec) return 'ZEC_CONFIRMED'
  if (pendingPayment && receivedZec + EPSILON >= requiredZec) return 'CONFIRMING'
  if (receivedZec + EPSILON < requiredZec) return 'UNDERPAID'
  return 'CONFIRMING'
}

function isPaymentLifecycleStatus(status) {
  return ['CREATED', 'AWAITING_ZEC', 'ZEC_DETECTED', 'CONFIRMING', 'UNDERPAID', 'OVERPAID'].includes(status)
}

async function moveStatus(store, order, desired, reason) {
  if (order.status === desired) return order
  if (!isPaymentLifecycleStatus(order.status)) return order
  if (!canTransition(order.status, desired)) return order
  return store.transitionOrder(order.id, desired, reason)
}

export async function monitorOrder(store, manager, order, requiredConfirmations) {
  const selected = await manager.findPayments(order.depositAddress)
  const relevant = selected.payments
    .filter(payment => payment.address === order.depositAddress)
    .sort((a, b) => (b.blockHeight ?? -1) - (a.blockHeight ?? -1))

  for (const payment of relevant) {
    await store.recordPayment(`${order.id}:${payment.txid}`, {
      orderId: order.id,
      txid: payment.txid,
      amountZec: payment.amountZec,
      confirmations: payment.confirmations,
      address: payment.address,
      detectedAt: new Date().toISOString(),
      node: selected.name
    })
  }

  const receivedZec = relevant.reduce((sum, payment) => sum + Number(payment.amountZec || 0), 0)
  const confirmedZec = relevant
    .filter(payment => Number(payment.confirmations || 0) >= requiredConfirmations)
    .reduce((sum, payment) => sum + Number(payment.amountZec || 0), 0)
  const pendingPayment = relevant.some(payment => Number(payment.confirmations || 0) < requiredConfirmations)
  const latest = relevant[0] ?? null
  const expired = order.expiresAt ? Date.now() > Date.parse(order.expiresAt) : false
  const desired = stateFor({
    receivedZec,
    confirmedZec,
    requiredZec: Number(order.requiredZec),
    pendingPayment,
    requiredConfirmations,
    expired
  })

  let current = store.getOrder(order.id) || order

  // Record the observable detection event before advancing to the more specific
  // payment state. This preserves the required lifecycle:
  // AWAITING_ZEC -> ZEC_DETECTED -> CONFIRMING/ZEC_CONFIRMED/UNDERPAID/OVERPAID.
  if (relevant.length && current.status === 'AWAITING_ZEC') {
    current = await moveStatus(store, current, 'ZEC_DETECTED', 'On-chain ZEC payment detected')
  }

  const transitionReason =
    desired === 'CONFIRMING' ? `Required ZEC received; waiting for ${requiredConfirmations} confirmations`
      : desired === 'ZEC_CONFIRMED' ? `Required ZEC confirmed with ${requiredConfirmations} confirmations`
      : desired === 'UNDERPAID' ? 'Detected ZEC amount is below the required amount'
      : desired === 'OVERPAID' ? 'Detected ZEC amount exceeds the required amount'
      : desired === 'EXPIRED' ? 'Order expired without a payment'
      : 'Payment status updated'

  if (desired === 'ZEC_CONFIRMED' && ['UNDERPAID', 'OVERPAID'].includes(current.status)) {
    current = await moveStatus(store, current, 'ZEC_DETECTED', 'Required amount is now available; resuming confirmation')
  }

  if (desired === 'ZEC_CONFIRMED' && current.status === 'ZEC_DETECTED') {
    current = await moveStatus(
      store,
      current,
      'CONFIRMING',
      `Required ZEC received; waiting for ${requiredConfirmations} confirmations`
    )
  }
  current = await moveStatus(store, current, desired, transitionReason)

  // A detected payment with insufficient confirmations is explicitly CONFIRMING.
  // A payment below the required amount is UNDERPAID until another payment is observed.
  // ZEC_CONFIRMED is intentionally not COMPLETED: payout states belong to later quests.

  const status = current.status
  const error = status === 'UNDERPAID'
    ? makeError(ERROR_CODES.UNDERPAYMENT, `Received ${receivedZec.toFixed(6)} ZEC, but ${Number(order.requiredZec).toFixed(6)} ZEC is required.`, { retryable: true })
    : status === 'OVERPAID'
      ? makeError(ERROR_CODES.OVERPAYMENT, `Received ${receivedZec.toFixed(6)} ZEC, which is more than the required ${Number(order.requiredZec).toFixed(6)} ZEC.`, { retryable: false })
      : status === 'EXPIRED'
        ? makeError(ERROR_CODES.TRANSACTION_EXPIRED, 'This transaction expired before valid funding was confirmed.', { retryable: false })
        : null
  if (error) await store.recordError(order.id, error)
  else if (status !== 'PAYOUT_FAILED' && status !== 'CANCELLED') await store.clearError(order.id)

  await store.updateOrder(order.id, {
    payment: latest
      ? {
          txid: latest.txid,
          receivedZec,
          confirmedZec,
          confirmations: latest.confirmations,
          requiredConfirmations,
          detectedAt: new Date().toISOString(),
          address: latest.address,
          node: selected.name
        }
      : current.payment
  })

  return {
    state: status,
    payment: latest
      ? {
          ...latest,
          amountZec: receivedZec,
          confirmedZec,
          requiredConfirmations,
          detectedAt: current.payment?.detectedAt ?? new Date().toISOString()
        }
      : null,
    checkedAt: new Date().toISOString(),
    source: selected.name,
    network: manager.network,
    statusHistory: current.statusHistory,
    statusTimestamps: current.statusTimestamps,
    nodeErrors: selected.errors.length ? selected.errors : undefined,
    errorCode: status === 'UNDERPAID' ? ERROR_CODES.UNDERPAYMENT : status === 'OVERPAID' ? ERROR_CODES.OVERPAYMENT : status === 'EXPIRED' ? ERROR_CODES.TRANSACTION_EXPIRED : status === 'AWAITING_ZEC' ? ERROR_CODES.PAYMENT_NOT_DETECTED : undefined,
    retryable: status === 'UNDERPAID' || status === 'AWAITING_ZEC',
    error: status === 'AWAITING_ZEC' ? makeError(ERROR_CODES.PAYMENT_NOT_DETECTED, 'No qualifying ZEC payment has been detected yet.', { retryable: true }).message
      : status === 'UNDERPAID' ? makeError(ERROR_CODES.UNDERPAYMENT, `Received ${receivedZec.toFixed(6)} ZEC, but ${Number(order.requiredZec).toFixed(6)} ZEC is required.`, { retryable: true }).message
      : status === 'OVERPAID' ? makeError(ERROR_CODES.OVERPAYMENT, `Received ${receivedZec.toFixed(6)} ZEC, which is more than the required ${Number(order.requiredZec).toFixed(6)} ZEC.`, { retryable: false }).message
      : status === 'EXPIRED' ? makeError(ERROR_CODES.TRANSACTION_EXPIRED, 'This transaction expired before valid funding was confirmed.', { retryable: false }).message
      : undefined
  }
}
