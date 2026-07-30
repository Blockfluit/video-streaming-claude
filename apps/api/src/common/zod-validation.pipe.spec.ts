import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  createCollectionSchema,
  deleteWithFilesSchema,
  listVideosSchema,
  loginSchema,
  pageQuerySchema,
  redeemSchema,
  updateUserSchema,
} from '@video/shared';
import { z } from 'zod';

import { ZodValidationPipe, validate } from './zod-validation.pipe';

/**
 * The pipe, and the shared schemas as seen through it — which is the pairing
 * that actually runs in production. The schemas live in `@video/shared` so the
 * frontend validates against the same objects.
 */
describe('ZodValidationPipe', () => {
  it('returns the parsed value', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string() }));

    expect(pipe.transform({ name: 'ada' })).toEqual({ name: 'ada' });
  });

  it('throws a 400 rather than letting a bad value through', () => {
    const pipe = validate(z.object({ name: z.string() }));

    expect(() => pipe.transform({ name: 42 })).toThrow(BadRequestException);
  });

  // A form needs to know which input was wrong, not just that something was.
  it('names the offending field, dotted for nested ones', () => {
    const pipe = validate(z.object({ outer: z.object({ inner: z.string() }) }));

    try {
      pipe.transform({ outer: { inner: 1 } });
      throw new Error('should have thrown');
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        errors: { field: string }[];
      };
      expect(response.errors[0].field).toBe('outer.inner');
    }
  });

  it('reports every problem at once, not just the first', () => {
    const pipe = validate(z.object({ a: z.string(), b: z.string() }));

    try {
      pipe.transform({ a: 1, b: 2 });
      throw new Error('should have thrown');
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as { errors: unknown[] };
      expect(response.errors).toHaveLength(2);
    }
  });

  /**
   * What the removed `whitelist: true` used to do. Zod objects strip unknown
   * keys by default, so a client still cannot smuggle an extra field through to
   * Prisma — worth pinning, because switching to `.passthrough()` anywhere would
   * silently undo it.
   */
  it('strips keys the schema does not declare', () => {
    const pipe = validate(createCollectionSchema);

    const result = pipe.transform({ title: 'Harry Potter', state: 'PUBLISHED', id: 'injected' });

    expect(result).toEqual({ title: 'Harry Potter' });
  });

  it('transforms as well as validates', () => {
    expect(validate(loginSchema).transform({ username: '  ADA  ', password: 'x' })).toEqual({
      username: 'ada',
      password: 'x',
    });
  });
});

describe('the shared schemas', () => {
  describe('pagination', () => {
    it('defaults to a bounded page rather than everything', () => {
      expect(pageQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    });

    it('reads limit and offset out of query strings', () => {
      expect(pageQuerySchema.parse({ limit: '10', offset: '20' })).toEqual({
        limit: 10,
        offset: 20,
      });
    });

    // The cap is the point: the worst-case response size is a property of the
    // API, not of whoever is calling it.
    it('refuses a limit above the cap instead of quietly clamping it', () => {
      expect(pageQuerySchema.safeParse({ limit: String(MAX_PAGE_LIMIT) }).success).toBe(true);
      expect(pageQuerySchema.safeParse({ limit: String(MAX_PAGE_LIMIT + 1) }).success).toBe(false);
      expect(pageQuerySchema.safeParse({ limit: '99999' }).success).toBe(false);
    });

    it('refuses a nonsensical page', () => {
      expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
      expect(pageQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
      expect(pageQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
      expect(pageQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
      expect(pageQuerySchema.safeParse({ limit: 'lots' }).success).toBe(false);
    });
  });

  describe('query booleans', () => {
    // z.coerce.boolean() follows JavaScript truthiness, so "false" becomes true.
    it('reads the string "false" as false', () => {
      expect(deleteWithFilesSchema.parse({ deleteFiles: 'false' }).deleteFiles).toBe(false);
      expect(deleteWithFilesSchema.parse({ deleteFiles: '0' }).deleteFiles).toBe(false);
    });

    it('reads the string "true" as true', () => {
      expect(deleteWithFilesSchema.parse({ deleteFiles: 'true' }).deleteFiles).toBe(true);
      expect(deleteWithFilesSchema.parse({ deleteFiles: '1' }).deleteFiles).toBe(true);
    });

    it('defaults to the safe option when the flag is absent', () => {
      expect(deleteWithFilesSchema.parse({}).deleteFiles).toBe(false);
    });

    it('refuses a value that is neither', () => {
      expect(deleteWithFilesSchema.safeParse({ deleteFiles: 'maybe' }).success).toBe(false);
    });
  });

  describe('list filters', () => {
    it('accepts a state a caller may legitimately ask for', () => {
      expect(listVideosSchema.parse({ state: 'DRAFT' }).state).toBe('DRAFT');
    });

    // Whether a USER may *see* drafts is the service's decision, not the
    // schema's — the schema only says the request is well-formed.
    it('refuses a state that is not a state at all', () => {
      expect(listVideosSchema.safeParse({ state: 'SECRET' }).success).toBe(false);
    });

    it('applies the page defaults to every list endpoint', () => {
      expect(listVideosSchema.parse({})).toMatchObject({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    });
  });

  describe('identity rules', () => {
    it('holds redemption to the username shape', () => {
      const valid = { token: 't', username: 'ada', password: 'a'.repeat(12) };

      expect(redeemSchema.safeParse(valid).success).toBe(true);
      expect(redeemSchema.safeParse({ ...valid, username: 'ad' }).success).toBe(false);
      expect(redeemSchema.safeParse({ ...valid, username: '.ada' }).success).toBe(false);
      expect(redeemSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
    });

    // displayName keeps the casing that was typed, so validation runs before
    // normalisation and the pattern has to accept uppercase.
    it('keeps the username as typed for redemption', () => {
      expect(redeemSchema.parse({ token: 't', username: '  Ada  ', password: 'a'.repeat(12) }))
        .toMatchObject({ username: 'Ada' });
    });

    it('lowercases for login, where the value is only ever matched', () => {
      expect(loginSchema.parse({ username: 'ADA', password: 'x' }).username).toBe('ada');
    });
  });

  describe('partial updates', () => {
    it('accepts a single field', () => {
      expect(updateUserSchema.safeParse({ displayName: 'Ada' }).success).toBe(true);
    });

    // An empty patch is a request that cannot mean anything.
    it('refuses a body with nothing in it', () => {
      expect(updateUserSchema.safeParse({}).success).toBe(false);
    });
  });
});
