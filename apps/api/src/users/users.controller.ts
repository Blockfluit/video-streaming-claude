import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { Roles } from '../auth/decorators';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService, type UserView } from './users.service';

/**
 * Admin-only account management. `SessionGuard` is global, so authentication is
 * already settled; `@Roles` is what keeps a USER out.
 *
 * There is deliberately no self-exemption: an admin can demote or delete
 * themselves, and the last-active-admin rule is what stops that locking
 * everyone out. Special-casing "you" would add a second rule that does the same
 * job less well — it would still allow two admins to strand each other.
 */
@Controller('admin/users')
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): Promise<UserView[]> {
    return this.users.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto): Promise<UserView> {
    return this.users.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto): Promise<UserView> {
    return this.users.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.users.remove(id);
  }
}
