import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  createInviteSchema,
  listInvitesSchema,
  type CreateInviteInput,
  type ListInvitesQuery,
  type Page,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { InvitesService, type InviteView, type MintedInvite } from './invites.service';
import { ThrottleAuthoring } from '../common/throttling';

/**
 * Admin-only. `SessionGuard` is global so authentication is already handled;
 * `@Roles` is what keeps a USER out.
 */
@Controller('admin/invites')
@Roles('ADMIN')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  /** The response carries the plaintext token. It is never retrievable again. */
  /** Mints a live credential; a loop would produce unlimited valid tokens. */
  @ThrottleAuthoring()
  @Post()
  mint(
    @Body(validate(createInviteSchema)) dto: CreateInviteInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<MintedInvite> {
    return this.invites.mint(dto, admin.id);
  }

  @Get()
  list(@Query(validate(listInvitesSchema)) query: ListInvitesQuery): Promise<Page<InviteView>> {
    return this.invites.list(query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@Param('id') id: string): Promise<void> {
    return this.invites.revoke(id);
  }
}
