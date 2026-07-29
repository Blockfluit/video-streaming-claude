import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id, using the library defaults (which are the OWASP-recommended
 * parameters). Tokens are hashed with sha256 elsewhere — that is deliberate,
 * not an oversight: invite tokens are 256-bit random values, so a slow KDF
 * buys nothing there. Passwords are guessable and need the work factor.
 */
@Injectable()
export class PasswordService {
  hash(plaintext: string): Promise<string> {
    return hash(plaintext);
  }

  async verify(digest: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(digest, plaintext);
    } catch {
      // A malformed or truncated hash in the database must read as "wrong
      // password", never as a 500 that tells an attacker they found something.
      return false;
    }
  }
}
