import { heartbeatSchema } from '@video/shared'
import { describe, expect, it, vi } from 'vitest'

import { newPlaySessionId } from './play-session'

/** An insecure context: `getRandomValues` is there, `randomUUID` is not. */
const insecure = {
  getRandomValues: <T extends ArrayBufferView>(array: T): T => {
    const bytes = new Uint8Array((array as unknown as Uint8Array).buffer)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 11) % 256
    return array
  },
}

describe('newPlaySessionId', () => {
  it('uses randomUUID where the platform offers it', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555' as const)
    expect(newPlaySessionId({ randomUUID } as Partial<Crypto>))
      .toBe('11111111-2222-4333-8444-555555555555')
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  /*
   * The case the player actually hit. `randomUUID` is a secure-context API, so
   * on a phone opening the dev server over plain HTTP it is `undefined` and
   * calling it threw during setup — which Nuxt reports as a 500 page.
   */
  it('still produces an id without randomUUID', () => {
    const id = newPlaySessionId(insecure as Partial<Crypto>)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  /*
   * The API is the reason it has to be a UUID rather than merely unique:
   * `playSessionId: z.uuid()`. Asserting against the real schema means this
   * cannot drift into something the endpoint would refuse on every beat.
   */
  it('produces something the heartbeat endpoint accepts', () => {
    const body = {
      playSessionId: newPlaySessionId(insecure as Partial<Crypto>),
      positionSec: 12,
      deltaSec: 4,
    }
    expect(heartbeatSchema.safeParse(body).success).toBe(true)
  })

  it('refuses to invent an id with no randomness to draw on', () => {
    // Sending a value the API rejects would lose every heartbeat for the rest
    // of the session, silently. Failing here is the louder, cheaper answer.
    expect(() => newPlaySessionId({} as Partial<Crypto>)).toThrow(/no crypto source/)
  })
})
