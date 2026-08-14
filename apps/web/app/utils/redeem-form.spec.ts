import { describe, expect, it } from 'vitest'

import { redeemBody } from './redeem-form'

const FILLED = {
  token: 'a-token',
  username: 'Ada',
  password: 'correct horse battery',
  confirmPassword: 'correct horse battery',
}

describe('redeemBody', () => {
  it('sends exactly the fields the endpoint declares', () => {
    // Pinned as a whole set rather than asserted key by key: the point is that
    // nothing *extra* travels, and a test that only checks the fields it knows
    // about cannot notice a new one arriving.
    expect(Object.keys(redeemBody(FILLED)).sort()).toEqual(['password', 'token', 'username'])
  })

  it('drops the confirmation', () => {
    expect(redeemBody(FILLED)).not.toHaveProperty('confirmPassword')
  })

  it('carries the answers through unchanged', () => {
    expect(redeemBody(FILLED)).toMatchObject({
      token: 'a-token',
      password: 'correct horse battery',
    })
  })

  it('keeps the username as typed, because the API stores that as the display name', () => {
    expect(redeemBody(FILLED).username).toBe('Ada')
  })

  it('trims the username the same way the endpoint would', () => {
    expect(redeemBody({ ...FILLED, username: '  Ada  ' }).username).toBe('Ada')
  })

  it('refuses input the endpoint would refuse', () => {
    // The stripping is a side effect of parsing, so the parse has to be real.
    // If this ever stops throwing, the body is being assembled by hand again
    // and the guarantee above is no longer enforced by anything.
    expect(() => redeemBody({ ...FILLED, username: 'no' })).toThrow()
  })
})
