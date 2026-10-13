import fs from 'node:fs/promises'
import path from 'node:path'
import { assertValidTransition, isValidStatus } from './status-engine.mjs'

function now() { return new Date().toISOString() }

function migrateStatus(status) {
  const map = {
    PAYMENT_DETECTED: 'ZEC_DETECTED',
    PAYMENT_UNDERPAID: 'UNDERPAID',
    COMPLETED: 'ZEC_CONFIRMED',
  }
  return map[status] ?? status
}

function normalizeOrder(order) {
  const createdAt = order.createdAt || now()
  const migratedStatus = migrateStatus(order.status || 'CREATED')
  const status = isValidStatus(migratedStatus) ? migratedStatus : 'CREATED'
  const history = Array.isArray(order.statusHistory) && order.statusHistory.length
    ? order.statusHistory
    : [{ from: null, to: status, at: createdAt, reason: 'Initial transaction status' }]
  const timestamps = order.statusTimestamps && typeof order.statusTimestamps === 'object'
    ? order.statusTimestamps
    : { [status]: history[history.length - 1]?.at || createdAt }

  return {
    ...order,
    status,
    createdAt,
    statusHistory: history,
    statusTimestamps: timestamps,
  }
}

export class JsonStore {
  constructor(file) {
    this.file = path.resolve(file)
    this.data = { orders: {}, processedPayments: {} }
    this.writeQueue = Promise.resolve()
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.data = {
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
        processedPayments: parsed.processedPayments && typeof parsed.processedPayments === 'object' ? parsed.processedPayments : {}
      }
      let changed = false
      for (const [id, rawOrder] of Object.entries(this.data.orders)) {
        const normalized = normalizeOrder(rawOrder)
        if (JSON.stringify(normalized) !== JSON.stringify(rawOrder)) {
          this.data.orders[id] = normalized
          changed = true
        }
      }
      if (changed) await this.save()
    } catch {
      await this.save()
    }
  }

  async save() {
    const snapshot = JSON.stringify(this.data, null, 2)
    const write = this.writeQueue.then(() => fs.writeFile(this.file, snapshot))
    this.writeQueue = write.catch(() => {})
    await write
  }
  getOrder(id) { return this.data.orders[id] ?? null }
  listOrders() { return Object.values(this.data.orders) }

  getAvailableDepositAddress(addressPool) {
    const used = new Set(this.listOrders().map(order => order.depositAddress).filter(Boolean))
    return addressPool.find(address => !used.has(address)) ?? null
  }
  getNextDepositAddressIndex(startAt = 0) {
    const nextStored = this.listOrders()
      .map(order => Number(order.depositAddressIndex))
      .filter(index => Number.isSafeInteger(index) && index >= 0)
      .reduce((next, index) => Math.max(next, index + 1), 0)
    return Math.max(Number.isSafeInteger(startAt) && startAt >= 0 ? startAt : 0, nextStored)
  }
  async createOrder(order) {
    if (this.getOrder(order.id)) throw new Error('Order already exists')
    const createdAt = order.createdAt || now()
    const normalized = {
      ...order,
      status: 'CREATED',
      createdAt,
      statusHistory: [{ from: null, to: 'CREATED', at: createdAt, reason: 'Transaction created' }],
      statusTimestamps: { CREATED: createdAt }
    }
    this.data.orders[order.id] = normalized
    await this.save()
    return normalized
  }

  async updateOrder(id, patch) {
    const order = this.getOrder(id)
    if (!order) throw new Error('Order not found')
    Object.assign(order, patch)
    await this.save()
    return order
  }

  async transitionOrder(id, to, reason = 'Status updated') {
    const order = this.getOrder(id)
    if (!order) throw new Error('Order not found')
    assertValidTransition(order.status, to)
    const at = now()
    const from = order.status
    order.status = to
    order.statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : []
    order.statusHistory.push({ from, to, at, reason })
    order.statusTimestamps = { ...(order.statusTimestamps || {}), [to]: at }
    await this.save()
    return order
  }


  async recordError(id, error) {
    const order = this.getOrder(id)
    if (!order) throw new Error('Order not found')
    const at = error.at || now()
    order.lastError = { ...error, at }
    order.errorHistory = Array.isArray(order.errorHistory) ? order.errorHistory : []
    const previous = order.errorHistory[order.errorHistory.length - 1]
    if (!previous || previous.code !== order.lastError.code || previous.message !== order.lastError.message) {
      order.errorHistory.push(order.lastError)
    }
    if (order.errorHistory.length > 20) order.errorHistory = order.errorHistory.slice(-20)
    await this.save()
    return order
  }

  async clearError(id) {
    const order = this.getOrder(id)
    if (!order) throw new Error('Order not found')
    if (order.lastError) {
      order.lastError = null
      await this.save()
    }
    return order
  }

  hasProcessed(key) { return Boolean(this.data.processedPayments[key]) }

  hasPayoutAttempt(orderId, attemptId) {
    const order = this.getOrder(orderId)
    return Boolean(order?.payout?.attempts?.some(attempt => attempt.attemptId === attemptId))
  }

  async recordPayoutAttempt(orderId, attempt) {
    const order = this.getOrder(orderId)
    if (!order) throw new Error('Order not found')
    order.payout = order.payout || {
      currency: order.fiatCurrency,
      amount: Number(order.fiatAmount),
      provider: attempt.provider,
      status: attempt.status,
      attempts: [],
      createdAt: now(),
      updatedAt: now()
    }
    order.payout.attempts = Array.isArray(order.payout.attempts) ? order.payout.attempts : []
    const existingIndex = order.payout.attempts.findIndex(item => item.attemptId === attempt.attemptId)
    if (existingIndex >= 0) {
      order.payout.attempts[existingIndex] = { ...order.payout.attempts[existingIndex], ...attempt }
    } else {
      order.payout.attempts.push(attempt)
    }
    order.payout.status = attempt.status
    order.payout.provider = attempt.provider
    if (attempt.providerReference) order.payout.providerReference = attempt.providerReference
    order.payout.updatedAt = now()
    await this.save()
    return order
  }

  async updatePayout(orderId, patch) {
    const order = this.getOrder(orderId)
    if (!order) throw new Error('Order not found')
    order.payout = { ...(order.payout || {}), ...patch, updatedAt: now() }
    await this.save()
    return order
  }

  async recordPayment(key, payment) {
    if (this.hasProcessed(key)) return false
    this.data.processedPayments[key] = payment
    await this.save()
    return true
  }
}
