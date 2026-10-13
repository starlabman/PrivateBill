import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { canTransition, assertValidTransition } from './src/status-engine.mjs'
import { monitorOrder, stateFor } from './src/payment-monitor.mjs'
import { MockPayoutProvider } from './src/payout-service.mjs'
import { JsonStore } from './src/store.mjs'
import { ZalletAdapter } from './src/adapters/zallet.mjs'

// 1. Status-engine invariants and complete successful lifecycle.
for (const [from, to] of [
  ['ZEC_CONFIRMED', 'PAYOUT_PROCESSING'],
  ['PAYOUT_PROCESSING', 'FIAT_SENT'],
  ['FIAT_SENT', 'COMPLETED'],
  ['PAYOUT_PROCESSING', 'PAYOUT_FAILED'],
  ['PAYOUT_FAILED', 'PAYOUT_PROCESSING'],
]) assert.equal(canTransition(from, to), true)

for (const [from, to] of [
  ['AWAITING_ZEC', 'PAYOUT_PROCESSING'],
  ['ZEC_CONFIRMED', 'COMPLETED'],
  ['FIAT_SENT', 'PAYOUT_PROCESSING'],
  ['COMPLETED', 'PAYOUT_PROCESSING'],
  ['CANCELLED', 'PAYOUT_PROCESSING'],
  ['EXPIRED', 'COMPLETED'],
  ['OVERPAID', 'PAYOUT_PROCESSING'],
]) {
  assert.equal(canTransition(from, to), false)
  assert.throws(() => assertValidTransition(from, to), /Invalid transaction status transition/)
}

const recipient = {
  providerName: 'Test Bank', providerCode: 'TESTBANK', providerType: 'bank',
  accountNumber: '0123456789', accountName: 'Test Recipient', country: 'Nigeria', currency: 'NGN'
}

// Zallet scanner only accepts exact incoming-address matches, never outgoing
// transactions or another order's receipt.
let zalletCall
const zallet = new ZalletAdapter({ url: 'http://127.0.0.1:18232', account: 'test-account' }, async args => {
  zalletCall = args
  return [
    { txid: 'shielded-receive', address: 'uTestPrivateBillAddress', category: 'receive', amount: 0.25, confirmations: 4, block_height: 12 },
    { txid: 'other-order-receive', address: 'uOtherPrivateBillAddress', category: 'receive', amount: 1, confirmations: 9 },
    { txid: 'outgoing', address: 'uTestPrivateBillAddress', category: 'send', amount: -0.1, confirmations: 1 }
  ]
})
assert.deepEqual(await zallet.findPayments('uTestPrivateBillAddress'), [{
  txid: 'shielded-receive', address: 'uTestPrivateBillAddress', amountZec: 0.25, confirmations: 4, blockHeight: 12
}])
assert.equal(zalletCall.method, 'z_listtransactions')
assert.deepEqual(zalletCall.params, ['test-account'])
const wrongNetworkZallet = new ZalletAdapter({ url: 'http://127.0.0.1:18232', network: 'testnet' }, async () => ({ chain: 'main' }))
await assert.rejects(() => wrongNetworkZallet.health(), /configured for testnet/)
const addressRpcCalls = []
const addressZallet = new ZalletAdapter({ url: 'http://127.0.0.1:18232', network: 'testnet', account: 'test-account' }, async args => {
  addressRpcCalls.push(args)
  if (args.method === 'getblockchaininfo') return { chain: 'test' }
  if (args.method === 'z_listaccounts') return [{ account_uuid: 'test-account', addresses: [{ diversifier_index: 7 }] }]
  if (args.method === 'z_getaddressforaccount') return { address: 'uFreshOrchardAddress', receiver_types: ['orchard'] }
  throw new Error(`Unexpected RPC method: ${args.method}`)
})
assert.deepEqual(await addressZallet.createDepositAddress(3), { address: 'uFreshOrchardAddress', diversifierIndex: 8 })
assert.deepEqual(addressRpcCalls[2].params, ['test-account', ['orchard'], 8])
const unsafeAddressZallet = new ZalletAdapter({ url: 'http://127.0.0.1:18232', network: 'testnet', account: 'test-account' }, async args => {
  if (args.method === 'getblockchaininfo') return { chain: 'test' }
  if (args.method === 'z_listaccounts') return [{ account_uuid: 'test-account', addresses: [] }]
  return { address: 'uNotShieldedOnly', receiver_types: ['p2pkh', 'orchard'] }
})
await assert.rejects(() => unsafeAddressZallet.createDepositAddress(), /shielded-only Orchard/)

const success = new MockPayoutProvider({ mode: 'success' })
const sent = await success.sendPayout({ orderId: 'PB-Q12-001', currency: 'NGN', amount: 25000, recipient })
assert.equal(sent.status, 'SENT')
assert.match(sent.providerReference, /^MOCK-NGN-/)
assert.equal(sent.recipient.accountNumber, recipient.accountNumber)

const failed = new MockPayoutProvider({ mode: 'failed' })
await assert.rejects(() => failed.sendPayout({ orderId: 'PB-Q12-002', currency: 'GHS', amount: 100, recipient: { ...recipient, currency: 'GHS', country: 'Ghana' } }), /rejected|failed/i)

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'private-bill-q12-'))
const store = new JsonStore(path.join(dir, 'orders.json'))
await store.init()
const created = await store.createOrder({
  id: 'PB-Q12-STORE', fiatCurrency: 'NGN', fiatAmount: 25000, requiredZec: 0.1,
  recipient, depositAddress: 't1PrivateBillQ12TestAddress123456789'
})
for (const [to, reason] of [
  ['AWAITING_ZEC', 'Ready'], ['ZEC_DETECTED', 'Detected'], ['CONFIRMING', 'Confirming'],
  ['ZEC_CONFIRMED', 'Confirmed'], ['PAYOUT_PROCESSING', 'Payout started'], ['FIAT_SENT', 'Sent'], ['COMPLETED', 'Completed']
]) await store.transitionOrder(created.id, to, reason)
const final = store.getOrder(created.id)
assert.equal(final.status, 'COMPLETED')
assert.ok(final.statusTimestamps.PAYOUT_PROCESSING)
assert.ok(final.statusTimestamps.FIAT_SENT)
assert.ok(final.statusTimestamps.COMPLETED)
assert.deepEqual(final.statusHistory.map(item => item.to), [
  'CREATED', 'AWAITING_ZEC', 'ZEC_DETECTED', 'CONFIRMING', 'ZEC_CONFIRMED',
  'PAYOUT_PROCESSING', 'FIAT_SENT', 'COMPLETED'
])

// 2. Payment exception matrix.
assert.equal(stateFor({ receivedZec: 0, confirmedZec: 0, requiredZec: 0.1, pendingPayment: false, expired: false }), 'AWAITING_ZEC')
assert.equal(stateFor({ receivedZec: 0.05, confirmedZec: 0.05, requiredZec: 0.1, pendingPayment: false, expired: false }), 'UNDERPAID')
assert.equal(stateFor({ receivedZec: 0.11, confirmedZec: 0.11, requiredZec: 0.1, pendingPayment: false, expired: false }), 'OVERPAID')
assert.equal(stateFor({ receivedZec: 0.1, confirmedZec: 0, requiredZec: 0.1, pendingPayment: true, expired: false }), 'CONFIRMING')
assert.equal(stateFor({ receivedZec: 0.1, confirmedZec: 0.1, requiredZec: 0.1, pendingPayment: false, expired: false }), 'ZEC_CONFIRMED')
assert.equal(stateFor({ receivedZec: 0.1, confirmedZec: 0.1, requiredZec: 0.1, pendingPayment: false, expired: true }), 'EXPIRED')

// A later confirmed top-up must recover an underpaid order.
const recoveryStore = new JsonStore(path.join(dir, 'recovery.json'))
await recoveryStore.init()
const recoveryOrder = await recoveryStore.createOrder({
  id: 'PB-Q12-RECOVERY', fiatCurrency: 'NGN', fiatAmount: 10000, requiredZec: 0.1,
  recipient, depositAddress: 't1PrivateBillQ12RecoveryAddress123456789'
})
assert.equal(recoveryStore.getNextDepositAddressIndex(), 0)
await recoveryStore.updateOrder(recoveryOrder.id, { depositAddressIndex: 22 })
assert.equal(recoveryStore.getNextDepositAddressIndex(), 23, 'wallet diversifier indexes must never be reused')
await recoveryStore.transitionOrder(recoveryOrder.id, 'AWAITING_ZEC', 'Ready')
const recoveryPayments = [{ txid: 'recovery-first', amountZec: 0.05, confirmations: 3, address: recoveryOrder.depositAddress, blockHeight: 100 }]
const recoveryManager = { network: 'testnet', findPayments: async () => ({ name: 'zebra', payments: recoveryPayments, errors: [] }) }
await monitorOrder(recoveryStore, recoveryManager, recoveryOrder, 3)
assert.equal(recoveryStore.getOrder(recoveryOrder.id).status, 'UNDERPAID')
recoveryPayments.push({ txid: 'recovery-top-up', amountZec: 0.05, confirmations: 3, address: recoveryOrder.depositAddress, blockHeight: 101 })
await monitorOrder(recoveryStore, recoveryManager, recoveryStore.getOrder(recoveryOrder.id), 3)
assert.equal(recoveryStore.getOrder(recoveryOrder.id).status, 'ZEC_CONFIRMED')

const errorStore = new JsonStore(path.join(dir, 'errors.json'))
await errorStore.init()
const errorOrder = await errorStore.createOrder({
  id: 'PB-Q12-ERROR', fiatCurrency: 'NGN', fiatAmount: 10000, requiredZec: 0.1,
  recipient, depositAddress: 't1PrivateBillQ12ErrorAddress123456789'
})
await errorStore.transitionOrder(errorOrder.id, 'AWAITING_ZEC', 'Ready')
await errorStore.recordError(errorOrder.id, { code: 'UNDERPAYMENT', message: 'Not enough ZEC received', retryable: true, at: new Date().toISOString() })
await errorStore.recordError(errorOrder.id, { code: 'UNDERPAYMENT', message: 'Not enough ZEC received', retryable: true, at: new Date().toISOString() })
assert.equal(errorStore.getOrder(errorOrder.id).errorHistory.length, 1, 'repeated identical errors are deduplicated')
await errorStore.clearError(errorOrder.id)
assert.equal(errorStore.getOrder(errorOrder.id).lastError, null)

// 3. Cancellation and payout safety at the persistence layer.
const cancelledOrder = await errorStore.createOrder({
  id: 'PB-Q12-CANCEL', fiatCurrency: 'NGN', fiatAmount: 10000, requiredZec: 0.1,
  recipient, depositAddress: 't1PrivateBillQ12CancelAddress123456789'
})
await errorStore.transitionOrder(cancelledOrder.id, 'AWAITING_ZEC', 'Ready')
await errorStore.transitionOrder(cancelledOrder.id, 'CANCELLED', 'Cancelled by user')
assert.equal(errorStore.getOrder(cancelledOrder.id).status, 'CANCELLED')
assert.equal(canTransition('CANCELLED', 'PAYOUT_PROCESSING'), false)
const latePayment = { txid: 'PB-Q12-LATE-FUNDING', amountZec: 0.1, confirmations: 3, address: cancelledOrder.depositAddress, blockHeight: 200 }
const latePaymentManager = { network: 'testnet', findPayments: async () => ({ name: 'zebra', payments: [latePayment], errors: [] }) }
await monitorOrder(errorStore, latePaymentManager, errorStore.getOrder(cancelledOrder.id), 3)
assert.equal(errorStore.getOrder(cancelledOrder.id).status, 'CANCELLED', 'late funding must not reopen or pay a cancelled order')
assert.equal(errorStore.getOrder(cancelledOrder.id).payment.receivedZec, 0.1, 'late funding must remain visible for manual recovery')

// 4. Static final-polish/security checks: no accidental debug logging in app code,
// responsive rules exist, and secrets/runtime files are ignored.
const sourceFiles = ['src/App.tsx', 'src/orders.ts', 'src/payment-monitor.ts', 'src/payout.ts', 'src/tracking.ts', 'src/status-engine.ts']
for (const file of sourceFiles) {
  const text = await fs.readFile(file, 'utf8')
  assert.equal(/console\.(log|debug|warn|error)\s*\(/.test(text), false, `${file} contains debug console output`)
  assert.equal(/BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(text), false, `${file} contains a private key marker`)
}
const gitignore = await fs.readFile('.gitignore', 'utf8')
assert.match(gitignore, /^\.env\*?$/m)
assert.match(gitignore, /^data\/\*\.json$/m)
assert.match(await fs.readFile('src/styles.css', 'utf8'), /@media\(max-width:640px\)/)
assert.match(await fs.readFile('src/styles.css', 'utf8'), /@media\(max-width:700px\)/)
const app = await fs.readFile('src/App.tsx', 'utf8')
for (const marker of ['Select', 'recipient', 'Track transaction', 'Cancel transaction', 'Process fiat payout']) {
  assert.ok(app.toLowerCase().includes(marker.toLowerCase()), `missing final flow marker: ${marker}`)
}

// 5. Live HTTP integration smoke test with an isolated temporary DB.
const port = 18787 + Math.floor(Math.random() * 1000)
const httpDb = path.join(dir, 'http-orders.json')
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
    env: {
    ...process.env,
    PORT: String(port),
    PRIVATE_BILL_DB: httpDb,
    PRIVATE_BILL_NETWORK: 'testnet',
    PRIVATE_BILL_DEPOSIT_ADDRESS_POOL: 't1PrivateBillPoolAddressOne234567890, t1PrivateBillPoolAddressTwo234567890, t1PrivateBillPoolAddressThree234567890',
    MOCK_PAYOUT_MODE: 'success',
    PRIVATE_BILL_STATUS_ADMIN_TOKEN: 'test-only-status-token'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let serverOutput = ''
server.stdout.on('data', chunk => { serverOutput += chunk.toString() })
server.stderr.on('data', chunk => { serverOutput += chunk.toString() })
try {
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${base}/api/orders`) ; break } catch { await new Promise(r => setTimeout(r, 50)) }
  }
  const validOrder = {
    id: 'PB-Q12-HTTP', fiatCurrency: 'NGN', fiatAmount: 25000, requiredZec: 0.1,
    recipient, depositAddress: 't1PrivateBillQ12HttpAddress123456789'
  }
  let response = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validOrder) })
  assert.equal(response.status, 201)
  let payload = await response.json()
  assert.equal(payload.status, 'AWAITING_ZEC')
  assert.equal(payload.depositAddress, 't1PrivateBillPoolAddressOne234567890', 'the server must assign the first address and ignore the client address')
  const cancelOrder = { ...validOrder, id: 'PB-Q12-CANCEL-HTTP' }
  response = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cancelOrder) })
  assert.equal(response.status, 201)
  payload = await response.json()
  assert.equal(payload.depositAddress, 't1PrivateBillPoolAddressTwo234567890', 'each order must receive a different address')
  response = await fetch(`${base}/api/orders/PB-Q12-CANCEL-HTTP/cancel`, { method: 'POST' })
  assert.equal(response.status, 200)
  payload = await response.json()
  assert.equal(payload.order.status, 'CANCELLED')
  response = await fetch(`${base}/api/orders/PB-Q12-CANCEL-HTTP/status`)
  assert.equal((await response.json()).status, 'CANCELLED', 'cancellation must persist')
  response = await fetch(`${base}/api/orders/PB-Q12-CANCEL-HTTP/payout`, { method: 'POST' })
  assert.equal(response.status, 409, 'cancelled order must not be paid out')

  response = await fetch(`${base}/api/orders/PB-Q12-HTTP/payout`, { method: 'POST' })
  assert.equal(response.status, 409, 'payout must be blocked before ZEC confirmation')

  response = await fetch(`${base}/api/orders/PB-Q12-HTTP/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ZEC_DETECTED', reason: 'integration test' }) })
  assert.equal(response.status, 404, 'status mutation must require an admin token')
  const adminHeaders = { 'content-type': 'application/json', authorization: 'Bearer test-only-status-token' }
  response = await fetch(`${base}/api/orders/PB-Q12-HTTP/status`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'ZEC_DETECTED', reason: 'integration test' }) })
  assert.equal(response.status, 200)
  response = await fetch(`${base}/api/orders/PB-Q12-HTTP/status`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'CONFIRMING', reason: 'integration test' }) })
  assert.equal(response.status, 200)
  response = await fetch(`${base}/api/orders/PB-Q12-HTTP/status`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'ZEC_CONFIRMED', reason: 'integration test' }) })
  assert.equal(response.status, 200)

  response = await fetch(`${base}/api/orders/PB-Q12-HTTP/cancel`, { method: 'POST' })
  assert.equal(response.status, 409, 'a funded order cannot be cancelled automatically')
  response = await fetch(`${base}/api/orders/PB-Q12-HTTP/payout`, { method: 'POST' })
  assert.equal(response.status, 200)
  payload = await response.json()
  assert.equal(payload.order.status, 'COMPLETED')
  assert.equal(payload.order.payout.status, 'SENT')

  response = await fetch(`${base}/api/orders/PB-Q12-HTTP/payout`, { method: 'POST' })
  assert.equal(response.status, 409, 'completed transaction cannot be paid twice')

  const invalid = { ...validOrder, id: 'PB-Q12-INVALID', recipient: { ...recipient, accountNumber: '123' } }
  response = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalid) })
  assert.equal(response.status, 422)
  payload = await response.json()
  assert.equal(payload.errorCode, 'INVALID_RECIPIENT')

  const thirdOrder = { ...validOrder, id: 'PB-Q12-THIRD-HTTP' }
  response = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(thirdOrder) })
  assert.equal(response.status, 201)
  payload = await response.json()
  assert.equal(payload.depositAddress, 't1PrivateBillPoolAddressThree234567890')
  const exhaustedOrder = { ...validOrder, id: 'PB-Q12-POOL-EXHAUSTED' }
  response = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exhaustedOrder) })
  assert.equal(response.status, 503, 'order creation must fail closed when no unique addresses remain')
  assert.equal((await response.json()).errorCode, 'DEPOSIT_ADDRESS_UNAVAILABLE')
} finally {
  server.kill('SIGTERM')
  await new Promise(resolve => server.once('exit', resolve))
}

// 5b. Regression: the legacy testnet address from the supplied project keeps
// the Confirm -> Create Order flow usable when no pool or Zallet is configured.
const legacyPort = 20787 + Math.floor(Math.random() * 1000)
const legacyDb = path.join(dir, 'legacy-demo-orders.json')
const legacyServer = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(legacyPort),
    PRIVATE_BILL_DB: legacyDb,
    PRIVATE_BILL_NETWORK: 'testnet',
    PRIVATE_BILL_NODE: 'auto',
    PRIVATE_BILL_DEPOSIT_ADDRESS_POOL: '',
    VITE_ZEC_RECEIVING_ADDRESS: 'utest1LegacyDemoAddress12345678901234567890',
    ZALLET_RPC_URL: '',
    NODE_ENV: 'development'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
try {
  const base = `http://127.0.0.1:${legacyPort}`
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${base}/api/orders`); break } catch { await new Promise(r => setTimeout(r, 50)) }
  }
  const response = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'PB-Q12-LEGACY-DEMO', fiatCurrency: 'NGN', fiatAmount: 10000, requiredZec: 0.1,
      recipient, depositAddress: 'browser-address-is-ignored'
    })
  })
  assert.equal(response.status, 201)
  const payload = await response.json()
  assert.equal(payload.status, 'AWAITING_ZEC')
  assert.equal(payload.depositAddress, 'utest1LegacyDemoAddress12345678901234567890')
  assert.equal(payload.depositAddressMode, 'shared-demo')
} finally {
  legacyServer.kill('SIGTERM')
  await new Promise(resolve => legacyServer.once('exit', resolve))
}

// 5c. Explicitly enabled testnet demo also works on a hosted production server.
const hostedDemoPort = legacyPort + 1
const hostedDemoDb = path.join(dir, 'hosted-demo-orders.json')
const hostedDemoServer = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(hostedDemoPort),
    PRIVATE_BILL_DB: hostedDemoDb,
    PRIVATE_BILL_NETWORK: 'testnet',
    PRIVATE_BILL_NODE: 'auto',
    PRIVATE_BILL_DEPOSIT_ADDRESS_POOL: '',
    PRIVATE_BILL_DEMO_RECEIVING_ADDRESS: 'utest1HostedDemoAddress12345678901234567890',
    PRIVATE_BILL_ALLOW_SHARED_DEMO_ADDRESS: 'true',
    VITE_ZEC_RECEIVING_ADDRESS: '',
    ZALLET_RPC_URL: '',
    NODE_ENV: 'production'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
try {
  const base = `http://127.0.0.1:${hostedDemoPort}`
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${base}/api/orders`); break } catch { await new Promise(r => setTimeout(r, 50)) }
  }
  const response = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'PB-Q12-HOSTED-DEMO', fiatCurrency: 'NGN', fiatAmount: 10000, requiredZec: 0.1,
      recipient, depositAddress: 'browser-address-is-ignored'
    })
  })
  assert.equal(response.status, 201)
  const payload = await response.json()
  assert.equal(payload.depositAddress, 'utest1HostedDemoAddress12345678901234567890')
  assert.equal(payload.depositAddressMode, 'shared-demo')
} finally {
  hostedDemoServer.kill('SIGTERM')
  await new Promise(resolve => hostedDemoServer.once('exit', resolve))
}

// 6. A full HTTP order-creation flow asks Zallet for distinct Orchard-only
// addresses, even when a browser submits a fake deposit address.
const zalletRpcPort = 19787 + Math.floor(Math.random() * 1000)
const zalletServerPort = zalletRpcPort + 1200
const zalletDb = path.join(dir, 'zallet-orders.json')
const issuedIndexes = []
const fakeZalletRpc = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const call = JSON.parse(raw)
  let result
  if (call.method === 'getblockchaininfo') result = { chain: 'test' }
  else if (call.method === 'z_listaccounts') result = [{ account_uuid: 'test-account', addresses: [{ diversifier_index: 4 }, ...issuedIndexes.map(diversifier_index => ({ diversifier_index }))] }]
  else if (call.method === 'z_getaddressforaccount') {
    const index = call.params[2]
    issuedIndexes.push(index)
    result = { address: `uPrivateBillTestAddress${index}`, receiver_types: ['orchard'] }
  } else throw new Error(`Unexpected test RPC method: ${call.method}`)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
})
await new Promise(resolve => fakeZalletRpc.listen(zalletRpcPort, '127.0.0.1', resolve))
const zalletServer = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(zalletServerPort),
    PRIVATE_BILL_DB: zalletDb,
    PRIVATE_BILL_NETWORK: 'testnet',
    PRIVATE_BILL_NODE: 'auto',
    PRIVATE_BILL_DEPOSIT_ADDRESS_POOL: '',
    ZALLET_RPC_URL: `http://127.0.0.1:${zalletRpcPort}`,
    ZALLET_ACCOUNT_UUID: 'test-account',
    ZALLET_RPC_USER: '',
    ZALLET_RPC_PASSWORD: '',
    ZALLET_RPC_COOKIE_PATH: '',
    MOCK_PAYOUT_MODE: 'success'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
try {
  const base = `http://127.0.0.1:${zalletServerPort}`
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${base}/api/config`); break } catch { await new Promise(r => setTimeout(r, 50)) }
  }
  const healthResponse = await fetch(`${base}/api/health`)
  assert.equal(healthResponse.status, 200)
  assert.equal((await healthResponse.json()).selectedNode, 'zallet')
  for (const [id, expectedIndex] of [['PB-Q12-ZALLET-1', 5], ['PB-Q12-ZALLET-2', 6]]) {
    const response = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id, fiatCurrency: 'NGN', fiatAmount: 10000, requiredZec: 0.1,
        recipient, depositAddress: 'uBrowserSuppliedAddressMustBeIgnored'
      })
    })
    assert.equal(response.status, 201)
    const payload = await response.json()
    assert.equal(payload.depositAddressIndex, expectedIndex)
    assert.equal(payload.depositAddress, `uPrivateBillTestAddress${expectedIndex}`)
    assert.equal(payload.network, 'testnet')
    if (expectedIndex === 5) {
      const configResponse = await fetch(`${base}/api/config`)
      assert.equal((await configResponse.json()).paymentSimulationEnabled, true)
      const simulatedResponse = await fetch(`${base}/api/orders/${id}/simulate-payment`, { method: 'POST' })
      assert.equal(simulatedResponse.status, 200)
      const simulated = await simulatedResponse.json()
      assert.equal(simulated.simulated, true)
      assert.equal(simulated.order.paymentSimulation, true)
      assert.equal(simulated.order.payment.simulated, true)
      assert.equal(simulated.order.status, 'ZEC_CONFIRMED')
      const monitorResponse = await fetch(`${base}/api/payment-monitor/${id}`)
      const monitor = await monitorResponse.json()
      assert.equal(monitor.state, 'ZEC_CONFIRMED', 'polling must preserve the simulated funding state')
      assert.equal(monitor.simulated, true)
      const payoutResponse = await fetch(`${base}/api/orders/${id}/payout`, { method: 'POST' })
      assert.equal(payoutResponse.status, 200, 'a simulated confirmed payment must reach the mock payout flow')
      assert.equal((await payoutResponse.json()).order.status, 'COMPLETED')
    }
  }
} finally {
  zalletServer.kill('SIGTERM')
  await new Promise(resolve => zalletServer.once('exit', resolve))
  await new Promise(resolve => fakeZalletRpc.close(resolve))
}

console.log('Q12 lifecycle and Zallet adapter integration tests passed')
