import fs from 'node:fs'
import path from 'node:path'

const NETWORKS = {
  mainnet: { zebraPort: 8232, zakuraPort: 8232 },
  testnet: { zebraPort: 18232, zakuraPort: 18232 },
  regtest: { zebraPort: 29232, zakuraPort: 18232 }
}

function env(name, fallback = '') {
  return process.env[name] ?? fallback
}

export function getNetwork() {
  const network = env('PRIVATE_BILL_NETWORK', 'testnet').toLowerCase()
  if (!NETWORKS[network]) throw new Error(`Unsupported network: ${network}`)
  return network
}

export function getNodePreference() {
  const value = env('PRIVATE_BILL_NODE', 'auto').toLowerCase()
  if (!['auto', 'zebra', 'zakura', 'zallet'].includes(value)) throw new Error(`Unsupported node: ${value}`)
  return value
}

export function getNodeConfig() {
  const network = getNetwork()
  return {
    network,
    preference: getNodePreference(),
    zebra: {
      url: env(`ZEBRA_${network.toUpperCase()}_RPC_URL`, `http://127.0.0.1:${NETWORKS[network].zebraPort}`),
      cookiePath: env('ZEBRA_COOKIE_PATH'),
      user: env('ZEBRA_RPC_USER'),
      password: env('ZEBRA_RPC_PASSWORD'),
      scanLookback: Number(env('ZEBRA_SCAN_LOOKBACK', '20')),
      maxBlocksPerScan: Number(env('ZEBRA_MAX_BLOCKS_PER_SCAN', '50'))
    },
    zakura: {
      url: env(`ZAKURA_${network.toUpperCase()}_RPC_URL`, `http://127.0.0.1:${NETWORKS[network].zakuraPort}`),
      user: env('ZAKURA_RPC_USER'),
      password: env('ZAKURA_RPC_PASSWORD'),
      mode: env('ZAKURA_RPC_MODE', 'compat')
    },
    zallet: {
      network,
      url: env('ZALLET_RPC_URL'),
      cookiePath: env('ZALLET_RPC_COOKIE_PATH'),
      user: env('ZALLET_RPC_USER'),
      password: env('ZALLET_RPC_PASSWORD'),
      account: env('ZALLET_ACCOUNT_UUID')
    }
  }
}

export function readCookie(cookiePath) {
  if (!cookiePath) return null
  try {
    return fs.readFileSync(path.resolve(cookiePath), 'utf8').trim()
  } catch {
    return null
  }
}
