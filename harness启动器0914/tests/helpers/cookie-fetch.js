'use strict'

/**
 * Cookie-aware fetch for tests.
 *
 * Electron's `session.fetch` behaves like a browser: it follows redirects and
 * applies `Set-Cookie` from each hop. Node's global fetch does neither, so
 * this helper drives the redirects by hand to reproduce the browser
 * semantics the launcher actually relies on. Using undici's own redirect
 * following would silently drop the cookie minted by the 303 and make the
 * authentication path look broken when it is not.
 */

/** Status codes that carry a Location to follow. */
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * Build a cookie-jar fetch.
 * @returns {(url: string, init?: object) => Promise<Response>} Cookie-aware fetch.
 */
function createCookieFetch () {
  /** @type {Map<string, Map<string, string>>} */
  const jar = new Map()

  /**
   * Serialize stored cookies for one origin.
   * @param {string} origin - Target origin.
   * @returns {string} Cookie header value.
   */
  const headerFor = (origin) => {
    const stored = jar.get(origin)
    if (stored === undefined || stored.size === 0) return ''
    return [...stored.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /**
   * Store cookies from a response.
   * @param {string} origin - Origin the response came from.
   * @param {Response} response - Response to absorb.
   * @returns {void}
   */
  const absorb = (origin, response) => {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : []
    for (const entry of raw) {
      const pair = entry.split(';')[0]
      const at = pair.indexOf('=')
      if (at <= 0) continue
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      const stored = jar.get(origin) ?? new Map()
      stored.set(name, value)
      jar.set(origin, stored)
    }
  }

  return async function cookieFetch (url, init = {}) {
    let current = url
    for (let hop = 0; hop <= REDIRECTS.size; hop += 1) {
      const origin = new URL(current).origin
      const headers = new Headers(init.headers ?? {})
      const cookie = headerFor(origin)
      if (cookie !== '' && init.credentials === 'include') headers.set('cookie', cookie)

      const response = await fetch(current, { ...init, headers, redirect: 'manual' })
      absorb(origin, response)

      const location = response.headers.get('location')
      if (REDIRECTS.has(response.status) && location !== null) {
        current = new URL(location, current).href
        continue
      }
      return response
    }
    throw new Error('too many redirects in the test cookie fetch')
  }
}

module.exports = { createCookieFetch }
