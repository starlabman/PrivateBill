export type BankCountry = 'NG' | 'GH'
export type ProviderType = 'bank' | 'fintech' | 'mobile_money'

export type Bank = {
  id: string
  name: string
  code?: string
  country: BankCountry
  currency: 'NGN' | 'GHS'
  type: ProviderType
}

export interface BankProvider {
  listBanks(country: BankCountry): Promise<Bank[]>
}

// Demo-safe normalized directory. In production, replace this with a server-side
// provider such as Paystack/Flutterwave and keep provider credentials off the client.
const DEMO_BANKS: Bank[] = [
  // Nigeria — commercial / microfinance banks
  { id: 'ng-access', name: 'Access Bank', code: '044', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-firstbank', name: 'First Bank of Nigeria', code: '011', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-gtb', name: 'Guaranty Trust Bank', code: '058', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-uba', name: 'United Bank for Africa', code: '033', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-zenith', name: 'Zenith Bank', code: '057', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-fidelity', name: 'Fidelity Bank', code: '070', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-stanbic', name: 'Stanbic IBTC Bank', code: '221', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-opay', name: 'OPay', country: 'NG', currency: 'NGN', type: 'fintech' },
  { id: 'ng-palmpay', name: 'PalmPay', country: 'NG', currency: 'NGN', type: 'fintech' },
  { id: 'ng-moniepoint', name: 'Moniepoint', code: '50515', country: 'NG', currency: 'NGN', type: 'fintech' },
  { id: 'ng-kuda', name: 'Kuda', country: 'NG', currency: 'NGN', type: 'fintech' },
  { id: 'ng-carbon', name: 'Carbon', country: 'NG', currency: 'NGN', type: 'fintech' },
  { id: 'ng-sterling', name: 'Sterling Bank', code: '232', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-wema', name: 'Wema Bank', code: '035', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-union', name: 'Union Bank of Nigeria', code: '032', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-polaris', name: 'Polaris Bank', code: '076', country: 'NG', currency: 'NGN', type: 'bank' },
  { id: 'ng-opay-wallet', name: 'OPay Wallet', country: 'NG', currency: 'NGN', type: 'mobile_money' },
  { id: 'ng-palmpay-wallet', name: 'PalmPay Wallet', country: 'NG', currency: 'NGN', type: 'mobile_money' },

  // Ghana — banks
  { id: 'gh-absa', name: 'Absa Bank Ghana', code: '030100', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-ecobank', name: 'Ecobank Ghana', code: '130100', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-gcb', name: 'GCB Bank', code: '040100', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-stanbic', name: 'Stanbic Bank Ghana', code: '190100', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-sc', name: 'Standard Chartered Bank Ghana', code: '060100', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-uba', name: 'United Bank for Africa Ghana', code: '220100', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-fidelity', name: 'Fidelity Bank Ghana', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-cal', name: 'CalBank', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-zenith', name: 'Zenith Bank Ghana', country: 'GH', currency: 'GHS', type: 'bank' },
  { id: 'gh-republic', name: 'Republic Bank Ghana', country: 'GH', currency: 'GHS', type: 'bank' },

  // Ghana — fintech / mobile-money rails
  { id: 'gh-mtn', name: 'MTN MoMo', country: 'GH', currency: 'GHS', type: 'mobile_money' },
  { id: 'gh-telecel', name: 'Telecel Cash', country: 'GH', currency: 'GHS', type: 'mobile_money' },
  { id: 'gh-at', name: 'AT Money', country: 'GH', currency: 'GHS', type: 'mobile_money' },
  { id: 'gh-gmoney', name: 'G-Money', country: 'GH', currency: 'GHS', type: 'mobile_money' },
  { id: 'gh-zeepay', name: 'Zeepay', country: 'GH', currency: 'GHS', type: 'fintech' },
  { id: 'gh-palmpay', name: 'PalmPay Ghana', country: 'GH', currency: 'GHS', type: 'fintech' },
  { id: 'gh-hubtel', name: 'Hubtel', country: 'GH', currency: 'GHS', type: 'fintech' },
]

export class DemoBankProvider implements BankProvider {
  async listBanks(country: BankCountry) {
    await new Promise(resolve => setTimeout(resolve, 350))
    return DEMO_BANKS.filter(item => item.country === country)
  }
}

/**
 * Production adapter contract.
 * A backend/serverless function can proxy Paystack or Flutterwave and normalize
 * its response into the Bank[] shape above.
 * Never put provider secret keys in the React client.
 */
export class ApiBankProvider implements BankProvider {
  constructor(private readonly endpoint = '/api/banks') {}

  async listBanks(country: BankCountry) {
    const response = await fetch(`${this.endpoint}?country=${country}`, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error('Unable to load the financial provider list.')
    const data = await response.json() as { banks?: Bank[] }
    if (!Array.isArray(data.banks)) throw new Error('Bank service returned an invalid response.')
    return data.banks
  }
}
