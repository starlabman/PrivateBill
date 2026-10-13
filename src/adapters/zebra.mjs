import { rpcCall } from '../rpc.mjs'

export class ZebraAdapter {
  constructor(config) { this.config = config }
  async health() { const info = await this.getBlockchainInfo(); return { ok: true, node: 'zebra', info } }
  async getBlockchainInfo() { return rpcCall({ ...this.config, method: 'getblockchaininfo' }) }

  // Zebra is a consensus node, not a wallet. This adapter intentionally scans
  // recent blocks for transparent outputs instead of assuming wallet RPCs exist.
  // For high-volume production, use Zebra's lightwalletd-compatible interface
  // or Zaino for indexed address queries.
  async findPayments(address) {
    const info = await this.getBlockchainInfo()
    const tip = Number(info.blocks ?? 0)
    const start = Math.max(0, tip - this.config.scanLookback + 1)
    const end = Math.min(tip, start + this.config.maxBlocksPerScan - 1)
    const payments = []

    for (let height = start; height <= end; height++) {
      const hash = await rpcCall({ ...this.config, method: 'getblockhash', params: [height] })
      const block = await rpcCall({ ...this.config, method: 'getblock', params: [hash, 2] })
      for (const tx of block.tx ?? []) {
        let amount = 0
        for (const vout of tx.vout ?? []) {
          const addresses = vout.scriptPubKey?.addresses ?? (vout.scriptPubKey?.address ? [vout.scriptPubKey.address] : [])
          if (addresses.includes(address)) amount += Number(vout.value ?? 0)
        }
        if (amount > 0) payments.push({ txid: tx.txid, address, amountZec: amount, confirmations: Math.max(0, tip - height + 1), blockHeight: height })
      }
    }
    return payments
  }
}
