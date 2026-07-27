import type { IncomingMessage } from 'node:http'

import { config } from './config.js'

/**
 * Is this request's `Origin` acceptable?
 *
 * A missing Origin is allowed: browsers always send one on cross-origin requests
 * and on every WebSocket handshake, so absence means a non-browser client (curl,
 * a script, a native app), which the token already gates. Presence means a
 * browser, and it must match the host being addressed.
 *
 * This matters most for WebSockets. `SameSite=Lax` normally stops a foreign page
 * attaching the session cookie to a cross-site handshake, but that is one browser
 * behaviour standing between an arbitrary tab and code execution on this machine.
 * An explicit check is the standard defence rather than relying on it.
 */
export function originAllowed(headers: IncomingMessage['headers']): boolean {
  const origin = headers.origin
  if (!origin || Array.isArray(origin)) return !origin

  let originHost: string
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }

  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host
  if (host && originHost === host.toLowerCase()) return true

  return config.allowedOrigins.includes(origin.toLowerCase())
}

/**
 * Response headers applied to everything.
 *
 * The CSP is strict `default-src 'none'` with each need enumerated. It is
 * defence-in-depth for the one `innerHTML` sink in the frontend (the markdown
 * renderer, which escapes before adding markup — but a CSP means a mistake there
 * is not automatically exploitable).
 *
 * `data:` is needed by `img-src` for the inline SVG favicon and the manifest icon.
 * Programmatic `element.style` assignments are unaffected by `style-src`.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // This is a private tool; there is no reason for a search engine that somehow
  // reached it to keep anything.
  'x-robots-tag': 'noindex, nofollow',
}
