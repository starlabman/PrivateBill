import { getNodeConfig } from './node-config.mjs'
import { ZebraAdapter } from './adapters/zebra.mjs'
import { ZakuraAdapter } from './adapters/zakura.mjs'
import { ZalletAdapter } from './adapters/zallet.mjs'

export function createNodeManager() {
  const cfg = getNodeConfig()
  const adapters = {
    zebra: new ZebraAdapter(cfg.zebra),
    zakura: new ZakuraAdapter(cfg.zakura),
    zallet: new ZalletAdapter(cfg.zallet)
  }

  // When Zallet is configured, auto mode pins to it; it must never silently
  // fall back to a transparent-only scanner for a shielded payment order.
  // Without Zallet configured, retain the legacy Zebra/Zakura demo behavior.
  // A fixed preference is pinned to that node only —
  // it must not silently fall back to a node the operator did not select.
  const order = cfg.preference === 'auto'
    ? (cfg.zallet.url ? ['zallet'] : ['zebra', 'zakura'])
    : [cfg.preference]

  return {
    network: cfg.network,
    preference: cfg.preference,
    adapters,
    async createDepositAddress(minimumIndex) {
      if (!['auto', 'zallet'].includes(cfg.preference)) {
        throw new Error('Shielded Zallet deposit addresses require PRIVATE_BILL_NODE=auto or zallet')
      }
      return adapters.zallet.createDepositAddress(minimumIndex)
    },
    async select() {
      const errors = []
      for (const name of order) {
        try {
          await adapters[name].health()
          return { name, adapter: adapters[name], errors }
        } catch (error) {
          errors.push({ node: name, error: error instanceof Error ? error.message : String(error) })
        }
      }
      const error = new Error(`No healthy ${cfg.network} Zcash node available`)
      error.details = errors
      throw error
    },
    async findPayments(address) {
      const errors = []
      for (const name of order) {
        try {
          const adapter = adapters[name]
          await adapter.health()
          const payments = await adapter.findPayments(address)
          return { name, payments, errors }
        } catch (error) {
          errors.push({ node: name, error: error instanceof Error ? error.message : String(error) })
        }
      }
      const error = new Error(`No ${cfg.network} Zcash node could scan the deposit address`)
      error.details = errors
      throw error
    }
  }
}
