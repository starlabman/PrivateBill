export const TRANSACTION_STATUSES = [
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

export const VALID_TRANSITIONS = {
  CREATED: ['AWAITING_ZEC', 'CANCELLED'],
  AWAITING_ZEC: ['ZEC_DETECTED', 'UNDERPAID', 'OVERPAID', 'EXPIRED', 'CANCELLED'],
  ZEC_DETECTED: ['CONFIRMING', 'UNDERPAID', 'OVERPAID', 'EXPIRED', 'CANCELLED'],
  CONFIRMING: ['ZEC_CONFIRMED', 'UNDERPAID', 'OVERPAID', 'EXPIRED', 'CANCELLED'],
  ZEC_CONFIRMED: ['PAYOUT_PROCESSING'],
  PAYOUT_PROCESSING: ['FIAT_SENT', 'PAYOUT_FAILED'],
  FIAT_SENT: ['COMPLETED'],
  COMPLETED: [],
  EXPIRED: [],
  UNDERPAID: ['ZEC_DETECTED', 'CONFIRMING', 'EXPIRED', 'CANCELLED'],
  OVERPAID: ['ZEC_DETECTED', 'CONFIRMING', 'CANCELLED'],
  PAYOUT_FAILED: ['PAYOUT_PROCESSING', 'CANCELLED'],
  CANCELLED: []
}

export function isValidStatus(status) {
  return TRANSACTION_STATUSES.includes(status)
}

export function canTransition(from, to) {
  return isValidStatus(from) && isValidStatus(to) && VALID_TRANSITIONS[from].includes(to)
}

export function assertValidTransition(from, to) {
  if (!isValidStatus(from)) throw new Error(`Unknown current transaction status: ${from}`)
  if (!isValidStatus(to)) throw new Error(`Unknown target transaction status: ${to}`)
  if (!canTransition(from, to)) throw new Error(`Invalid transaction status transition: ${from} -> ${to}`)
}
