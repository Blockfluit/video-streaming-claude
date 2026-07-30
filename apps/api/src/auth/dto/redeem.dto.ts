import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  USERNAME_RULES,
  trimUsername,
} from '../username';

/**
 * There is no minimum entropy check and no password-strength meter. The
 * floor is a length, because length is the only property of a password that
 * reliably predicts how hard it is to guess — composition rules mostly produce
 * `Password1!`. 12 rather than 8 because there is no MFA here, and login stays
 * unthrottled until step 18.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1000;

/**
 * Redeeming an invite or the master token. Username and password only — the
 * library sends no mail, so there is nothing else to ask for.
 */
export class RedeemDto {
  // Bounded so an unauthenticated caller cannot make the API hash a novel.
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  // Trimmed but NOT lowercased: the service stores the lowercase form as
  // `username` and this as-typed value as `displayName`. That is why
  // USERNAME_PATTERN is case-insensitive.
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
}
