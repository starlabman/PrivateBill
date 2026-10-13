export type Currency = 'NGN' | 'GHS'

export type ConversionRates = {
  zecUsd: number
  usdToNgn: number
  usdToGhs: number
  fetchedAt: number
  source: string
}

export type ConversionResult = {
  fiatAmount: number
  currency: Currency
  zecAmount: number
  fiatPerZec: number
  usdValue: number
}

export function convertFiatToZec(
  fiatAmount: number,
  currency: Currency,
  rates: ConversionRates,
): ConversionResult {
  if (!Number.isFinite(fiatAmount) || fiatAmount < 0) {
    throw new Error('Enter a valid recipient amount.')
  }

  const usdToLocal = currency === 'NGN' ? rates.usdToNgn : rates.usdToGhs
  if (![rates.zecUsd, usdToLocal].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('A valid exchange rate is required for conversion.')
  }

  const fiatPerZec = rates.zecUsd * usdToLocal
  const usdValue = fiatAmount / usdToLocal
  const zecAmount = fiatAmount / fiatPerZec

  return { fiatAmount, currency, zecAmount, fiatPerZec, usdValue }
}
