import { rpcCall } from '../rpc.mjs'

function asNumber(value) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

export class ZalletAdapter {
  constructor(config, call = rpcCall) {
    this.config = config
    this.call = call
    this.transactionsCache = null
    this.transactionsCacheUntil = 0
  }

  async health() {
    if (!this.config.url) throw new Error('ZALLET_RPC_URL is not configured')
    const info = await this.call({ ...this.config, method: 'getblockchaininfo' })
    const actualNetwork = ({ main: 'mainnet', test: 'testnet' })[info.chain] ?? info.chain
    if (actualNetwork !== this.config.network) {
      throw new Error(`Zallet is on ${actualNetwork || 'an unknown network'}; Private Bill is configured for ${this.config.network}`)
    }
    return { ok: true, node: 'zallet', info }
  }

  async findPayments(address) {
    // z_listtransactions is currently experimental in Zallet. Keep the query
    // account-scoped where configured and match the exact receiving UA.
    if (!this.transactionsCache || Date.now() >= this.transactionsCacheUntil) {
      const params = this.config.account ? [this.config.account] : []
      this.transactionsCache = await this.call({ ...this.config, method: 'z_listtransactions', params })
      this.transactionsCacheUntil = Date.now() + 2000
    }
    const transactions = this.transactionsCache
    if (!Array.isArray(transactions)) throw new Error('Zallet returned an invalid transaction list')

    const payments = transactions
      .filter(tx => tx && tx.category === 'receive' && tx.address === address && asNumber(tx.amount) > 0)
      .map(tx => ({
        txid: tx.txid,
        address,
        amountZec: asNumber(tx.amount),
        confirmations: Math.max(0, asNumber(tx.confirmations)),
        blockHeight: tx.block_height ?? tx.blockHeight ?? null
      }))
      .filter(tx => typeof tx.txid === 'string' && tx.txid.length > 0)

    return payments
  }

  async createDepositAddress(minimumIndex = 0) {
    if (!this.config.account) throw new Error('ZALLET_ACCOUNT_UUID is not configured')
    await this.health()

    const accounts = await this.call({ ...this.config, method: 'z_listaccounts', params: [true] })
    const account = Array.isArray(accounts)
      ? accounts.find(item => item?.account_uuid === this.config.account)
      : null
    if (!account) throw new Error('Configured Zallet account was not found')

    const indexes = []
    const collectIndexes = value => {
      if (!value || typeof value !== 'object') return
      if (Object.hasOwn(value, 'diversifier_index')) {
        const parsed = Number(value.diversifier_index)
        if (Number.isSafeInteger(parsed) && parsed >= 0) indexes.push(parsed)
      }
      for (const child of Object.values(value)) collectIndexes(child)
    }
    collectIndexes(account.addresses ?? [])
    const nextKnownIndex = indexes.reduce((next, value) => Math.max(next, value + 1), 0)
    const index = Math.max(Number.isSafeInteger(minimumIndex) ? minimumIndex : 0, nextKnownIndex)
    if (!Number.isSafeInteger(index)) throw new Error('No safe Zallet address index is available')

    const result = await this.call({
      ...this.config,
      method: 'z_getaddressforaccount',
      params: [this.config.account, ['orchard'], index]
    })
    const receiverTypes = Array.isArray(result?.receiver_types) ? result.receiver_types : []
    if (typeof result?.address !== 'string' || !result.address || receiverTypes.length !== 1 || receiverTypes[0] !== 'orchard') {
      throw new Error('Zallet did not return a shielded-only Orchard address')
    }
    return { address: result.address, diversifierIndex: index }
  }
}
