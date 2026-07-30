import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { normaliseUsername } from '../username';

export class LoginDto {
  // Deliberately looser than the signup rules: enforcing the username pattern
  // here would only tell an attacker what the pattern is, and would reject
  // legacy accounts if the rules ever change. Length is bounded, nothing more.
  @Transform(({ value }) => normaliseUsername(value))
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000) // bounds the argon2 work an unauthenticated caller can demand
  password!: string;
}
