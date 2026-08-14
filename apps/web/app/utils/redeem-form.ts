import { type RedeemFormInput, type RedeemInput, redeemSchema } from '@video/shared'

/**
 * The signup form's state, reduced to what `POST /auth/redeem` accepts.
 *
 * The form holds one field the endpoint does not declare — the password
 * confirmation — and this is the single place that guarantees it never travels.
 * Parsing through the endpoint's **own** schema is what drops it: zod objects
 * strip unknown keys, so the list of fields that reach the wire is the schema's
 * list rather than a second copy maintained here. A field added to
 * `redeemSchema` arrives automatically; one added to the form does not.
 *
 * Switching `redeemSchema` to `.passthrough()` would silently undo this, the
 * same way it would undo the whitelisting on every other endpoint.
 *
 * Parsing rather than deleting a key also means the value posted has been
 * through the same trim the server applies, so the username shown back on a
 * clash is the username that was actually submitted.
 */
export function redeemBody(state: RedeemFormInput): RedeemInput {
  return redeemSchema.parse(state)
}
