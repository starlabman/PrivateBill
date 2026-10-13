import { readCookie } from './node-config.mjs'

export async function rpcCall({ url, method, params = [], user = '', password = '', cookiePath = '' }) {
  const headers = { 'content-type': 'application/json' }
  if (user || password) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  } else if (cookiePath) {
    const cookie = readCookie(cookiePath)
    if (cookie) headers.authorization = `Basic ${Buffer.from(cookie).toString('base64')}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  })

  const body = await response.text()
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}: ${body.slice(0, 500)}`)

  let json
  try { json = JSON.parse(body) } catch { throw new Error(`Invalid RPC JSON: ${body.slice(0, 500)}`) }
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`)
  return json.result
}
