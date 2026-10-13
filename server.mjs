import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonStore } from './src/store.mjs'
import { createNodeManager } from './src/node-manager.mjs'
import { monitorOrder } from './src/payment-monitor.mjs'
import { TRANSACTION_STATUSES, isValidStatus } from './src/status-engine.mjs'
import { createPayoutProvider } from './src/payout-service.mjs'
import { ERROR_CODES, makeError } from './src/error-codes.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
try {
  process.loadEnvFile(path.join(root, '.env'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const PORT = Number(process.env.PORT || 8787)
const DB = process.env.PRIVATE_BILL_DB || path.join(root, 'data/private-bill.json')
const CONFIRMATIONS = Number(process.env.ZCASH_REQUIRED_CONFIRMATIONS || 3)
const ACTIVE_NETWORK = (process.env.PRIVATE_BILL_NETWORK || 'testnet').toLowerCase()
const PAYMENT_SIMULATION_ENABLED = process.env.NODE_ENV !== 'production'
  && process.env.PRIVATE_BILL_ENABLE_PAYMENT_SIMULATION !== 'false'
  && ACTIVE_NETWORK !== 'mainnet'
const store = new JsonStore(DB)
await store.init()
const nodeManager = createNodeManager()
const payoutLocks = new Set()
let orderCreationQueue = Promise.resolve()
let paymentSweepRunning = false

async function monitorOpenOrders() {
  if (!process.env.ZALLET_RPC_URL || paymentSweepRunning) return
  paymentSweepRunning = true
  try {
    const activeOrders = store.listOrders().filter(order =>
      ['CREATED', 'AWAITING_ZEC', 'ZEC_DETECTED', 'CONFIRMING', 'UNDERPAID', 'OVERPAID'].includes(order.status)
    )
    for (const order of activeOrders) {
      try { await monitorOrder(store, nodeManager, order, CONFIRMATIONS) } catch {}
    }
  } finally {
    paymentSweepRunning = false
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization'
  })
  res.end(JSON.stringify(body))
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function isStatusAdmin(req) {
  const configured = Buffer.from(process.env.PRIVATE_BILL_STATUS_ADMIN_TOKEN || '')
  const suppliedToken = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || ''
  const supplied = Buffer.from(suppliedToken)
  return configured.length > 0 && configured.length === supplied.length && crypto.timingSafeEqual(configured, supplied)
}

function validateOrder(input) {
  for (const key of ['id', 'fiatCurrency', 'fiatAmount', 'requiredZec', 'recipient']) {
    if (!input[key]) throw new Error(`Missing order field: ${key}`)
  }
  if (!['NGN', 'GHS'].includes(input.fiatCurrency)) throw new Error('Unsupported fiat currency')
  if (!Number.isFinite(Number(input.fiatAmount)) || Number(input.fiatAmount) <= 0) throw new Error('fiatAmount must be positive')
  if (!Number.isFinite(Number(input.requiredZec)) || Number(input.requiredZec) <= 0) throw new Error('requiredZec must be positive')
  const r = input.recipient
  if (!r || typeof r !== 'object') throw new Error('recipient information is required')
  for (const key of ['providerName', 'providerCode', 'accountNumber', 'accountName', 'country', 'currency']) {
    if (!String(r[key] ?? '').trim()) throw new Error(`Invalid recipient information: ${key}`)
  }
  if (!['NGN', 'GHS'].includes(r.currency) || r.currency !== input.fiatCurrency) throw new Error('Recipient currency does not match payout currency')
  if (r.country !== (input.fiatCurrency === 'NGN' ? 'Nigeria' : 'Ghana')) throw new Error('Recipient country does not match payout currency')
  if (!/^[A-Za-z0-9\- ]{6,20}$/.test(String(r.accountNumber).trim())) throw new Error('Invalid recipient account number')
  if (String(r.accountName).trim().length < 2) throw new Error('Invalid recipient account name')
}

function validateTransitionBody(input) {
  if (!input || typeof input.status !== 'string' || !isValidStatus(input.status)) {
    throw new Error(`status must be one of: ${TRANSACTION_STATUSES.join(', ')}`)
  }
  const reason = input.reason == null ? 'Status updated by system' : String(input.reason).trim()
  if (reason.length > 240) throw new Error('reason must be 240 characters or fewer')
  return { status: input.status, reason: reason || 'Status updated by system' }
}

async function routes(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'OPTIONS') return json(res, 204, {})

  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, {
        network: nodeManager.network,
        nodePreference: nodeManager.preference,
        requiredConfirmations: CONFIRMATIONS,
        paymentSimulationEnabled: PAYMENT_SIMULATION_ENABLED,
        statuses: TRANSACTION_STATUSES
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      try {
        const node = await nodeManager.select()
        return json(res, 200, { ok: true, network: nodeManager.network, selectedNode: node.name })
      } catch (e) {
        return json(res, 503, { ok: false, network: nodeManager.network, error: e.message, details: e.details })
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const input = await body(req)
      try {
        validateOrder(input)
      } catch (e) {
        const invalid = makeError(ERROR_CODES.INVALID_RECIPIENT, e.message, { retryable: false })
        return json(res, 422, { ok: false, error: invalid.message, errorCode: invalid.code, retryable: invalid.retryable })
      }
      const createOrder = async () => {
        let depositAddress
        let depositAddressIndex
        if (process.env.ZALLET_RPC_URL) {
          const generated = await nodeManager.createDepositAddress(store.getNextDepositAddressIndex())
          depositAddress = generated.address
          depositAddressIndex = generated.diversifierIndex
        } else {
          const addressPool = [...new Set((process.env.PRIVATE_BILL_DEPOSIT_ADDRESS_POOL || '').split(',').map(address => address.trim()).filter(Boolean))]
          depositAddress = store.getAvailableDepositAddress(addressPool)
          if (depositAddress) {
            // A pool assigns a distinct receiving address to each order.
          } else {
            // Backwards-compatible local demo mode: the supplied project already
            // has a testnet address in .env. Allow the order flow to proceed with
            // it only on a non-production, non-mainnet run. Never use a shared
            // address for production or mainnet orders.
            const legacyDemoAddress = (process.env.PRIVATE_BILL_DEMO_RECEIVING_ADDRESS || process.env.VITE_ZEC_RECEIVING_ADDRESS || '').trim()
            // A deployed production server may explicitly enable a testnet demo.
            // Never allow this shared-address mode on mainnet.
            const demoNetworkAllowed = ['testnet', 'regtest'].includes(ACTIVE_NETWORK)
            const demoModeAllowed = demoNetworkAllowed && (process.env.NODE_ENV !== 'production'
              || process.env.PRIVATE_BILL_ALLOW_SHARED_DEMO_ADDRESS === 'true')
            if (legacyDemoAddress && demoModeAllowed && addressPool.length === 0) {
              depositAddress = legacyDemoAddress
            } else {
              throw new Error(addressPool.length
                ? 'No unused Zcash deposit addresses are available. Configure another unique address or enable Zallet address generation.'
                : 'Zcash deposits are not configured. Configure Zallet, a unique deposit-address pool, or a testnet demo receiving address.')
            }
          }
        }

        const isSharedDemoAddress = !depositAddressIndex
          && !process.env.ZALLET_RPC_URL
          && !(process.env.PRIVATE_BILL_DEPOSIT_ADDRESS_POOL || '').split(',').map(address => address.trim()).filter(Boolean).includes(depositAddress)
        const createdAt = input.createdAt || new Date().toISOString()
        const order = await store.createOrder({
          ...input,
          depositAddress,
          ...(isSharedDemoAddress ? { depositAddressMode: 'shared-demo' } : { depositAddressMode: 'unique' }),
          ...(depositAddressIndex !== undefined ? { depositAddressIndex } : {}),
          network: ACTIVE_NETWORK,
          createdAt,
          expiresAt: input.expiresAt || new Date(Date.now() + 30 * 60 * 1000).toISOString()
        })
        return store.transitionOrder(
          order.id,
          'AWAITING_ZEC',
          'Transaction created and ready to receive ZEC'
        )
      }
      const pendingOrder = orderCreationQueue.then(createOrder, createOrder)
      orderCreationQueue = pendingOrder.then(() => undefined, () => undefined)
      let awaiting
      try {
        awaiting = await pendingOrder
      } catch (error) {
        return json(res, 503, {
          ok: false,
          error: process.env.ZALLET_RPC_URL
            ? 'A private Zcash receiving address could not be issued. No order was created; check the Zallet wallet and try again.'
            : error.message,
          errorCode: 'DEPOSIT_ADDRESS_UNAVAILABLE',
          retryable: true
        })
      }

      return json(res, 201, awaiting)
    }

    const statusMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/status$/)
    if (req.method === 'GET' && statusMatch) {
      const order = store.getOrder(decodeURIComponent(statusMatch[1]))
      if (!order) return json(res, 404, { error: 'Order not found' })
      return json(res, 200, {
        id: order.id,
        status: order.status,
        statusHistory: order.statusHistory || [],
        statusTimestamps: order.statusTimestamps || {},
        payment: order.payment || null,
        lastError: order.lastError || null,
        errorHistory: order.errorHistory || []
      })
    }

    if (req.method === 'POST' && statusMatch) {
      // This endpoint exists for trusted operational tooling and integration
      // checks only. The browser client never needs to set transaction state:
      // on-chain transitions come from the payment monitor. Without a
      // configured secret, keep the mutation route unavailable.
      if (!isStatusAdmin(req)) return json(res, 404, { error: 'Not found' })

      const order = store.getOrder(decodeURIComponent(statusMatch[1]))
      if (!order) return json(res, 404, { error: 'Order not found' })
      const input = validateTransitionBody(await body(req))
      const updated = await store.transitionOrder(order.id, input.status, input.reason)
      return json(res, 200, {
        id: updated.id,
        status: updated.status,
        statusHistory: updated.statusHistory,
        statusTimestamps: updated.statusTimestamps
      })
    }

    const match = url.pathname.match(/^\/api\/payment-monitor\/([^/]+)$/)
    if (req.method === 'GET' && match) {
      const order = store.getOrder(decodeURIComponent(match[1]))
      if (!order) return json(res, 404, { error: 'Order not found' })
      if (order.paymentSimulation) {
        return json(res, 200, {
          state: order.status,
          payment: order.payment ? {
            txid: order.payment.txid,
            amountZec: order.payment.receivedZec,
            confirmations: order.payment.confirmations,
            requiredConfirmations: order.payment.requiredConfirmations,
            address: order.payment.address,
            detectedAt: order.payment.detectedAt,
          } : null,
          checkedAt: new Date().toISOString(),
          source: 'unavailable',
          network: order.network || ACTIVE_NETWORK,
          statusHistory: order.statusHistory || [],
          statusTimestamps: order.statusTimestamps || {},
          simulated: true,
        })
      }
      try {
        if (order.network && order.network !== nodeManager.network) {
          return json(res, 409, {
            error: `Order network ${order.network} does not match active backend network ${nodeManager.network}`
          })
        }
        const result = await monitorOrder(store, nodeManager, order, CONFIRMATIONS)
        return json(res, 200, result)
      } catch (e) {
        const transient = makeError(ERROR_CODES.ZCASH_NETWORK_UNAVAILABLE, 'Zcash node or network is temporarily unavailable. The transaction state was not advanced.', { retryable: true, details: e.details })
        return json(res, 503, {
          state: order.status,
          payment: order.payment ?? null,
          checkedAt: new Date().toISOString(),
          source: 'unavailable',
          network: ACTIVE_NETWORK,
          statusHistory: order.statusHistory || [],
          statusTimestamps: order.statusTimestamps || {},
          error: transient.message,
          errorCode: transient.code,
          retryable: transient.retryable,
          details: e.details
        })
      }
    }

    const simulatePaymentMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/simulate-payment$/)
    if (req.method === 'POST' && simulatePaymentMatch) {
      if (!PAYMENT_SIMULATION_ENABLED) return json(res, 404, { error: 'Not found' })
      const orderId = decodeURIComponent(simulatePaymentMatch[1])
      let order = store.getOrder(orderId)
      if (!order) return json(res, 404, { error: 'Order not found' })
      if (order.status !== 'AWAITING_ZEC' || order.payment) {
        return json(res, 409, { error: `A demo payment cannot be applied while the order is ${order.status}.`, status: order.status })
      }
      const detectedAt = new Date().toISOString()
      const payment = {
        orderId,
        txid: `SIM-${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`,
        amountZec: Number(order.requiredZec),
        confirmations: CONFIRMATIONS,
        address: order.depositAddress,
        detectedAt,
        simulated: true,
      }
      await store.recordPayment(`${order.id}:${payment.txid}`, payment)
      order = await store.transitionOrder(order.id, 'ZEC_DETECTED', 'Simulated ZEC payment for test flow')
      order = await store.transitionOrder(order.id, 'CONFIRMING', `Simulated payment with ${CONFIRMATIONS} confirmations`)
      order = await store.transitionOrder(order.id, 'ZEC_CONFIRMED', `Simulated payment confirmed with ${CONFIRMATIONS} confirmations`)
      await store.updateOrder(order.id, {
        paymentSimulation: true,
        payment: {
          txid: payment.txid,
          receivedZec: payment.amountZec,
          confirmedZec: payment.amountZec,
          confirmations: CONFIRMATIONS,
          requiredConfirmations: CONFIRMATIONS,
          detectedAt,
          address: payment.address,
          simulated: true,
        },
      })
      order = store.getOrder(order.id)
      return json(res, 200, { ok: true, simulated: true, order })
    }

    const cancelMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/)
    if (req.method === 'POST' && cancelMatch) {
      const orderId = decodeURIComponent(cancelMatch[1])
      const order = store.getOrder(orderId)
      if (!order) return json(res, 404, { error: 'Order not found' })
      if (order.payment || !['CREATED', 'AWAITING_ZEC'].includes(order.status)) {
        return json(res, 409, { error: 'Cancellation is available only before payment is detected. ZEC already sent is not refunded automatically; contact the operator for manual recovery.', status: order.status })
      }
      const updated = await store.transitionOrder(orderId, 'CANCELLED', 'Cancelled by user')
      const cancelled = makeError(ERROR_CODES.CANCELLED, 'Order cancelled before a payment was recorded. No fiat payout will be initiated. Any ZEC sent but not detected must be reviewed manually.', { retryable: false })
      await store.recordError(orderId, cancelled)
      return json(res, 200, { ok: true, order: updated })
    }

    const payoutMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/payout$/)
    if (req.method === 'GET' && payoutMatch) {
      const order = store.getOrder(decodeURIComponent(payoutMatch[1]))
      if (!order) return json(res, 404, { error: 'Order not found' })
      const payout = order.payout ? {
        ...order.payout,
        attempts: (order.payout.attempts || []).map(({ recipient, ...attempt }) => attempt)
      } : null
      return json(res, 200, { id: order.id, status: order.status, payout, lastError: order.lastError || null })
    }

    if (req.method === 'POST' && payoutMatch) {
      const orderId = decodeURIComponent(payoutMatch[1])
      let order = store.getOrder(orderId)
      if (!order) return json(res, 404, { error: 'Order not found' })

      if (payoutLocks.has(orderId) || order.status === 'PAYOUT_PROCESSING') {
        const duplicate = makeError(ERROR_CODES.DUPLICATE_PROCESSING, 'A payout attempt is already being processed for this transaction. Do not submit another payout request.', { retryable: true })
        await store.recordError(orderId, duplicate)
        return json(res, 409, { ok: false, error: duplicate.message, errorCode: duplicate.code, retryable: duplicate.retryable, status: order.status })
      }

      // Payouts can only start after blockchain confirmation. A retry is allowed
      // only from PAYOUT_FAILED and creates a new attempt.
      if (!['ZEC_CONFIRMED', 'PAYOUT_FAILED'].includes(order.status)) {
        return json(res, 409, {
          error: `Payout cannot start while transaction status is ${order.status}`,
          status: order.status
        })
      }
      try { validateOrder({ ...order, id: order.id }) } catch (e) {
        const invalid = makeError(ERROR_CODES.INVALID_RECIPIENT, e.message, { retryable: false })
        await store.recordError(orderId, invalid)
        return json(res, 422, { ok: false, error: invalid.message, errorCode: invalid.code, retryable: invalid.retryable, status: order.status })
      }
      if (Number(order.fiatAmount) <= 0) {
        const invalid = makeError(ERROR_CODES.INVALID_RECIPIENT, 'Payout amount must be positive.', { retryable: false })
        await store.recordError(orderId, invalid)
        return json(res, 422, { ok: false, error: invalid.message, errorCode: invalid.code, retryable: invalid.retryable, status: order.status })
      }

      payoutLocks.add(orderId)
      try {
      if (order.status === 'ZEC_CONFIRMED') {
        order = await store.transitionOrder(order.id, 'PAYOUT_PROCESSING', 'Required ZEC confirmed; payout processing started')
      } else {
        order = await store.transitionOrder(order.id, 'PAYOUT_PROCESSING', 'Retrying failed fiat payout')
      }

      const attemptId = `PA-${crypto.randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`
      const requestedAt = new Date().toISOString()
      const provider = createPayoutProvider()
      await store.recordPayoutAttempt(order.id, {
        attemptId,
        provider: process.env.PAYOUT_PROVIDER || 'mock',
        status: 'PROCESSING',
        requestedAt,
        recipient: order.recipient
      })

      try {
        const result = await provider.sendPayout({
          orderId: order.id,
          currency: order.fiatCurrency,
          amount: order.fiatAmount,
          recipient: order.recipient
        })
        const completedAt = new Date().toISOString()
        await store.updatePayout(order.id, {
          status: 'SENT',
          provider: result.provider,
          providerReference: result.providerReference,
          lastAttemptId: attemptId,
          sentAt: completedAt
        })
        await store.recordPayoutAttempt(order.id, {
          attemptId,
          provider: result.provider,
          providerReference: result.providerReference,
          status: 'SENT',
          requestedAt,
          completedAt,
          recipient: order.recipient
        })
        order = await store.transitionOrder(order.id, 'FIAT_SENT', `Payout sent by ${result.provider}`)
        order = await store.transitionOrder(order.id, 'COMPLETED', 'Fiat payout confirmed by provider')
        await store.clearError(order.id)
        return json(res, 200, { ok: true, order })
      } catch (e) {
        const failedAt = new Date().toISOString()
        await store.updatePayout(order.id, {
          status: 'FAILED',
          provider: process.env.PAYOUT_PROVIDER || 'mock',
          lastAttemptId: attemptId,
          failedAt,
          error: e.message
        })
        await store.recordPayoutAttempt(order.id, {
          attemptId,
          provider: process.env.PAYOUT_PROVIDER || 'mock',
          providerReference: e.details?.providerReference,
          status: 'FAILED',
          requestedAt,
          completedAt: failedAt,
          error: e.message,
          recipient: order.recipient
        })
        const payoutError = makeError(ERROR_CODES.PAYOUT_FAILED, e.message, { retryable: true, details: e.details })
        await store.recordError(order.id, payoutError)
        order = await store.transitionOrder(order.id, 'PAYOUT_FAILED', 'Fiat payout provider rejected or failed the payout')
        return json(res, 502, { ok: false, order, error: e.message, errorCode: payoutError.code, retryable: payoutError.retryable, details: e.details })
      } finally {
        payoutLocks.delete(orderId)
      }
      } catch (e) {
        payoutLocks.delete(orderId)
        throw e
      } finally {
        payoutLocks.delete(orderId)
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/orders') {
      if (!isStatusAdmin(req)) return json(res, 404, { error: 'Not found' })
      return json(res, 200, store.listOrders())
    }

    return json(res, 404, { error: 'Not found' })
  } catch (e) {
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
  }
}

http.createServer(routes).listen(PORT, '127.0.0.1', () => {
  console.log(`Private Bill backend listening on http://127.0.0.1:${PORT}`)
})

const paymentSweepTimer = setInterval(() => void monitorOpenOrders(), 10_000)
paymentSweepTimer.unref()
void monitorOpenOrders()
