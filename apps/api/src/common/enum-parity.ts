import type {
  CreditRoleName,
  IngestIssueKind as SharedIngestIssueKind,
  JobStatus as SharedJobStatus,
  PublishState as SharedPublishState,
  RequestStatus as SharedRequestStatus,
  Role as SharedRole,
  RowKind as SharedRowKind,
  RowSource as SharedRowSource,
} from '@video/shared';

import type {
  CreditRole,
  IngestIssueKind,
  JobStatus,
  PublishState,
  RequestStatus,
  Role,
  RowKind,
  RowSource,
} from '../prisma/generated/enums';

/**
 * The database's enums and the wire's enums, asserted equal at compile time.
 *
 * Every one of these closed sets is declared twice — once in `schema.prisma`,
 * which decides what a column may hold, and once as a `z.enum([...])` in
 * `packages/shared`, which decides what a request may carry. They agreed when
 * this file was written. Nothing made that true tomorrow.
 *
 * Drift is silent in both directions and neither shows up as a type error at
 * the call sites, because the two type universes never meet: add a value to the
 * Prisma enum and the API starts rejecting a value its own database holds; add
 * one to the zod enum and the API accepts a value the insert then fails on,
 * as a 500.
 *
 * This is the cheapest possible thing that makes them meet. A value present on
 * one side only fails `npm run typecheck` — which is a CI job — and the error
 * names both the enum and the offending member, because `Same` resolves to the
 * difference rather than to a bare `false`. There is no runtime cost, because
 * there is no runtime: the file emits nothing.
 *
 * Spelled with `Exclude` in both directions rather than as mutual `extends`
 * constraints, which TypeScript rejects as circular.
 *
 * Not covered here, and worth knowing: `RequestStatus` is stated a **third**
 * time, as SQL, in the partial unique index on `VideoRequest`
 * (`WHERE status IN ('NEW', 'SEEN', 'PROCESSING')`). No typechecker reaches
 * inside a migration. `OPEN_REQUEST_STATUSES` is the TypeScript half of that
 * pair and the requests service queries with it deliberately, so at least the
 * query and the constraint move together.
 */

/** Whatever one side has and the other does not, in either direction. */
type Difference<A, B> = Exclude<A, B> | Exclude<B, A>;

/** `true` when the two unions match, otherwise the members that broke it. */
type Same<A, B> = [Difference<A, B>] extends [never] ? true : Difference<A, B>;

/** Accepts only `true`, so a `Same` that resolved to a member fails here. */
type AssertSame<T extends true> = T;

// Each line is the assertion. An unused type alias emits nothing; a wrong one
// fails the build, reporting the value that is on one side only.
export type RoleParity = AssertSame<Same<Role, SharedRole>>;
export type PublishStateParity = AssertSame<Same<PublishState, SharedPublishState>>;
export type CreditRoleParity = AssertSame<Same<CreditRole, CreditRoleName>>;
export type JobStatusParity = AssertSame<Same<JobStatus, SharedJobStatus>>;
export type RequestStatusParity = AssertSame<Same<RequestStatus, SharedRequestStatus>>;
export type RowSourceParity = AssertSame<Same<RowSource, SharedRowSource>>;
export type RowKindParity = AssertSame<Same<RowKind, SharedRowKind>>;
export type IngestIssueKindParity = AssertSame<Same<IngestIssueKind, SharedIngestIssueKind>>;
