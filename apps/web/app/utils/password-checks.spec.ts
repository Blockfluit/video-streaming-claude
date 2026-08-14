import { PASSWORD_MIN_LENGTH } from '@video/shared'
import { describe, expect, it } from 'vitest'

import { passwordChecks } from './password-checks'

/** Long enough to satisfy the length rule, whatever the shared minimum is. */
const LONG = 'a'.repeat(PASSWORD_MIN_LENGTH)

function stateOf(password: string, confirm: string, id: 'length' | 'match') {
  return passwordChecks(password, confirm).find(check => check.id === id)?.state
}

describe('passwordChecks', () => {
  it('reports both rules, in the order the fields appear', () => {
    expect(passwordChecks('', '').map(check => check.id)).toEqual(['length', 'match'])
  })

  it('says nothing about an empty form', () => {
    // A red cross beside "Passwords match" before anyone has typed is nagging,
    // not helpful. Both rules stay quiet until the field they judge has content.
    expect(passwordChecks('', '').map(check => check.state)).toEqual(['pending', 'pending'])
  })

  describe('the length rule', () => {
    it('is pending while the password box is empty', () => {
      expect(stateOf('', '', 'length')).toBe('pending')
    })

    it('is unmet one character short', () => {
      expect(stateOf('a'.repeat(PASSWORD_MIN_LENGTH - 1), '', 'length')).toBe('unmet')
    })

    it('is met at exactly the minimum', () => {
      expect(stateOf(LONG, '', 'length')).toBe('met')
    })

    it('does not care what the confirmation says', () => {
      expect(stateOf(LONG, 'something else', 'length')).toBe('met')
    })

    it('names the minimum, so the rule and the hint cannot disagree', () => {
      const length = passwordChecks('', '').find(check => check.id === 'length')
      expect(length?.label).toContain(String(PASSWORD_MIN_LENGTH))
    })
  })

  describe('the match rule', () => {
    it('is pending while the confirmation box is empty', () => {
      expect(stateOf(LONG, '', 'match')).toBe('pending')
    })

    it('is met when both sides agree', () => {
      expect(stateOf(LONG, LONG, 'match')).toBe('met')
    })

    it('is unmet when they differ', () => {
      expect(stateOf(LONG, `${LONG}x`, 'match')).toBe('unmet')
    })

    it('is unmet on a difference only at the end', () => {
      // The typo this whole field exists to catch is a single stray character.
      expect(stateOf(`${LONG}a`, `${LONG}b`, 'match')).toBe('unmet')
    })

    it('does not call two empty boxes a match', () => {
      // `'' === ''` is true, and reporting that as a satisfied rule would tick
      // the box on a form nobody has filled in.
      expect(stateOf('', '', 'match')).toBe('pending')
    })

    it('does not call an empty password matched by an empty confirmation', () => {
      expect(stateOf('', 'x', 'match')).toBe('unmet')
    })

    it('is judged on the exact string, not a trimmed one', () => {
      // A trailing space is part of a password. Trimming here would tick the
      // box on two values the server will treat as different.
      expect(stateOf(LONG, `${LONG} `, 'match')).toBe('unmet')
    })
  })
})
