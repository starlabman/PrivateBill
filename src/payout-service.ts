export type PayoutState = 'PROCESSING' | 'SENT' | 'FAILED'

export type PayoutAttempt = {
  attemptId: string
  provider: string
  providerReference?: string
  status: PayoutState
  requestedAt: string
  completedAt?: string
  error?: string
  recipient: {
    providerName: string
    providerCode: string
    providerType: string
    accountNumber: string
    accountName: string
    country: string
    currency: string
  }
}

export type PayoutRecord = {
  currency: 'NGN' | 'GHS'
  amount: number
  provider: string
  status: PayoutState
  providerReference?: string
  attempts: PayoutAttempt[]
  createdAt: string
  updatedAt: string
}
