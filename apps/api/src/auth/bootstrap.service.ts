import { access, chmod, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { generateToken, hashToken } from './tokens';

/** 24 hours. Short enough to matter, and a restart reissues it — see below. */
export const BOOTSTRAP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TOKEN_FILE = '../../.bootstrap-token';

/**
 * Mints the single-use master token that creates the first admin.
 *
 * The bootstrap problem: the library is invite-only, and invites are minted by
 * admins, so the very first admin cannot be invited by anyone. Instead the API
 * notices at startup that no admin exists and issues one token that grants
 * ADMIN exactly once.
 *
 * Restarting while no admin exists reissues an expired token, so a 24-hour TTL
 * can never lock you out permanently.
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Absolute path of the plaintext token file. Relative paths resolve from `apps/api`, as `MEDIA_ROOT` does. */
  get tokenFilePath(): string {
    return resolve(
      process.cwd(),
      this.config.get<string>('BOOTSTRAP_TOKEN_FILE') ?? DEFAULT_TOKEN_FILE,
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    // Counts every admin, active or not. Deactivating the last active admin is
    // refused by the accounts service, so the two counts cannot diverge through
    // the API — and counting only active ones would mean a hand-edited row in
    // the database silently causes a fresh master token to be minted.
    const admins = await this.countAdmins();

    if (admins > 0) {
      // A leftover file from a previous run is a live credential lying around.
      await this.removeTokenFile();
      return;
    }

    const reused = await this.reusableToken();
    if (reused) {
      this.announce('Master token still valid from a previous run');
      return;
    }

    await this.mint();
  }

  private countAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { role: 'ADMIN' } });
  }

  /**
   * True when an unredeemed, unexpired BOOTSTRAP token exists *and* its
   * plaintext is still on disk.
   *
   * Only the sha256 is stored, so a surviving row whose file has been deleted
   * is unusable — nobody can ever present that plaintext again. Reusing it
   * would print a banner pointing at a file that does not exist, so that case
   * mints a replacement instead.
   */
  private async reusableToken(): Promise<boolean> {
    const live = await this.prisma.inviteToken.findFirst({
      where: {
        kind: 'BOOTSTRAP',
        redeemedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    return live !== null && (await this.tokenFileExists());
  }

  private async mint(): Promise<void> {
    // At most one live master token at a time: an older row whose plaintext we
    // can no longer show would otherwise stay redeemable forever by whoever
    // kept a copy.
    await this.prisma.inviteToken.updateMany({
      where: { kind: 'BOOTSTRAP', redeemedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const plaintext = generateToken();
    await this.prisma.inviteToken.create({
      data: {
        tokenHash: hashToken(plaintext),
        kind: 'BOOTSTRAP',
        grantsRole: 'ADMIN',
        expiresAt: new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS),
      },
    });

    await this.writeTokenFile(plaintext);
    this.announce('Master token minted — no admin account exists yet', plaintext);
  }

  private async writeTokenFile(plaintext: string): Promise<void> {
    const path = this.tokenFilePath;
    // mode on writeFile only applies when the file is created, so chmod after
    // the write covers the case where a previous run left one behind.
    await writeFile(path, `${plaintext}\n`, { mode: 0o600, encoding: 'utf8' });
    await chmod(path, 0o600);
  }

  private async tokenFileExists(): Promise<boolean> {
    try {
      await access(this.tokenFilePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Called after a successful BOOTSTRAP redemption — the plaintext is spent. */
  async removeTokenFile(): Promise<void> {
    try {
      await unlink(this.tokenFilePath);
    } catch (error) {
      // Already gone is the normal case, not a failure.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private announce(headline: string, plaintext?: string): void {
    const lines = [
      headline,
      `Redeem it to create the first admin (expires in ${BOOTSTRAP_TOKEN_TTL_MS / 3_600_000}h):`,
      '',
      plaintext ? `  ${plaintext}` : `  see ${this.tokenFilePath}`,
      '',
      `  curl -X POST http://localhost:${this.config.get<string>('PORT') ?? '4000'}/auth/redeem \\`,
      `    -H 'Content-Type: application/json' \\`,
      `    -d '{"token":"<token>","username":"admin","password":"<password>"}'`,
    ];

    const width = Math.max(...lines.map((line) => line.length)) + 2;
    const border = '─'.repeat(width);

    this.logger.log(
      `\n┌${border}┐\n${lines
        .map((line) => `│ ${line.padEnd(width - 2)} │`)
        .join('\n')}\n└${border}┘`,
    );
  }
}
