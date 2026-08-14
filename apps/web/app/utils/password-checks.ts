import { PASSWORD_MIN_LENGTH } from '@video/shared'

/**
 * The live checklist under the password pair on the signup form.
 *
 * Pure, so the interesting part — when a rule is allowed to complain — is
 * testable without rendering anything.
 *
 * Three states rather than two. A rule that is only ever "met" or "unmet" has
 * to pick one for a field nobody has touched, and both answers are wrong: a
 * tick is a lie, and a cross tells someone off for not having typed yet.
 * `pending` is the honest third answer, and it is what the form opens in.
 */
export type CheckState = 'pending' | 'met' | 'unmet'

export interface PasswordCheck {
  id: 'length' | 'match'
  label: string
  state: CheckState
}

export function passwordChecks(password: string, confirm: string): PasswordCheck[] {
  return [
    {
      id: 'length',
      // Built from the shared constant, so this line and the schema that
      // enforces it cannot come to disagree.
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      state: password === '' ? 'pending' : password.length >= PASSWORD_MIN_LENGTH ? 'met' : 'unmet',
    },
    {
      id: 'match',
      label: 'Passwords match',
      state:
        confirm === ''
          ? 'pending'
          : // Compared exactly: a trailing space is part of a password, and
            // trimming would tick this box on two values the API will store and
            // compare as different.
            password === confirm
            ? 'met'
            : 'unmet',
    },
  ]
}
