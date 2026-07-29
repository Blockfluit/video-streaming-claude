import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(320)
  email!: string;

  // No minimum length beyond non-empty: this validates a *login*, and a policy
  // here would only leak what the policy is. Strength is enforced at creation.
  @IsString()
  @MinLength(1)
  @MaxLength(1000) // bounds the argon2 work an unauthenticated caller can demand
  password!: string;
}
