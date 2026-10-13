import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { convertFiatToZec, type ConversionRates, type Currency } from './conversion'
import { fetchConversionRates } from './market'
import { DemoBankProvider, type Bank, type ProviderType } from './banks'
import { createTransactionOrder, getMostRecentTransactionOrder, persistTransactionOrder, syncTransactionStatus, updateTransactionPayment, type TransactionOrder } from './orders'
import { BackendPaymentMonitor, paymentStatusLabel, type PaymentCheck } from './payment-monitor.ts'
import { CORE_STATUS_FLOW, STATUS_LABELS, type TransactionStatus } from './status-engine.ts'
import { requestPayout } from './payout'
import { fetchTransactionTracking, getTrackingStages } from './tracking'

type CurrencyMeta = { name: string; symbol: string; flag: string; country: string }
type BankDetails = { accountNumber: string; accountName: string; bankName: string; bankCode: string; country: string; currency: Currency }
type Step = 1 | 2 | 3 | 4 | 5 | 6

const CURRENCIES: Record<Currency, CurrencyMeta> = {
  NGN: { name: 'Nigerian Naira', symbol: '₦', flag: '🇳🇬', country: 'Nigeria' },
  GHS: { name: 'Ghanaian Cedi', symbol: 'GH₵', flag: '🇬🇭', country: 'Ghana' },
}

const MIN_AMOUNT: Record<Currency, number> = { NGN: 100, GHS: 1 }
const ZEC_DECIMALS = 8

function formatFiat(value: number, currency: Currency) {
  return `${CURRENCIES[currency].symbol}${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}`
}
function roundUpToZatoshi(value: number) { return Math.ceil(value * 100_000_000) / 100_000_000 }
function formatZec(value: number) { return value.toFixed(ZEC_DECIMALS) }
function formatUsd(value: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value) }
function formatRate(value: number, currency: Currency) { return new Intl.NumberFormat('en-US', { maximumFractionDigits: currency === 'NGN' ? 2 : 4, minimumFractionDigits: currency === 'NGN' ? 2 : 4 }).format(value) }
function maskAccount(value: string) { return value.length <= 4 ? '••••' : `•••• ${value.slice(-4)}` }
function toOrderPayment(payment: NonNullable<PaymentCheck['payment']>) {
  return {
    txid: payment.txid,
    receivedZec: payment.amountZec,
    confirmations: payment.confirmations,
    requiredConfirmations: payment.requiredConfirmations,
    detectedAt: payment.detectedAt ?? new Date().toISOString(),
    address: payment.address,
  }
}

function statusStepClass(status: TransactionStatus, current: TransactionStatus) {
  const currentIndex = CORE_STATUS_FLOW.indexOf(current)
  const index = CORE_STATUS_FLOW.indexOf(status)
  if (status === current) return 'current'
  if (index >= 0 && currentIndex >= 0 && index < currentIndex) return 'done'
  return ''
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

function receiptMarkup(order: TransactionOrder) {
  const recipientAccount = maskAccount(order.recipient.accountNumber)
  const rows: Array<[string, string]> = [
    ['Order ID', order.id],
    ['Created', new Date(order.createdAt).toLocaleString()],
    ['Status', STATUS_LABELS[order.status] ?? order.status],
    ['Recipient receives', formatFiat(order.fiatAmount, order.fiatCurrency)],
    ['Required ZEC', `${formatZec(order.requiredZec)} ZEC`],
    ['Recipient', order.recipient.accountName],
    ['Country / currency', `${order.recipient.country} · ${order.fiatCurrency}`],
    ['Payment provider', order.recipient.providerName],
    ['Recipient account', recipientAccount],
    ['Network', order.network ?? 'Not specified'],
    ['Deposit address', order.depositAddress ?? 'Not assigned'],
    ['ZEC transaction ID', order.payment?.txid ?? 'No on-chain payment recorded'],
    ['ZEC received', order.payment ? `${formatZec(order.payment.receivedZec)} ZEC` : 'Not detected'],
    ['Confirmations', order.payment ? `${order.payment.confirmations} / ${order.payment.requiredConfirmations}` : 'Not available'],
    ['Fiat payout status', order.payout?.status ?? 'Not processed'],
    ['Payout reference', order.payout?.providerReference ?? 'Not available'],
    ['Expires', new Date(order.expiresAt).toLocaleString()],
  ]
  const demoNote = order.payment?.simulated || order.depositAddressMode === 'shared-demo'
    ? '<p class="warning"><strong>DEMO / TESTNET:</strong> This receipt may represent a simulated payment or a shared test address. It is not proof of a real transfer or fiat payout.</p>' : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private Bill receipt ${escapeHtml(order.id)}</title><style>body{font:15px system-ui,sans-serif;color:#171923;max-width:760px;margin:40px auto;padding:0 24px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #e2b900;padding-bottom:18px}.brand{font-weight:800;letter-spacing:.08em}.muted{color:#606575;font-size:12px}.status{background:#f3f4f6;padding:7px 10px;border-radius:99px;font-size:12px}h1{font-size:28px;margin:26px 0 6px}table{width:100%;border-collapse:collapse;margin:22px 0}td{padding:12px 8px;border-bottom:1px solid #e6e7eb;vertical-align:top;overflow-wrap:anywhere}td:first-child{width:38%;color:#606575}td:last-child{font-weight:600}.warning{background:#fff7d6;border:1px solid #efd66c;padding:12px;border-radius:8px;font-size:13px}.actions{margin:20px 0}button{background:#171923;color:#fff;border:0;padding:11px 16px;border-radius:8px;cursor:pointer}@media print{body{margin:0 auto;padding:0 12px}.actions{display:none}}</style></head><body><header><div><div class="brand">PRIVATE BILL</div><div class="muted">Zcash-powered local currency payout flow</div></div><span class="status">${escapeHtml(STATUS_LABELS[order.status] ?? order.status)}</span></header><h1>Transaction receipt</h1><p class="muted">A record of the order details currently available to Private Bill.</p>${demoNote}<table>${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</table><p class="muted">This receipt records the application state at the time it was generated. A created order alone does not prove that ZEC was received or that a fiat payout was completed. Verify transaction IDs and payout references independently.</p><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div><script>window.onafterprint=()=>{};</script></body></html>`
}

function downloadReceipt(order: TransactionOrder) {
  const blob = new Blob([receiptMarkup(order)], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `private-bill-receipt-${order.id}.html`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function printReceipt(order: TransactionOrder) {
  const receiptWindow = window.open('', '_blank', 'width=820,height=900')
  if (!receiptWindow) return false
  receiptWindow.document.open()
  receiptWindow.document.write(receiptMarkup(order))
  receiptWindow.document.close()
  receiptWindow.focus()
  window.setTimeout(() => receiptWindow.print(), 250)
  return true
}

function getStartupOrder() {
  const latest = getMostRecentTransactionOrder()
  if (!latest) return null
  try { if (window.sessionStorage.getItem('private-bill:home-dismissed-order') === latest.id) return null } catch {}
  return latest
}

function App() {
  const [initialOrder] = useState(() => getStartupOrder())
  const [currency, setCurrency] = useState<Currency>('NGN')
  const [amount, setAmount] = useState('100000')
  const [menuOpen, setMenuOpen] = useState(false)
  const [step, setStep] = useState<Step>(() => initialOrder
    ? ['CANCELLED', 'EXPIRED', 'COMPLETED'].includes(initialOrder.status) ? 6 : 5
    : 1)
  const [toast, setToast] = useState('')
  const [receiptPreviewOpen, setReceiptPreviewOpen] = useState(false)
  const [rates, setRates] = useState<ConversionRates | null>(null)
  const [loadingRates, setLoadingRates] = useState(true)
  const [rateError, setRateError] = useState('')
  const [lastSuccessfulUpdate, setLastSuccessfulUpdate] = useState<number | null>(null)
  const [bank, setBank] = useState<BankDetails>({ accountNumber: '', accountName: '', bankName: '', bankCode: '', country: 'Nigeria', currency: 'NGN' })
  const [banks, setBanks] = useState<Bank[]>([])
  const [bankSearch, setBankSearch] = useState('')
  const [bankMenuOpen, setBankMenuOpen] = useState(false)
  const [loadingBanks, setLoadingBanks] = useState(false)
  const [bankLoadError, setBankLoadError] = useState('')
  const bankProvider = useMemo(() => new DemoBankProvider(), [])
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [order, setOrder] = useState<TransactionOrder | null>(initialOrder)
  const [addressCopied, setAddressCopied] = useState(false)
  const [paymentCheck, setPaymentCheck] = useState<PaymentCheck | null>(null)
  const [checkingPayment, setCheckingPayment] = useState(false)
  const [processingPayout, setProcessingPayout] = useState(false)
  const [creatingOrder, setCreatingOrder] = useState(false)
  const [orderCreationError, setOrderCreationError] = useState('')
  const [payoutError, setPayoutError] = useState('')
  const [paymentMonitorError, setPaymentMonitorError] = useState('')
  const [paymentSimulationEnabled, setPaymentSimulationEnabled] = useState(false)
  const [simulatingPayment, setSimulatingPayment] = useState(false)
  const [cancellingOrder, setCancellingOrder] = useState(false)
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const [cancelAcknowledged, setCancelAcknowledged] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const cancelDialogRef = useRef<HTMLDialogElement>(null)
  const receiptPreviewRef = useRef<HTMLDialogElement>(null)
  const paymentMonitor = useMemo(() => new BackendPaymentMonitor(), [])

  useEffect(() => {
    fetch('/api/config', { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
      .then(config => setPaymentSimulationEnabled(config?.paymentSimulationEnabled === true))
      .catch(() => setPaymentSimulationEnabled(false))
  }, [])

  useEffect(() => {
    const dialog = cancelDialogRef.current
    if (!dialog) return
    if (cancelDialogOpen && !dialog.open) dialog.showModal()
    else if (!cancelDialogOpen && dialog.open) dialog.close()
  }, [cancelDialogOpen])

  useEffect(() => {
    const dialog = receiptPreviewRef.current
    if (!dialog) return
    if (receiptPreviewOpen && !dialog.open) dialog.showModal()
    else if (!receiptPreviewOpen && dialog.open) dialog.close()
  }, [receiptPreviewOpen])

  const loadRates = useCallback(async () => {
    setLoadingRates(true); setRateError('')
    try {
      const nextRates = await fetchConversionRates()
      setRates(nextRates); setLastSuccessfulUpdate(nextRates.fetchedAt)
    } catch (error) {
      setRateError(error instanceof Error ? error.message : 'Live exchange rates are unavailable.')
    } finally { setLoadingRates(false) }
  }, [])

  useEffect(() => {
    void loadRates()
    const interval = window.setInterval(() => void loadRates(), 60_000)
  return () => window.clearInterval(interval)
  }, [loadRates])

  const selected = CURRENCIES[currency]
  const numericAmount = Number(amount.replace(/,/g, '')) || 0
  const conversion = useMemo(() => {
    if (!rates || numericAmount <= 0) return null
    try { return convertFiatToZec(numericAmount, currency, rates) } catch { return null }
  }, [rates, numericAmount, currency])

  const amountError = numericAmount > 0 && numericAmount < MIN_AMOUNT[currency] ? `Minimum is ${formatFiat(MIN_AMOUNT[currency], currency)}` : ''
  useEffect(() => {
    if (step !== 2) return
    let cancelled = false
    setLoadingBanks(true); setBankLoadError('')
    bankProvider.listBanks(currency === 'NGN' ? 'NG' : 'GH').then(list => {
      if (!cancelled) setBanks(list)
    }).catch(error => {
      if (!cancelled) setBankLoadError(error instanceof Error ? error.message : 'Unable to load banks.')
    }).finally(() => { if (!cancelled) setLoadingBanks(false) })
    return () => { cancelled = true }
  }, [step, currency, bankProvider])

  const filteredBanks = useMemo(() => {
    const q = bankSearch.trim().toLowerCase()
    return q ? banks.filter(item => `${item.name} ${item.type}`.toLowerCase().includes(q)) : banks
  }, [banks, bankSearch])

  const providerLabel = (type: ProviderType) => type === 'bank' ? 'Bank' : type === 'fintech' ? 'Fintech' : 'Mobile money'
  const providerGroups = useMemo(() => [
    { type: 'bank' as ProviderType, label: 'Banks' },
    { type: 'fintech' as ProviderType, label: 'Fintech & digital banks' },
    { type: 'mobile_money' as ProviderType, label: 'Mobile money & wallets' },
  ], [])

  const bankErrors = {
    accountNumber: !bank.accountNumber.trim() ? 'Account number is required.' : !/^[A-Za-z0-9\- ]{6,20}$/.test(bank.accountNumber.trim()) ? 'Enter a valid account number.' : '',
    accountName: !bank.accountName.trim() ? 'Account name is required.' : bank.accountName.trim().length < 2 ? 'Enter the account holder name.' : '',
    bankName: !bank.bankName.trim() ? 'Select a bank.' : '',
  }
  const bankValid = !bankErrors.accountNumber && !bankErrors.accountName && !bankErrors.bankName

  const status = numericAmount === 0 ? 'Enter an amount to continue' : amountError ? amountError : loadingRates ? 'Fetching live exchange rates…' : rateError || !conversion ? 'Live conversion unavailable' : 'Live ZEC quote ready'
  const lastUpdated = lastSuccessfulUpdate ? new Date(lastSuccessfulUpdate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'
  const marketStatus = loadingRates ? 'Updating rates' : rateError ? 'Rate unavailable' : 'Live market rates'
  const cancellationHasFunds = Boolean(order?.payment || paymentCheck?.payment) || ['ZEC_DETECTED', 'CONFIRMING', 'UNDERPAID', 'OVERPAID', 'ZEC_CONFIRMED', 'PAYOUT_FAILED', 'PAYOUT_PROCESSING', 'FIAT_SENT', 'COMPLETED'].includes(order?.status ?? '')

  useEffect(() => {
    if (step !== 5 || !order) return

    let cancelled = false
    let interval: number | undefined

    const checkPayment = async () => {
      if (cancelled) return
      setCheckingPayment(true)
      setPaymentMonitorError('')
      try {
        const result = await paymentMonitor.check(order)
        if (cancelled) return
        setPaymentCheck(result)
        if (result.error) setPaymentMonitorError(result.error)
        let updated = order
        if (result.payment) {
          const paymentStatus = result.state as TransactionOrder['status']
          const withPayment = updateTransactionPayment(order.id, toOrderPayment(result.payment), paymentStatus)
          if (withPayment) updated = withPayment
        }
        const synced = syncTransactionStatus(order.id, result.state as TransactionOrder['status'], result.statusHistory, result.statusTimestamps)
        if (synced) updated = synced
        setOrder(updated)
      } catch (error) {
        if (!cancelled) setPaymentMonitorError(error instanceof Error ? error.message : 'Payment status is temporarily unavailable.')
      } finally {
        if (!cancelled) setCheckingPayment(false)
      }
    }

    void checkPayment()
    interval = window.setInterval(() => void checkPayment(), 10_000)
    return () => {
      cancelled = true
      if (interval) window.clearInterval(interval)
    }
  }, [step, order?.id, paymentMonitor])

  // Quest 10: the tracking experience reads the persisted backend state.
  // It never advances the UI on its own; polling only reflects server state.
  useEffect(() => {
    if (step !== 6 || !order) return
    let cancelled = false
    let interval: number | undefined

    const refreshTracking = async () => {
      try {
        // Trigger the real backend payment monitor first so the tracker can
        // reflect newly detected/confirmed ZEC rather than a simulated timer.
        await paymentMonitor.check(order)
        const tracking = await fetchTransactionTracking(order.id)
        if (cancelled) return

        if (tracking.lastError) setPaymentMonitorError(tracking.lastError.message)
        const updated = syncTransactionStatus(order.id, tracking.status, tracking.statusHistory, tracking.statusTimestamps)
        if (updated) setOrder({ ...updated, payment: tracking.payment ?? undefined, lastError: tracking.lastError ?? null })
      } catch (error) {
        if (!cancelled) setPaymentMonitorError(error instanceof Error ? error.message : 'Transaction status is temporarily unavailable.')
      }
    }

    void refreshTracking()
    interval = window.setInterval(() => void refreshTracking(), 5_000)
    return () => {
      cancelled = true
      if (interval) window.clearInterval(interval)
    }
  }, [step, order?.id, paymentMonitor])

  const chooseCurrency = (next: Currency) => {
    setCurrency(next); setMenuOpen(false)
    setBank(prev => ({ ...prev, currency: next, country: CURRENCIES[next].country, bankName: '', bankCode: '' }))
    setBankSearch('')
    setBankMenuOpen(false)
  }
  const showToast = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2800) }
  const goHome = () => {
    if (order?.id) { try { window.sessionStorage.setItem('private-bill:home-dismissed-order', order.id) } catch {} }
    setReceiptPreviewOpen(false); setStep(1); setOrder(null); setPaymentCheck(null); setPaymentMonitorError(''); setOrderCreationError(''); setPayoutError(''); setAmount('100000'); setTouched({}); setBank({ accountNumber: '', accountName: '', bankName: '', bankCode: '', country: 'Nigeria', currency: 'NGN' }); chooseCurrency('NGN'); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const saveReceipt = () => { if (!order) return; downloadReceipt(order); showToast('Receipt downloaded. Open it and choose Print / Save as PDF if needed.') }
  const printOrSaveReceipt = () => { if (!order) return; if (!printReceipt(order)) showToast('Allow pop-ups to print or save the receipt as PDF.') }
  const handlePayout = async () => {
    if (!order || !['ZEC_CONFIRMED', 'PAYOUT_FAILED'].includes(order.status)) return
    setProcessingPayout(true)
    setPayoutError('')
    try {
      const result = await requestPayout(order.id)
      if (result.order) {
        persistTransactionOrder(result.order)
        setOrder(result.order)
        showToast(result.order.status === 'COMPLETED' ? 'Fiat payout completed.' : 'Payout status updated.')
      }
    } catch (error) {
      setPayoutError(error instanceof Error ? error.message : 'Payout failed.')
      try {
        const refreshed = await fetch(`/api/orders/${encodeURIComponent(order.id)}/payout`, { cache: 'no-store' }).then(r => r.json())
        if (refreshed?.payout) setOrder({ ...order, status: refreshed.status, payout: refreshed.payout })
      } catch {}
    } finally {
      setProcessingPayout(false)
    }
  }
  const simulatePayment = async () => {
    if (!order || !paymentSimulationEnabled || order.status !== 'AWAITING_ZEC') return
    setSimulatingPayment(true)
    setPaymentMonitorError('')
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(order.id)}/simulate-payment`, { method: 'POST', headers: { Accept: 'application/json' } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Demo payment could not be simulated.')
      const simulatedOrder = { ...data.order, payment: { ...data.order.payment, simulated: true } } as TransactionOrder
      persistTransactionOrder(simulatedOrder)
      setOrder(simulatedOrder)
      setPaymentCheck({ state: simulatedOrder.status, payment: {
        txid: simulatedOrder.payment!.txid, amountZec: simulatedOrder.payment!.receivedZec,
        confirmations: simulatedOrder.payment!.confirmations, requiredConfirmations: simulatedOrder.payment!.requiredConfirmations,
        address: simulatedOrder.payment!.address || simulatedOrder.depositAddress || '', detectedAt: simulatedOrder.payment!.detectedAt,
      }, checkedAt: new Date().toISOString(), source: 'unavailable', network: simulatedOrder.network || 'testnet', simulated: true })
      showToast('Demo payment confirmed. Continue to the fiat payout step.')
    } catch (error) {
      setPaymentMonitorError(error instanceof Error ? error.message : 'Demo payment could not be simulated.')
    } finally { setSimulatingPayment(false) }
  }
  const cancelTransaction = async () => {
    if (!order || order.status !== 'AWAITING_ZEC' || order.payment || paymentCheck?.payment) return
    setCancellingOrder(true)
    setPaymentMonitorError('')
    setCancelError('')
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(order.id)}/cancel`, { method: 'POST', headers: { Accept: 'application/json' } })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 409) {
          try {
            const tracking = await fetchTransactionTracking(order.id)
            const latest = syncTransactionStatus(order.id, tracking.status, tracking.statusHistory, tracking.statusTimestamps)
            if (latest) setOrder({ ...latest, payment: tracking.payment ?? undefined, lastError: tracking.lastError ?? null })
          } catch {}
        }
        throw new Error(data.error || `Cancellation failed (${response.status})`)
      }
      if (data.order) {
        persistTransactionOrder(data.order)
        setOrder(data.order)
        setStep(1)
        setCancelDialogOpen(false)
        setCancelAcknowledged(false)
        showToast('Transaction cancelled.')
      }
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : 'Transaction cancellation failed.')
    } finally { setCancellingOrder(false) }
  }

  const registerOrderWithMonitor = async (created: TransactionOrder) => {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(created),
    })
    const data = await response.json() as TransactionOrder & { error?: string }
    if (!response.ok) throw new Error(data.error || 'The transaction order could not be registered with the payment monitor.')
    persistTransactionOrder(data)
    setOrder(data)
    return data
  }
  const continueToDetails = () => {
    if (numericAmount < MIN_AMOUNT[currency]) return showToast(amountError || 'Enter a valid amount.')
    if (!conversion) return showToast('Wait for a live ZEC quote before continuing.')
    setStep(2)
  }
  const submitDetails = () => {
    setTouched({ accountNumber: true, accountName: true, bankName: true })
    if (!bankValid) return
    setStep(3)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Private Bill home"><span className="brand-mark">Z</span><span><strong>PRIVATE BILL</strong><small>Powered by Zcash</small></span></a>
        <div className={`network-pill ${rates && !rateError ? 'is-live' : ''}`}><span className="pulse" />{marketStatus}</div>
      </header>

      <main id="top" className="main-grid">
        <section className="intro">
          <div className="eyebrow"><span className="shield">◈</span> PRIVATE PAYMENTS · REAL-WORLD MONEY</div>
          <h1>Private payments.<br /><em>Real-world money.</em></h1>
          <p className="lead">Create a local-currency payment request, receive ZEC privately, and follow every step toward a local payout. Built for people and merchants who need privacy without losing sight of payment status.</p>

          <div className="market-card"><div><span className="market-label">ZEC / USD</span><strong>{rates ? formatUsd(rates.zecUsd) : '—'}</strong><small>{rates ? `Live · ${rates.source}` : rateError || 'Waiting for market data'}</small></div><button className="refresh" onClick={() => void loadRates()} disabled={loadingRates} aria-label="Refresh market rates"><span className={loadingRates ? 'spin' : ''}>↻</span></button></div>

          <div className="trust-row">
            <div className={step >= 1 ? 'active' : ''}><span>01</span><p>Set amount</p></div>
            <div className={step >= 2 ? 'active' : ''}><span>02</span><p>Recipient details</p></div>
            <div className={step >= 3 ? 'active' : ''}><span>03</span><p>Review</p></div>
          </div>
        </section>

        <section className="card-wrap" aria-label="Private Bill payment flow">
          <div className="exchange-card">
            <div className="flow-progress five"><div className="flow-progress-line"><span style={{ width: `${((step - 1) / 4) * 100}%` }} /></div><div className="flow-step"><b className={step >= 1 ? 'done' : ''}>{step > 1 ? '✓' : '1'}</b><span>Amount</span></div><div className="flow-step"><b className={step >= 2 ? 'done' : ''}>{step > 2 ? '✓' : '2'}</b><span>Recipient</span></div><div className="flow-step"><b className={step >= 3 ? 'done' : ''}>{step > 3 ? '✓' : '3'}</b><span>Review</span></div><div className="flow-step"><b className={step >= 4 ? 'done' : ''}>{step >= 4 ? '✓' : '4'}</b><span>Order</span></div><div className="flow-step"><b className={step >= 5 ? 'done' : ''}>{step >= 5 ? '✓' : '5'}</b><span>Pay ZEC</span></div></div>

            {step === 1 && <>
              <div className="card-head"><div><span className="kicker">CREATE A PAYMENT REQUEST · STEP 1</span><h2>How much should they receive?</h2></div></div>
              <div className="field-label">LOCAL CURRENCY</div>
              <div className={`amount-box ${amountError ? 'has-error' : ''}`}>
                <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Recipient amount" placeholder="0" />
                <div className="currency-picker"><button className="currency-trigger" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}><span className="flag">{selected.flag}</span><span>{currency}</span><span className="chevron">⌄</span></button>{menuOpen && <div className="currency-menu">{(Object.keys(CURRENCIES) as Currency[]).map(code => <button key={code} onClick={() => chooseCurrency(code)}><span>{CURRENCIES[code].flag}</span><span>{code}</span><small>{CURRENCIES[code].name}</small></button>)}</div>}</div>
              </div>
              {amountError && <p className="field-error">{amountError}</p>}
              <div className="rate-line"><span>{loadingRates ? 'Fetching live rate…' : rateError ? 'Rate unavailable' : 'Live conversion rate'}</span><span>{conversion ? `1 ZEC ≈ ${selected.symbol}${formatRate(conversion.fiatPerZec, currency)}` : '—'}</span></div>
              <div className="connector"><span>↓</span></div>
              <div className="field-label">YOU PAY</div>
              <div className={`zec-box ${!conversion ? 'is-unavailable' : ''}`}><div><strong>{conversion ? formatZec(roundUpToZatoshi(conversion.zecAmount)) : '—'}</strong><span>ZEC</span></div><span className="zec-badge">Z</span></div>
              <div className="quote-grid"><div><span>Recipient receives</span><strong>{formatFiat(numericAmount, currency)}</strong></div><div><span>Approx. value</span><strong>{conversion ? formatUsd(conversion.usdValue) : '—'}</strong></div><div><span>ZEC market price</span><strong>{rates ? formatUsd(rates.zecUsd) : '—'}</strong></div><div><span>Rate updated</span><strong>{lastUpdated}</strong></div></div>
              <div className={`notice ${rateError ? 'notice-error' : ''}`}><span className="notice-icon">i</span><p>{rateError ? `${rateError} No hard-coded exchange rate is used. Refresh and try again.` : 'Live market data is used for the quote. Your recipient details are collected only in the next step.'}</p></div>
              <button className="primary" onClick={continueToDetails} disabled={loadingRates || !conversion}>Continue to recipient <span>→</span></button>
              <p className="status-text">{status}</p>
            </>}

            {step === 2 && <>
              <div className="card-head details-head"><div><span className="kicker">STEP 2 OF 3</span><h2>Where should it go?</h2><p className="subhead">Enter the recipient's bank details. Nothing is sent yet.</p></div><span className="secure-chip">🔒 Private</span></div>
              <div className="amount-summary"><div><span>Recipient receives</span><strong>{formatFiat(numericAmount, currency)}</strong></div><div><span>You pay</span><strong>{conversion ? `${formatZec(roundUpToZatoshi(conversion.zecAmount))} ZEC` : '—'}</strong></div></div>
              <div className="details-form">
                <div className="form-field full"><label htmlFor="country">Country & currency</label><div className="locked-select"><span>{selected.flag}</span><div><strong>{selected.country}</strong><small>{currency} · {selected.name}</small></div><span className="lock">✓</span></div><p className="helper">Matched automatically to the currency selected above.</p></div>
                <div className="form-field full"><label>Recipient bank</label><div className={`bank-combobox ${touched.bankName && bankErrors.bankName ? 'invalid' : ''}`}><button type="button" className="bank-trigger" onClick={() => setBankMenuOpen(!bankMenuOpen)} aria-expanded={bankMenuOpen}><span className="bank-avatar">{bank.bankName ? bank.bankName.charAt(0) : '⌕'}</span><span className={bank.bankName ? 'selected-bank-name' : 'placeholder'}>{bank.bankName || 'Search a bank, fintech or wallet'}</span><span className="chevron">⌄</span></button>{bankMenuOpen && <div className="bank-menu"><div className="bank-search-wrap"><span>⌕</span><input autoFocus value={bankSearch} onChange={e => setBankSearch(e.target.value)} placeholder="Search banks…" aria-label="Search banks" /></div><div className="bank-results">{loadingBanks ? <div className="bank-empty">Loading financial providers…</div> : bankLoadError ? <div className="bank-empty bank-error-state">{bankLoadError}<button type="button" onClick={() => setBankMenuOpen(false)}>Close and retry</button></div> : filteredBanks.length ? providerGroups.map(group => { const items = filteredBanks.filter(item => item.type === group.type); return items.length ? <div className="bank-group" key={group.type}><div className="bank-group-label">{group.label}</div>{items.map(item => <button type="button" className="bank-option" key={item.id} onClick={() => { setBank({ ...bank, bankName: item.name, bankCode: item.code || '' }); setBankMenuOpen(false); setBankSearch(''); setTouched({ ...touched, bankName: true }) }}><span className="bank-avatar">{item.name.charAt(0)}</span><span><strong>{item.name}</strong><small>{providerLabel(item.type)} · {item.code ? `code ${item.code}` : 'account / wallet number'}</small></span>{bank.bankName === item.name && <b>✓</b>}</button>)}</div> : null }) : <div className="bank-empty">No financial providers match “{bankSearch}”.</div>}</div></div>}</div>{touched.bankName && bankErrors.bankName && <p className="field-error">{bankErrors.bankName}</p>}<p className="helper">Choose a traditional bank, fintech/digital bank, or supported wallet. The provider type and code are retained for the next transaction stage.</p></div>
                <div className="form-field"><label htmlFor="accountNumber">Account number</label><input id="accountNumber" inputMode="numeric" autoComplete="off" value={bank.accountNumber} onChange={e => setBank({ ...bank, accountNumber: e.target.value.replace(/[^A-Za-z0-9\- ]/g, '') })} onBlur={() => setTouched({ ...touched, accountNumber: true })} placeholder="Enter account number" className={touched.accountNumber && bankErrors.accountNumber ? 'invalid' : ''} />{touched.accountNumber && bankErrors.accountNumber && <p className="field-error">{bankErrors.accountNumber}</p>}</div>
                <div className="form-field full"><label htmlFor="accountName">Account name</label><input id="accountName" autoComplete="name" value={bank.accountName} onChange={e => setBank({ ...bank, accountName: e.target.value })} onBlur={() => setTouched({ ...touched, accountName: true })} placeholder="Enter the name on the account" className={touched.accountName && bankErrors.accountName ? 'invalid' : ''} />{touched.accountName && bankErrors.accountName && <p className="field-error">{bankErrors.accountName}</p>}</div>
              </div>
              <div className="privacy-note"><span>◈</span><div><strong>We keep this step minimal.</strong><p>Bank details stay in the current transaction flow and are not written to logs by this interface.</p></div></div>
              <div className="button-row"><button className="secondary" onClick={() => setStep(1)}>← Back</button><button className="primary" onClick={submitDetails} disabled={!conversion}>Review details <span>→</span></button></div>
            </>}

            {step === 3 && <>
              <div className="card-head details-head"><div><span className="kicker">STEP 3 OF 3</span><h2>Review before sending</h2><p className="subhead">Check the details below. The next stage can use this transaction data.</p></div><span className="secure-chip">✓ Ready</span></div>
              <div className="review-amount"><span>Recipient receives</span><strong>{formatFiat(numericAmount, currency)}</strong><small>{selected.flag} {selected.name}</small></div>
              <div className="review-zec"><div><span>Required ZEC</span><strong>{conversion ? `${formatZec(roundUpToZatoshi(conversion.zecAmount))} ZEC` : '—'}</strong></div><span>Live quote · updated {lastUpdated}</span></div>
              <div className="review-list"><div><span>Recipient gets</span><strong>{formatFiat(numericAmount, currency)}</strong></div><div><span>Exchange rate</span><strong>{conversion ? `1 ZEC ≈ ${selected.symbol}${formatRate(conversion.fiatPerZec, currency)}` : '—'}</strong></div><div><span>ZEC / USD</span><strong>{rates ? formatUsd(rates.zecUsd) : '—'}</strong></div><div><span>Bank / provider</span><strong>{bank.bankName}</strong></div><div><span>Account name</span><strong>{bank.accountName}</strong></div><div><span>Account number</span><strong>{maskAccount(bank.accountNumber)}</strong></div><div><span>Destination</span><strong>{selected.country} · {currency}</strong></div><div><span>Fees</span><strong>Not added in this stage</strong></div></div>
              <div className="review-warning"><span>!</span><p>Review carefully before continuing. No order, bank transfer, or ZEC transaction is created or initiated by this screen.</p></div>
              {orderCreationError && <div className="transaction-error" role="alert"><strong>Order creation failed</strong><span>{orderCreationError}</span><small>Your details are still here. You can retry without filling the form again.</small></div>}
              <div className="button-row"><button className="secondary" onClick={() => setStep(2)} disabled={creatingOrder}>← Edit details</button><button className="primary" disabled={creatingOrder || !conversion} onClick={async () => {
                if (!conversion) { setOrderCreationError('Live ZEC quote is unavailable. Refresh the quote before creating an order.'); return }
                setCreatingOrder(true)
                setOrderCreationError('')
                const created = createTransactionOrder({
                  fiatCurrency: currency,
                  fiatAmount: numericAmount,
                  requiredZec: roundUpToZatoshi(conversion.zecAmount),
                  recipient: { providerName: bank.bankName, providerCode: bank.bankCode, providerType: 'payment_provider', accountNumber: bank.accountNumber, accountName: bank.accountName, country: bank.country, currency: bank.currency },
                })
                try {
                  await registerOrderWithMonitor(created)
                  setPaymentCheck(null)
                  setPaymentMonitorError('')
                  setStep(4)
                } catch (error) {
                  setOrderCreationError(error instanceof Error ? error.message : 'Payment monitor registration failed. Please retry.')
                } finally {
                  setCreatingOrder(false)
                }
              }}>{creatingOrder ? 'Creating order…' : 'Confirm & create order'} {!creatingOrder && <span>→</span>}</button></div>
            </>}

            {step === 4 && order && <>
              <div className="card-head details-head"><div><span className="kicker">ORDER CREATED</span><h2>Payment order is ready</h2><p className="subhead">Your transaction has been created and is now waiting for ZEC payment.</p></div><span className="secure-chip">✓ {order.status}</span></div>
              <div className="order-success"><span>ORDER ID</span><strong>{order.id}</strong><small>Keep this ID to track the transaction.</small></div>
              <div className="review-list"><div><span>Status</span><strong>{order.status}</strong></div><div><span>Recipient receives</span><strong>{formatFiat(order.fiatAmount, order.fiatCurrency)}</strong></div><div><span>Required ZEC</span><strong>{formatZec(order.requiredZec)} ZEC</strong></div><div><span>Recipient</span><strong>{order.recipient.accountName}</strong></div><div><span>Provider</span><strong>{order.recipient.providerName}</strong></div><div><span>Account</span><strong>{maskAccount(order.recipient.accountNumber)}</strong></div><div><span>Created</span><strong>{new Date(order.createdAt).toLocaleString()}</strong></div><div><span>Expires</span><strong>{new Date(order.expiresAt).toLocaleString()}</strong></div></div>
              <div className="review-warning"><span>✓</span><p>The order is persistent in this demo and begins in <strong>AWAITING_ZEC</strong>. The next stage can retrieve it using the order ID.</p></div>
              <div className="receipt-actions"><button className="secondary" onClick={() => setReceiptPreviewOpen(true)}>▣ Preview receipt</button><button className="secondary" onClick={saveReceipt}>↓ Download receipt</button><button className="secondary" onClick={printOrSaveReceipt}>Print / Save as PDF</button></div>
              {order.lastError && <div className="transaction-error" role="alert"><strong>{order.lastError.code.replace(/_/g, ' ')}</strong><span>{order.lastError.message}</span></div>}
              <button className="primary" onClick={() => { setAddressCopied(false); setStep(5) }}>Continue to payment <span>→</span></button>
            </>}

            {step === 5 && order && <>
              <div className="card-head details-head"><div><span className="kicker">STEP 5 · ZEC PAYMENT</span><h2>Fund your transaction</h2><p className="subhead">Send ZEC to the address assigned to this order. Payment status is checked by the transaction monitor.</p></div><span className={`secure-chip ${order.status === 'COMPLETED' ? 'success' : ''}`}>● {paymentStatusLabel(paymentCheck?.state ?? order.status as never)}</span></div>
              <div className="payment-hero"><span>YOU NEED TO SEND</span><strong>{formatZec(order.requiredZec)} <small>ZEC</small></strong><p>Order <b>{order.id}</b> will only be funded after a trusted payment monitor detects the on-chain payment.</p></div>
              {order.depositAddressMode === 'shared-demo' && <div className="review-warning" role="status"><span>TESTNET</span><p><strong>Shared demo address:</strong> this compatibility mode is for testing the flow only. Do not send real funds. Configure Zallet or a unique address pool before production.</p></div>}
              {(order.payment?.simulated || paymentCheck?.simulated) && <div className="review-warning" role="status"><span>DEMO</span><p><strong>Simulated payment:</strong> no ZEC was sent or received. This test lets you continue through the payout and tracking screens.</p></div>}
              <div className="payment-address"><div className="payment-address-head"><div><span className="field-label">ZEC RECEIVING ADDRESS</span><small>{order.depositAddressMode === 'shared-demo' ? 'Shared testnet demo address · do not send real funds' : 'Unique destination for this order'}</small></div><span className="address-badge">{order.network || 'ZEC'}</span></div>{order.depositAddress && <div className="payment-qr" role="img" aria-label="Scan this QR code with a Zcash wallet to enter the order's receiving address"><QRCodeSVG value={order.depositAddress} size={176} level="M" includeMargin bgColor="#ffffff" fgColor="#111318" /><small>Scan with your Zcash wallet</small></div>}<div className="address-row"><code>{order.depositAddress || 'Address unavailable'}</code><button className="copy-button" disabled={!order.depositAddress} onClick={async () => { if (!order.depositAddress) return; try { await navigator.clipboard.writeText(order.depositAddress); setAddressCopied(true); window.setTimeout(() => setAddressCopied(false), 2200) } catch { showToast('Copy failed. Please copy the address manually.') } }} aria-label="Copy ZEC receiving address">{addressCopied ? '✓ Copied' : 'Copy address'}</button></div><button className="secondary copy-instructions" disabled={!order.depositAddress} onClick={async () => { const details = `Private Bill payment request\nOrder: ${order.id}\nAmount: ${formatZec(order.requiredZec)} ZEC\nNetwork: ${order.network || 'Zcash'}\nReceiving address: ${order.depositAddress}\nRecipient receives: ${formatFiat(order.fiatAmount, order.fiatCurrency)}\nStatus: ${STATUS_LABELS[order.status] || order.status}\n\nOnly send on the displayed network. Verify the address and amount before confirming.`; try { await navigator.clipboard.writeText(details); showToast('Payment instructions copied. Share them securely with the payer.') } catch { showToast('Could not copy instructions. Copy the address and amount separately.') } }}>Copy payment instructions</button></div>
              <div className="payment-meta"><div><span>Order ID</span><strong>{order.id}</strong></div><div><span>Current status</span><strong>{paymentStatusLabel(paymentCheck?.state ?? order.status as never)}</strong></div><div><span>Recipient receives</span><strong>{formatFiat(order.fiatAmount, order.fiatCurrency)}</strong></div><div><span>Destination</span><strong>{order.recipient.country} · {order.fiatCurrency}</strong></div><div><span>Payment expires</span><strong>{new Date(order.expiresAt).toLocaleString()}</strong></div><div><span>Last checked</span><strong>{paymentCheck ? new Date(paymentCheck.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not checked yet'}</strong></div></div>
              <div className="status-timeline" aria-label="Transaction status timeline">
                {CORE_STATUS_FLOW.map(status => {
                  const currentStatus = (paymentCheck?.state ?? order.status) as TransactionStatus
                  return (
                    <div key={status} className={`status-timeline-item ${statusStepClass(status, currentStatus)}`}>
                      <span className="status-timeline-dot" />
                      <div><strong>{STATUS_LABELS[status]}</strong><small>{order.statusTimestamps?.[status] ? new Date(order.statusTimestamps[status]!).toLocaleString() : 'Pending'}</small></div>
                    </div>
                  )
                })}
              </div>
              <div className={`monitor-status ${paymentCheck?.state === 'ZEC_CONFIRMED' ? 'is-confirmed' : ''}`}><div className="monitor-dot" /><div><strong>{paymentStatusLabel(paymentCheck?.state ?? order.status as never)}</strong><p>{checkingPayment ? 'Checking the payment monitor…' : paymentMonitorError ? 'The monitor could not be reached. The order remains unfunded until a trusted check succeeds.' : paymentCheck?.payment ? `${formatZec(paymentCheck.payment.amountZec)} ZEC detected in transaction ${paymentCheck.payment.txid.slice(0, 12)}… with ${paymentCheck.payment.confirmations} confirmation${paymentCheck.payment.confirmations === 1 ? '' : 's'}.` : 'No qualifying payment has been detected yet. This screen never treats a client-side “sent” action as proof of payment.'}</p></div></div>
              {paymentCheck?.payment && <div className="payment-detection"><div><span>Detected amount</span><strong>{formatZec(paymentCheck.payment.amountZec)} ZEC</strong></div><div><span>Confirmations</span><strong>{paymentCheck.payment.confirmations} / {paymentCheck.payment.requiredConfirmations}</strong></div><div><span>Transaction</span><strong>{paymentCheck.payment.txid.slice(0, 18)}…</strong></div></div>}
              {(order.lastError || paymentCheck?.error) && <div className="transaction-error" role="alert"><strong>{order.lastError?.code?.replace(/_/g, ' ') || 'PAYMENT CHECK ERROR'}</strong><span>{order.lastError?.message || paymentCheck?.error}</span>{(order.lastError?.retryable || paymentCheck?.retryable) && <small>Retrying is safe; the transaction will not be marked completed unless the backend confirms the required state.</small>}</div>}
              <div className="payment-instructions"><div className="instruction-icon">1</div><div><strong>Open your Zcash wallet</strong><p>Choose ZEC on the <b>{order.network || 'displayed'}</b> network and scan or copy this order's receiving address.</p></div><div className="instruction-icon">2</div><div><strong>Send the required amount</strong><p>Send exactly <b>{formatZec(order.requiredZec)} ZEC</b>. Your wallet may charge its network fee separately.</p></div><div className="instruction-icon">3</div><div><strong>Wait for detection and confirmations</strong><p>Keep this order ID. The application updates only from trusted payment-monitor data, not from a browser button.</p></div></div>
              {paymentSimulationEnabled && order.status === 'AWAITING_ZEC' && <div className="payout-card"><div><span className="kicker">DEVELOPMENT ONLY</span><h3>Continue the flow without sending ZEC</h3><p>This creates a clearly marked simulated confirmation for this order. It does not move funds.</p></div><button className="secondary" onClick={simulatePayment} disabled={simulatingPayment}>{simulatingPayment ? 'Simulating…' : 'Simulate payment'}</button></div>}
              <div className="payment-warning"><span>!</span><p><strong>Important:</strong> Do not rely on a wallet “sent” message as proof of funding. The order is not considered funded until the payment monitor detects the transaction at the correct address and records it against this order.</p></div>
              {(order.status === 'ZEC_CONFIRMED' || order.status === 'PAYOUT_FAILED') && <div className="payout-card">
                <div><span className="kicker">FIAT PAYOUT</span><h3>{order.status === 'PAYOUT_FAILED' ? 'Retry the fiat payout' : 'Ready to pay the recipient'}</h3><p>{formatFiat(order.fiatAmount, order.fiatCurrency)} will be sent to {order.recipient.accountName} via {order.recipient.providerName}.</p></div>
                <button className="primary" onClick={handlePayout} disabled={processingPayout}>{processingPayout ? 'Processing payout…' : order.status === 'PAYOUT_FAILED' ? 'Retry payout' : 'Process fiat payout'}</button>
              </div>}
              {order.payout && <div className="payment-detection"><div><span>Payout status</span><strong>{order.payout.status}</strong></div><div><span>Provider</span><strong>{order.payout.provider}</strong></div><div><span>Attempts</span><strong>{order.payout.attempts.length}</strong></div><div><span>Reference</span><strong>{order.payout.providerReference ? order.payout.providerReference.slice(0, 18) + '…' : 'Pending'}</strong></div></div>}
              {payoutError && <div className="monitor-error" role="alert"><strong>Payout failed.</strong><span>{payoutError}</span></div>}
              <div className="tracking-launch">
                <div><span>TRANSACTION TRACKING</span><strong>Follow this transaction live</strong><p>The tracker reads the current transaction state from the backend.</p></div>
                <button className="secondary" onClick={() => setStep(6)}>Track transaction →</button>
              </div>
              <div className="receipt-actions"><button className="secondary" onClick={() => setReceiptPreviewOpen(true)}>▣ Preview receipt</button><button className="secondary" onClick={saveReceipt}>↓ Download receipt</button><button className="secondary" onClick={printOrSaveReceipt}>Print / Save as PDF</button><button className="secondary" onClick={goHome}>⌂ Back to home</button></div>
              {paymentMonitorError && <div className="monitor-error" role="alert"><strong>Payment monitor unavailable.</strong><span>{paymentMonitorError}</span><button className="secondary" onClick={async () => { setCheckingPayment(true); setPaymentMonitorError(''); try { const result = await paymentMonitor.check(order); setPaymentCheck(result); if (result.payment) { const updated = updateTransactionPayment(order.id, toOrderPayment(result.payment), result.state as TransactionOrder['status']); if (updated) setOrder(updated) } const synced = syncTransactionStatus(order.id, result.state as TransactionOrder['status'], result.statusHistory, result.statusTimestamps); if (synced) setOrder(synced) } catch (error) { setPaymentMonitorError(error instanceof Error ? error.message : 'Payment status is temporarily unavailable.') } finally { setCheckingPayment(false) } }}>Retry check</button></div>}
              <div className="button-row">{order.status === 'AWAITING_ZEC' && !cancellationHasFunds && <button className="secondary" onClick={() => { setCancelError(''); setCancelAcknowledged(false); setCancelDialogOpen(true) }}>Cancel transaction</button>}{cancellationHasFunds && order.status !== 'CANCELLED' && <div className="cancel-hold" role="status"><strong>Payment activity detected</strong><span>Cancellation is paused because ZEC may already have been sent. This demo cannot return ZEC automatically. Keep monitoring or contact the operator for manual recovery.</span></div>}<button className="secondary" onClick={() => setStep(4)}>← Back to order</button><button className="primary" onClick={async () => { setCheckingPayment(true); setPaymentMonitorError(''); try { const result = await paymentMonitor.check(order); setPaymentCheck(result); if (result.payment) { const updated = updateTransactionPayment(order.id, toOrderPayment(result.payment), result.state as TransactionOrder['status']); if (updated) setOrder(updated) } const synced = syncTransactionStatus(order.id, result.state as TransactionOrder['status'], result.statusHistory, result.statusTimestamps); if (synced) setOrder(synced); if (!result.payment) showToast('No qualifying ZEC payment detected yet.') } catch (error) { setPaymentMonitorError(error instanceof Error ? error.message : 'Payment status is temporarily unavailable.') } finally { setCheckingPayment(false) } }}>{checkingPayment ? 'Checking…' : 'Check payment status'} <span>↻</span></button></div>
            </>}

            {step === 6 && order && <>
              <div className="card-head details-head">
                <div><span className="kicker">TRANSACTION TRACKING</span><h2>Track your transaction</h2><p className="subhead">This timeline reflects the transaction state stored by the backend. It refreshes automatically while this page is open.</p></div>
                <span className={`secure-chip ${order.status === 'COMPLETED' ? 'success' : ''}`}>● {STATUS_LABELS[order.status]}</span>
              </div>
              {order.payment?.simulated && <div className="review-warning" role="status"><span>DEMO</span><p><strong>Simulated payment:</strong> this order advanced without a real ZEC transfer. The fiat payout also uses the configured demo provider unless a real provider is integrated.</p></div>}
              <div className="tracking-id"><span>TRANSACTION / ORDER ID</span><strong>{order.id}</strong></div>
              <div className="tracking-summary">
                <div><span>Recipient receives</span><strong>{formatFiat(order.fiatAmount, order.fiatCurrency)}</strong></div>
                <div><span>Required ZEC</span><strong>{formatZec(order.requiredZec)} ZEC</strong></div>
                <div><span>Recipient</span><strong>{order.recipient.accountName}</strong></div>
                <div><span>Destination</span><strong>{order.recipient.country} · {order.fiatCurrency}</strong></div>
              </div>
              <div className="tracking-live"><span className="tracking-live-dot" /> <div><strong>Live transaction state</strong><p>Last checked from the backend automatically. Tracking refresh cycle: 5 seconds.</p></div></div>
              {order.status === 'CANCELLED' && <div className="cancel-result" role="status"><span className="cancel-result__mark">✓</span><div><strong>Order cancelled</strong><p>No fiat payout will be sent for this order.</p>{order.payment ? <p>The monitor recorded {formatZec(order.payment.receivedZec)} ZEC. Cancelling does not refund it automatically; keep the order ID and transaction ID for manual recovery.</p> : <p>No payment was recorded at cancellation. If you sent ZEC shortly before cancelling, keep this order ID and contact the operator; refunds are not automatic.</p>}</div></div>}
              {order.lastError && <div className="transaction-error" role="alert"><strong>{order.lastError.code.replace(/_/g, ' ')}</strong><span>{order.lastError.message}</span>{order.lastError.retryable && <small>You can retry the affected step. This transaction cannot become completed unless the backend reaches a valid payout-confirmed state.</small>}</div>}
              <div className="tracking-timeline" aria-label="Transaction progress">
                {getTrackingStages(order.status).map((stage) => {
                  const timestamp = order.statusTimestamps?.[stage.status]
                  return <div key={stage.status} className={`tracking-stage ${stage.done ? 'done' : ''} ${stage.current ? 'current' : ''}`}>
                    <div className="tracking-stage-marker">{stage.done ? '✓' : stage.current ? '●' : ''}</div>
                    <div><strong>{stage.label}</strong>{timestamp && <small>{new Date(timestamp).toLocaleString()}</small>}{stage.current && <p>Current transaction state</p>}</div>
                  </div>
                })}
                {!CORE_STATUS_FLOW.includes(order.status) && <div className={`tracking-stage exception ${order.status === 'COMPLETED' ? 'done' : 'current'}`}><div className="tracking-stage-marker">!</div><div><strong>{STATUS_LABELS[order.status]}</strong>{order.statusTimestamps?.[order.status] && <small>{new Date(order.statusTimestamps[order.status]!).toLocaleString()}</small>}<p>Exceptional transaction state</p></div></div>}
              </div>
              {order.payment && <div className="tracking-payment"><span>ZEC PAYMENT</span><div><strong>{formatZec(order.payment.receivedZec)} ZEC</strong><small>{order.payment.txid}</small></div><div><strong>{order.payment.confirmations} / {order.payment.requiredConfirmations}</strong><small>confirmations</small></div></div>}
              {order.payout && <div className="tracking-payment"><span>FIAT PAYOUT</span><div><strong>{formatFiat(order.payout.amount, order.payout.currency)}</strong><small>{order.payout.provider}</small></div><div><strong>{order.payout.status}</strong><small>{order.payout.providerReference || 'Provider reference pending'}</small></div></div>}
              {paymentMonitorError && <div className="monitor-error" role="alert"><strong>Status unavailable.</strong><span>{paymentMonitorError}</span></div>}
              <div className="button-row">{order.status === 'AWAITING_ZEC' && !cancellationHasFunds && <button className="secondary" onClick={() => { setCancelError(''); setCancelAcknowledged(false); setCancelDialogOpen(true) }}>Cancel transaction</button>}{cancellationHasFunds && order.status !== 'CANCELLED' && <div className="cancel-hold" role="status"><strong>Payment activity detected</strong><span>Cancellation is paused because ZEC may already have been sent. This demo cannot return ZEC automatically. Keep monitoring or contact the operator for manual recovery.</span></div>}<button className="secondary" onClick={() => setStep(5)}>← Back to payment</button>{(order.status === 'ZEC_CONFIRMED' || order.status === 'PAYOUT_FAILED') && <button className="primary" onClick={() => setStep(5)}>Manage payout <span>→</span></button>}<button className="secondary" onClick={() => setReceiptPreviewOpen(true)}>▣ Preview receipt</button><button className="secondary" onClick={saveReceipt}>↓ Save receipt</button><button className="secondary" onClick={printOrSaveReceipt}>Print / Save PDF</button><button className="secondary" onClick={goHome}>⌂ Back to home</button></div>
            </>}

          </div>
          <div className="card-foot"><span>🔒</span> Privacy-first flow · This browser stores only a masked account number for order recovery</div>
        </section>
      </main>

      <section className="project-about" aria-labelledby="about-private-bill">
        <div className="project-about__intro"><span className="kicker">ABOUT THE PROJECT</span><h2 id="about-private-bill">Private payments, with a clearer path to local money.</h2><p>Private Bill connects a Zcash-focused payment request to a practical local-currency payout journey. The experience is designed for individuals, merchants, freelancers, and communities in markets where mobile money and local bank rails matter.</p></div>
        <div className="project-about__steps"><article><span>01</span><h3>Choose the amount</h3><p>Enter how much the recipient should receive in NGN or GHS. The app estimates the ZEC required using the available exchange-rate feed.</p></article><article><span>02</span><h3>Create and fund an order</h3><p>Review the recipient details, create an order, then send ZEC to the displayed receiving address. The backend payment monitor—not a button click—must detect the payment.</p></article><article><span>03</span><h3>Track and keep a receipt</h3><p>Follow the recorded transaction status, keep the order ID and transaction reference, and download or print a receipt for your records.</p></article></div>
        <div className="route-map" aria-label="Private Bill intended payment route">
          <div className="route-map__heading"><span className="kicker">THE PRODUCT VISION</span><h3>One journey. Three layers.</h3><p>Privacy at payment, transparent settlement status, and a path to local money.</p></div>
          <div className="route-map__steps"><article><span>01</span><strong>Zcash</strong><small>Shielded payment</small><em className="route-state implemented">Payment flow</em></article><span className="route-arrow">→</span><article><span>02</span><strong>Solana</strong><small>USDC liquidity & settlement</small><em className="route-state planned">Integration in progress</em></article><span className="route-arrow">→</span><article><span>03</span><strong>Local rails</strong><small>Bank or mobile money</small><em className="route-state sandbox">Demo payout adapter</em></article></div>
        </div>
        <div className="project-about__note"><strong>Prototype transparency</strong><p>Private Bill is a prototype. Testnet/shared-address and simulated-payment modes are for demonstrations only. Real-world use requires verified unique deposit addresses, a production-grade Zcash monitor, and an integrated fiat payout provider. A receipt is a record of the app state, not independent proof of payment.</p></div>
      </section>

      <section className="feature-strip"><div><span className="feature-icon">◎</span><div><strong>Guided flow</strong><p>Amount → recipient → review.</p></div></div><div><span className="feature-icon">⌁</span><div><strong>Clear validation</strong><p>Errors appear beside the field that needs attention.</p></div></div><div><span className="feature-icon">◈</span><div><strong>Privacy by design</strong><p>No unnecessary sensitive data is exposed.</p></div></div></section>
      <footer><span>PRIVATE BILL · Zcash Privacy Developers Residency</span><span>Quest 12 · Final Integration & Demo Ready</span></footer>
      <dialog className="receipt-preview-dialog" ref={receiptPreviewRef} aria-labelledby="receipt-preview-title" onCancel={() => setReceiptPreviewOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setReceiptPreviewOpen(false) }}>
        <div className="receipt-preview-head"><div><span className="kicker">PRIVATE BILL · DOCUMENT</span><h2 id="receipt-preview-title">Receipt preview</h2><p>Review the receipt before saving or printing it.</p></div><button className="preview-close" onClick={() => setReceiptPreviewOpen(false)} aria-label="Close receipt preview">×</button></div>
        {order && <div className="receipt-paper"><div className="receipt-paper__brand"><span className="receipt-paper__mark">Z</span><div><strong>PRIVATE BILL</strong><small>Zcash-powered local currency payout flow</small></div><span className="receipt-paper__status">{STATUS_LABELS[order.status] ?? order.status}</span></div><h3>Transaction receipt</h3><p className="receipt-paper__muted">A record of the order details currently available to Private Bill.</p>{(order.payment?.simulated || order.depositAddressMode === 'shared-demo') && <div className="receipt-paper__demo"><strong>DEMO / TESTNET</strong><span>This receipt may represent a simulated payment or a shared test address. It is not proof of a real transfer or fiat payout.</span></div>}<div className="receipt-paper__rows">{[['Order ID', order.id], ['Created', new Date(order.createdAt).toLocaleString()], ['Status', STATUS_LABELS[order.status] ?? order.status], ['Recipient receives', formatFiat(order.fiatAmount, order.fiatCurrency)], ['Required ZEC', `${formatZec(order.requiredZec)} ZEC`], ['Recipient', order.recipient.accountName], ['Destination', `${order.recipient.country} · ${order.fiatCurrency}`], ['Provider', order.recipient.providerName], ['Account', maskAccount(order.recipient.accountNumber)], ['Deposit address', order.depositAddress ?? 'Not assigned'], ['ZEC transaction ID', order.payment?.txid ?? 'No on-chain payment recorded'], ['ZEC received', order.payment ? `${formatZec(order.payment.receivedZec)} ZEC` : 'Not detected'], ['Confirmations', order.payment ? `${order.payment.confirmations} / ${order.payment.requiredConfirmations}` : 'Not available'], ['Fiat payout status', order.payout?.status ?? 'Not processed'], ['Payout reference', order.payout?.providerReference ?? 'Not available'], ['Expires', new Date(order.expiresAt).toLocaleString()]].map(([label, value]) => <div className="receipt-paper__row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><p className="receipt-paper__fineprint">This receipt records the application state at the time it was generated. An order alone does not prove ZEC was received or a fiat payout completed.</p></div>}
        <div className="receipt-preview-actions"><button className="secondary" onClick={() => setReceiptPreviewOpen(false)}>Close preview</button><button className="secondary" onClick={saveReceipt}>↓ Download HTML</button><button className="primary" onClick={printOrSaveReceipt}>Print / Save PDF</button></div>
      </dialog>

      <dialog className="cancel-dialog" ref={cancelDialogRef} aria-labelledby="cancel-dialog-title" aria-describedby="cancel-dialog-description" onCancel={(event) => { if (cancellingOrder) event.preventDefault(); else setCancelDialogOpen(false) }} onClose={() => setCancelDialogOpen(false)}>
        <div className="cancel-dialog__eyebrow">PRIVATE BILL · ORDER CONTROL</div>
        <h2 id="cancel-dialog-title">Cancel this transaction?</h2>
        <p id="cancel-dialog-description">This closes the order and prevents a fiat payout.</p>
        {order?.status === 'AWAITING_ZEC' && !cancellationHasFunds ? <>
          <div className="cancel-dialog__warning"><strong>Already sent ZEC?</strong><span>Wait for the payment monitor before cancelling. A blockchain transfer cannot be reversed by closing this order, and this demo does not issue refunds automatically.</span></div>
          <label className="cancel-dialog__ack"><input type="checkbox" checked={cancelAcknowledged} onChange={event => setCancelAcknowledged(event.target.checked)} /><span>I understand that cancelling does not refund a ZEC transfer.</span></label>
          {cancelError && <div className="cancel-dialog__error" role="alert">{cancelError}</div>}
          <div className="cancel-dialog__actions"><button className="secondary" onClick={() => setCancelDialogOpen(false)} disabled={cancellingOrder}>Keep order</button><button className="cancel-dialog__danger" onClick={cancelTransaction} disabled={!cancelAcknowledged || cancellingOrder}>{cancellingOrder ? 'Cancelling…' : 'Cancel order'}</button></div>
        </> : <>
          <div className="cancel-dialog__warning"><strong>{cancellationHasFunds ? 'Payment activity is now visible.' : 'This order can no longer be cancelled.'}</strong><span>To protect your funds, cancellation is disabled. No automatic refund is available; keep monitoring or contact the operator for manual recovery.</span></div>
          <div className="cancel-dialog__actions"><button className="secondary" onClick={() => setCancelDialogOpen(false)}>Close</button></div>
        </>}
      </dialog>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

export default App
