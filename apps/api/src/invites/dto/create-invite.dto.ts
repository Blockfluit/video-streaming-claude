import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import type { Role } from '../../prisma/generated/enums';

export const DEFAULT_INVITE_TTL_HOURS = 7 * 24;
export const MAX_INVITE_TTL_HOURS = 90 * 24;

export class CreateInviteDto {
  /**
   * Defaults to USER. Minting an ADMIN invite is allowed — an admin can
   * already promote accounts directly, so refusing here would only be theatre.
   */
  @IsOptional()
  @IsIn(['USER', 'ADMIN'])
  grantsRole?: Role;

  // Bounded rather than open-ended: an invite that never practically expires is
  // a permanent way in, and this library has no other front door.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INVITE_TTL_HOURS)
  expiresInHours?: number;
}
