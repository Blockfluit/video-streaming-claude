/**
 * The API's own explanation of a refusal, or a fallback.
 *
 * The endpoints refuse things for reasons an admin can act on — "the last
 * active admin cannot be demoted", "that subtitle is not a WebVTT file" — and
 * throwing away that sentence to show "Something went wrong" turns a solvable
 * problem into a mystery.
 *
 * Three shapes have to be handled because Nest produces all three: a zod
 * failure arrives as `errors[]`, a `BadRequestException` with several messages
 * as `message[]`, and an ordinary one as a plain `message`.
 *
 * Lived in the video editor as a private function until a second screen needed
 * it. Extracted rather than copied — two divergent copies of "what did the
 * server say" is how one screen ends up silently swallowing errors.
 */
export function apiMessage(error: unknown, fallback: string): string {
  const data = (
    error as { data?: { message?: string | string[], errors?: { message: string }[] } }
  )?.data

  return (
    data?.errors?.[0]?.message
    ?? (Array.isArray(data?.message) ? data.message[0] : data?.message)
    ?? fallback
  )
}
