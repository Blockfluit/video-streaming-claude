import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/dto/redeem.dto';
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  USERNAME_RULES,
  trimUsername,
} from '../../auth/username';
import type { Role } from '../../prisma/generated/enums';

/**
 * An admin creating an account directly, without an invite.
 *
 * Same rules as redemption — deliberately, so an account made this way is
 * indistinguishable from an invited one.
 */
export class CreateUserDto {
  @Transform(({ value }) => trimUsername(value))
  @IsString()
  @MinLength(USERNAME_MIN_LENGTH, { message: USERNAME_RULES })
  @MaxLength(USERNAME_MAX_LENGTH, { message: USERNAME_RULES })
  @Matches(USERNAME_PATTERN, { message: USERNAME_RULES })
  username!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  })
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @IsOptional()
  @IsIn(['USER', 'ADMIN'])
  role?: Role;
}
