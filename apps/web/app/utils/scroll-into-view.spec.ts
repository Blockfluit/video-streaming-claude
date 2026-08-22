import { describe, expect, it, vi } from 'vitest'

import { reveal } from './scroll-into-view'

describe('reveal', () => {
  it('asks for the least scrolling on both axes', () => {
    const scrollIntoView = vi.fn()
    reveal({ scrollIntoView })

    /*
     * `nearest` on *both* is what stops a horizontal strip dragging the page
     * up with it — `inline` alone still lets the block axis default to
     * `start`, and the visible symptom is a tap on the admin nav scrolling
     * away whatever was being read.
     */
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('does nothing when there is nothing to reveal', () => {
    // A watcher can fire after the element it named has gone, and a ref is
    // null for the whole of the server render.
    expect(() => reveal(null)).not.toThrow()
    expect(() => reveal(undefined)).not.toThrow()
  })

  it('does nothing when the target cannot scroll itself into view', () => {
    // Guards the SSR shim case, where a ref holds something that is not a DOM
    // element and calling straight through would throw mid-render.
    expect(() => reveal({} as never)).not.toThrow()
  })
})
