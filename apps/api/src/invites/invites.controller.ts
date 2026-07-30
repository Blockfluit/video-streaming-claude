import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { CreateInviteDto } from './dto/create-invite.dto';
import { InvitesService, type InviteView, type MintedInvite } from './invites.service';

/**
 * Admin-only. `SessionGuard` is global so authentication is already handled;
 * `@Roles` is what keeps a USER out.
 */
@Controller('admin/invites')
@Roles('ADMIN')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  /** The response carries the plaintext token. It is never retrievable again. */
  @Post()
  mint(@Body() dto: CreateInviteDto, @CurrentUser() admin: AuthUser): Promise<MintedInvite> {
    return this.invites.mint(dto, admin.id);
  }

  @Get()
  list(): Promise<InviteView[]> {
    return this.invites.list();
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@Param('id') id: string): Promise<void> {
    return this.invites.revoke(id);
  }
}
