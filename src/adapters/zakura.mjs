import { rpcCall } from '../rpc.mjs'

export class ZakuraAdapter {
  constructor(config) { this.config = config }
  async health() { const info = await rpcCall({ ...this.config, method: 'getblockchaininfo' }); return { ok: true, node: 'zakura', info } }
  async getBlockchainInfo() { return rpcCall({ ...this.config, method: 'getblockchaininfo' }) }
  async findPayments(address) {
    const info = await this.getBlockchainInfo()
    const txids = await rpcCall({ ...this.config, method: 'getaddresstxids', params: [{ addresses: [address], start: 0, end: info.blocks }] })
    const payments = []
    for (const txid of txids ?? []) {
      const tx = await rpcCall({ ...this.config, method: 'getrawtransaction', params: [txid, 1] })
      let amount = 0
      for (const vout of tx.vout ?? []) {
        const addresses = vout.scriptPubKey?.addresses ?? (vout.scriptPubKey?.address ? [vout.scriptPubKey.address] : [])
        if (addresses.includes(address)) amount += Number(vout.value ?? 0)
      }
      if (amount > 0) payments.push({ txid, address, amountZec: amount, confirmations: Number(tx.confirmations ?? 0), blockHeight: tx.height ?? null })
    }
    return payments
  }
}
