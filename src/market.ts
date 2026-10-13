import type { ConversionRates } from './conversion'

const ZEC_PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd&include_last_updated_at=true'
const FX_URL = 'https://open.er-api.com/v6/latest/USD'

export class MarketDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketDataError'
  }
}

function assertPositiveNumber(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new MarketDataError(`${label} is unavailable.`)
  }
  return number
}

export async function fetchConversionRates(signal?: AbortSignal): Promise<ConversionRates> {
  const [zecResponse, fxResponse] = await Promise.all([
    fetch(ZEC_PRICE_URL, { signal, headers: { accept: 'application/json' } }),
    fetch(FX_URL, { signal, headers: { accept: 'application/json' } }),
  ])

  if (!zecResponse.ok || !fxResponse.ok) {
    throw new MarketDataError('Live exchange-rate providers are unavailable.')
  }

  const [zecData, fxData] = await Promise.all([zecResponse.json(), fxResponse.json()])
  const zecUsd = assertPositiveNumber(zecData?.zcash?.usd, 'ZEC/USD rate')
  const usdToNgn = assertPositiveNumber(fxData?.rates?.NGN, 'USD/NGN rate')
  const usdToGhs = assertPositiveNumber(fxData?.rates?.GHS, 'USD/GHS rate')

  return {
    zecUsd,
    usdToNgn,
    usdToGhs,
    fetchedAt: Date.now(),
    source: 'CoinGecko + ExchangeRate-API',
  }
}
