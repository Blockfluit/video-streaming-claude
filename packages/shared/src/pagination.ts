import { z } from 'zod';

/**
 * The pagination contract, shared so the frontend cannot disagree with the API
 * about what a page is.
 *
 * Every list endpoint returns a page. There is no "just give me everything"
 * option: a library grows, and an endpoint that returns all of something is
 * fine until the day it is not — at which point it is a slow query, a large
 * response and a frontend that has never been tested against either.
 */

/** What a client gets when it asks for nothing in particular. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * The most any single request may ask for. A caller wanting more has to page,
 * which keeps the worst-case response size a property of the API rather than
 * of whoever is calling it.
 */
export const MAX_PAGE_LIMIT = 100;

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/**
 * A page of results.
 *
 * `total` is the count matching the filter, not the page — it is what lets a UI
 * render "showing 1–50 of 312" and decide whether paging controls belong on
 * screen at all. `hasMore` is derived rather than left to the client to work
 * out from three numbers.
 */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function toPage<T>(items: T[], total: number, query: PageQuery): Page<T> {
  return {
    items,
    total,
    limit: query.limit,
    offset: query.offset,
    hasMore: query.offset + items.length < total,
  };
}
