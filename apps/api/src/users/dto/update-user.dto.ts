import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/dto/redeem.dto';
import { USERNAME_MAX_LENGTH, trimUsername } from '../../auth/username';
import type { Role } from '../../prisma/generated/enums';

/**
 * Everything an admin may change about an account.
 *
 * `username` is deliberately absent: it is the login identity and half of it is
 * already visible as `displayName`, so renaming is a rename of `displayName`
 * only. Changing what someone logs in with is a different operation and would
 * need its own thought about who is allowed to do it.
 */
export class UpdateUserDto {
  @IsOptional()
  @Transform(({ value }) => trimUsername(value))
  @IsString()
  @MinLength(1)
  @MaxLength(USERNAME_MAX_LENGTH)
  displayName?: string;

  @IsOptional()
  @IsIn(['USER', 'ADMIN'])
  role?: Role;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * There is no mailer, so there is no "forgot password" link. An admin setting
   * a new password is the only recovery path an account has.
   */
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  })
  @MaxLength(PASSWORD_MAX_LENGTH)
  password?: string;
}
