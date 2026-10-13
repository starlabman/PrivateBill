import crypto from 'node:crypto'

export class PayoutProviderError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PayoutProviderError'
    this.details = details
  }
}

/** Provider contract used by the transaction service. */
export class MockPayoutProvider {
  constructor({ mode = process.env.MOCK_PAYOUT_MODE || 'success', providerName = 'Private Bill Mock Payout' } = {}) {
    this.mode = mode.toLowerCase()
    this.providerName = providerName
  }

  async sendPayout({ orderId, currency, amount, recipient }) {
    if (!['NGN', 'GHS'].includes(currency)) {
      throw new PayoutProviderError(`Unsupported payout currency: ${currency}`)
    }

    const providerReference = `MOCK-${currency}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
    const normalizedRecipient = {
      providerName: recipient.providerName,
      providerCode: recipient.providerCode,
      providerType: recipient.providerType,
      accountNumber: recipient.accountNumber,
      accountName: recipient.accountName,
      country: recipient.country,
      currency: recipient.currency
    }

    if (this.mode === 'failed' || this.mode === 'failure') {
      throw new PayoutProviderError('Mock payout provider rejected the payout', {
        provider: this.providerName,
        providerReference,
        orderId,
        currency,
        amount,
        recipient: normalizedRecipient
      })
    }

    return {
      provider: this.providerName,
      providerReference,
      status: 'SENT',
      orderId,
      currency,
      amount: Number(amount),
      recipient: normalizedRecipient,
      processedAt: new Date().toISOString()
    }
  }
}

export function createPayoutProvider() {
  const provider = (process.env.PAYOUT_PROVIDER || 'mock').toLowerCase()
  if (provider !== 'mock') {
    throw new Error(`Payout provider "${provider}" is not configured. Use PAYOUT_PROVIDER=mock until a production provider is approved.`)
  }
  return new MockPayoutProvider()
}
