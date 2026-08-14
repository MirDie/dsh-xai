import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readJson } from '../src/auth-routes.ts'
import {
  assertSafeAuthorizationUrl,
  isTerminalOAuthFailure,
  MAX_JSON_BODY_BYTES,
  RequestBodyTooLargeError,
  trustedRequest,
} from '../src/trust.ts'

function request(overrides: {
  remoteAddress?: string
  host?: string
  origin?: string
  site?: string
}) {
  return {
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
    headers: {
      host: overrides.host ?? '127.0.0.1:5173',
      ...overrides.origin === undefined ? {} : { origin: overrides.origin },
      ...overrides.site === undefined ? {} : { 'sec-fetch-site': overrides.site },
    },
  }
}

describe('trustedRequest', () => {
  it('accepts loopback host and matching origin', () => {
    expect(trustedRequest(request({
      origin: 'http://127.0.0.1:5173',
    }))).toBe(true)
  })

  it('rejects a rebound attacker host even from a loopback socket', () => {
    expect(trustedRequest(request({
      host: 'attacker.example:5173',
      origin: 'http://attacker.example:5173',
    }))).toBe(false)
  })

  it('rejects cross-site fetch metadata and non-loopback peers', () => {
    expect(trustedRequest(request({ site: 'cross-site' }))).toBe(false)
    expect(trustedRequest(request({ remoteAddress: '10.0.0.8' }))).toBe(false)
  })
})

describe('assertSafeAuthorizationUrl', () => {
  it('allows xAI auth hosts over https', () => {
    expect(assertSafeAuthorizationUrl('https://auth.x.ai/oauth2/device/verify')).toContain('auth.x.ai')
    expect(assertSafeAuthorizationUrl('https://accounts.x.ai/sign-in')).toContain('accounts.x.ai')
  })

  it('rejects http and unexpected hosts', () => {
    expect(() => assertSafeAuthorizationUrl('http://auth.x.ai/x')).toThrow(/unsafe/)
    expect(() => assertSafeAuthorizationUrl('https://evil.example/phish')).toThrow(/unexpected host/)
  })
})

describe('isTerminalOAuthFailure', () => {
  it('detects invalid_grant and ignores transport errors', () => {
    expect(isTerminalOAuthFailure(new Error('OAuth refresh failed: invalid_grant'))).toBe(true)
    expect(isTerminalOAuthFailure(new Error('xAI model listing is unreachable'))).toBe(false)
  })
})

describe('readJson', () => {
  it('rejects an oversized body', async () => {
    const stream = Readable.from([Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x61)])
    await expect(readJson(stream as never)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })
})
