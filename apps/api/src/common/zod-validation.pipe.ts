import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodError } from 'zod';

/**
 * Validates a body or query against a schema from `@video/shared`.
 *
 * Applied per parameter rather than globally, because the schema is what says
 * *what* to validate and a global pipe has no way to know. The upside over the
 * `class-validator` arrangement it replaces: the same schema object is
 * importable by the frontend, so a form and the endpoint behind it cannot drift
 * apart.
 *
 * Parsing also **transforms** — trimming, lowercasing, coercing query strings to
 * numbers — so what reaches a service is already the shape it wants, and query
 * parameters arrive as numbers rather than strings that look like them.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: describe(result.error),
      });
    }

    return result.data;
  }
}

/**
 * Flattens Zod's issues into `{ field, message }` pairs.
 *
 * The field is dotted (`markers.introStartSec`) so a form can map an error
 * straight onto the input that caused it, instead of showing everything at the
 * top of the page.
 */
function describe(error: ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(body)',
    message: issue.message,
  }));
}

/** Reads slightly better at the call site than `new ZodValidationPipe(schema)`. */
export const validate = <T>(schema: ZodType<T>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);
