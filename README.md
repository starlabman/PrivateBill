# Private Bill

## Integration, Testing & Final Polish

Quest 12 brings the complete Private Bill transaction flow together and prepares it for a final residency demonstration.

### Complete user journey

```text
Select NGN / GHS
      ↓
Enter fiat amount
      ↓
Calculate ZEC from live rates
      ↓
Enter recipient / bank details
      ↓
Review
      ↓
Create order
      ↓
Receive ZEC payment instructions
      ↓
ZEC detected & confirmed by the backend monitor
      ↓
Fiat payout
      ↓
Track progress
      ↓
Completed
```

The frontend never treats a browser-side timer or wallet “sent” message as proof of payment. Blockchain state is obtained through the backend payment monitor and persisted transaction state.

## Integrated modules

- Live NGN/GHS conversion using external market data
- Recipient and financial-provider selection with client + server validation
- Persistent order creation and status history
- Zebra / Zakura payment-monitor architecture
- ZEC detection, confirmation, underpayment, overpayment and expiry handling
- Fiat payout provider abstraction with mock sandbox provider
- Payout idempotency and retry handling
- Transaction tracking with backend-driven state
- Explicit cancellation handling
- Persisted error records and user-facing exception feedback
- Completion guard: only `FIAT_SENT → COMPLETED` can produce successful completion

## Reliability and failure handling

The final build covers:

| Scenario | Expected behaviour |
|---|---|
| Live exchange-rate failure | Quote unavailable; order creation is blocked |
| Invalid recipient | Server rejects the order with `INVALID_RECIPIENT` |
| Payment not detected | Order remains `AWAITING_ZEC`; retryable feedback is shown |
| Underpayment | `UNDERPAID`; no payout is started |
| Overpayment | `OVERPAID`; no payout is started |
| Expiry | `EXPIRED`; late funding does not silently complete the order |
| Zcash/network failure | `ZCASH_NETWORK_UNAVAILABLE`; persisted state is preserved |
| Payout failure | `PAYOUT_FAILED`; retry creates a controlled new attempt |
| Duplicate payout request | Request is rejected while processing / after terminal completion |
| Cancellation | `CANCELLED`; payout and completion are blocked |
| Invalid status transition | Backend rejects it through the status engine |

## Testing

Automated checks cover:

- status transition invariants
- full successful lifecycle
- payout success and failure
- payout retry/idempotency
- underpayment / overpayment / expiry
- persisted errors and error history
- cancellation safety
- invalid recipient validation
- exchange-rate conversion validation
- frontend integration markers and responsive layout checks
- live HTTP API integration using an isolated temporary database
- security hygiene checks for committed secrets/debug output

Run:

```bash
npm install
npm run check
npm test
npm run build
```

For the local demonstration:

```bash
npm run dev:full
```

Open the Vite URL shown by the dev server. The backend listens only on `127.0.0.1` by default.

## Deposit address setup

Copy .env.example to .env before starting the server so it loads the server-only address pool and network settings.

For shielded payments, configure `ZALLET_RPC_URL`, RPC authentication, and `ZALLET_ACCOUNT_UUID` in the server-only `.env`. Private Bill asks that account for a fresh Orchard-only Unified Address for each order, checks the wallet's known diversifier indexes to avoid reuse, and stores the address with the order before showing it to the customer. These addresses belong to the same Zallet account, so received funds are already available to that account; they do not need an automatic on-chain sweep to a second address. In Zallet mode the backend scans the account's transaction history and matches the exact order address. Zallet's current `z_listtransactions` API is experimental, so this integration must be exercised against the installed Zallet version before handling real payments. When a Zallet URL is configured, `auto` mode pins to Zallet and will not silently fall back to the transparent-only Zebra/Zakura scanners.

On non-production, non-mainnet server runs, the payment screen exposes a development-only simulated payment action. It records a visibly marked synthetic payment and advances the normal confirmation and demo payout flow; no ZEC is sent or received. This action is unavailable in production and on mainnet.

The payment screen shows the exact eight-decimal ZEC amount, a locally generated QR code for the order address, and a copy action. The backend checks open payment orders every 10 seconds, even when the customer closes the page. The browser can resume the most recent order after refresh; it stores only a masked account number while the backend retains the recipient details needed for payout.

`PRIVATE_BILL_DEPOSIT_ADDRESS_POOL` is retained only as an optional local-demo fallback when Zallet is not configured. When neither a Zallet account nor an unused fallback address is available, order creation fails closed.

If Zallet is not configured, the legacy Zebra/Zakura adapters scan transparent outputs only. That mode is for demos, not the privacy-first product flow. The payout provider is still a mock until an approved Ghana/Nigeria payout provider is integrated.

## Zcash node architecture
```text
React + Vite
     ↓
Node backend
     ↓
Payment Monitor
   ↙       ↘
Zebra     Zakura
     ↓
Transaction Status Engine
     ↓
Payout Provider
     ↓
Transaction Tracker
```

The backend supports the existing Zebra/Zakura + Zallet setup and the configured `mainnet`, `testnet`, or `regtest` environment.

## Security

- No RPC cookies or credentials are committed.
- No payout-provider secrets are committed.
- No private keys or seed phrases are used by the application.
- `.env` and `.env.*` are ignored except for `.env.example`.
- Runtime order data and logs are excluded from Git.
- The backend binds to loopback by default for local development.
- Recipient information is not displayed unnecessarily in the tracking UI.

## Demo notes

The default payout provider is a controlled mock provider. It is intentionally not presented as a real banking integration. A production payout adapter must be implemented server-side with approved provider credentials and operational controls.

The ZEC payment monitor requires a reachable configured Zebra/Zakura node for real on-chain detection. Without a reachable node, the application preserves the transaction state and reports a retryable network error instead of fabricating a successful payment.

## Order creation compatibility

The order API assigns a unique address from `PRIVATE_BILL_DEPOSIT_ADDRESS_POOL` or asks Zallet for a fresh shielded address. For a testnet demo only, if neither is configured, the server can use `PRIVATE_BILL_DEMO_RECEIVING_ADDRESS` (or the legacy `VITE_ZEC_RECEIVING_ADDRESS` variable). The network must be `testnet` or `regtest`; if `NODE_ENV=production`, explicitly set `PRIVATE_BILL_ALLOW_SHARED_DEMO_ADDRESS=true` to enable this shared-address demo mode. This is only for testing: do not receive real funds with a shared address. Configure Zallet or a unique address pool before production/mainnet use. Set the address as a server-side environment variable on your hosting provider; a frontend `VITE_` variable alone may not be available to the backend.

On the review screen, order creation failures are now shown inline with the server's error and a retry option. The button enters a loading state and prevents duplicate submissions while the API request is in flight.
