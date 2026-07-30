import { Injectable, NotFoundException } from '@nestjs/common';

import { generateToken, hashToken, tokenState, type TokenState } from '../auth/tokens';
import type { Role, TokenKind } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_INVITE_TTL_HOURS, type CreateInviteDto } from './dto/create-invite.dto';

/** Everything about a token except the one thing we never store: its plaintext. */
const INVITE_SELECT = {
  id: true,
  kind: true,
  grantsRole: true,
  expiresAt: true,
  redeemedAt: true,
  revokedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, displayName: true } },
  redeemedUser: { select: { id: true, displayName: true } },
} as const;

export interface InviteView {
  id: string;
  kind: TokenKind;
  grantsRole: Role;
  state: TokenState;
  expiresAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdBy: { id: string; displayName: string } | null;
  redeemedUser: { id: string; displayName: string } | null;
}

/** A freshly minted invite. `token` is the only time the plaintext ever exists outside the minter's screen. */
export interface MintedInvite extends InviteView {
  token: string;
}

@Injectable()
export class InvitesService {
  constructor(private readonly prisma: PrismaService) {}

  async mint(dto: CreateInviteDto, createdById: string): Promise<MintedInvite> {
    const plaintext = generateToken();
    const hours = dto.expiresInHours ?? DEFAULT_INVITE_TTL_HOURS;

    const invite = await this.prisma.inviteToken.create({
      data: {
        tokenHash: hashToken(plaintext),
        kind: 'INVITE',
        grantsRole: dto.grantsRole ?? 'USER',
        expiresAt: new Date(Date.now() + hours * 3_600_000),
        createdById,
      },
      select: INVITE_SELECT,
    });

    return { ...this.toView(invite), token: plaintext };
  }

  async list(): Promise<InviteView[]> {
    const invites = await this.prisma.inviteToken.findMany({
      select: INVITE_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((invite) => this.toView(invite));
  }

  /**
   * Revokes rather than deletes. The row is the only record of who invited whom
   * and whether it was ever used; dropping it would erase that. A revoked token
   * is refused by `tokenState`, so this is as final as a delete from the
   * caller's side.
   */
  async revoke(id: string): Promise<void> {
    const revoked = await this.prisma.inviteToken.updateMany({
      where: { id, revokedAt: null, redeemedAt: null },
      data: { revokedAt: new Date() },
    });

    if (revoked.count === 0) {
      // Either it never existed, or it is already spent — both mean "there is
      // nothing here left to revoke".
      throw new NotFoundException('No revocable invite with that id');
    }
  }

  private toView(invite: Omit<InviteView, 'state'>): InviteView {
    return { ...invite, state: tokenState(invite, new Date()) };
  }
}
