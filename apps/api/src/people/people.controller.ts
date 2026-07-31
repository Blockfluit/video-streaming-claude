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
  Query,
} from '@nestjs/common';
import {
  createPersonSchema,
  listPeopleSchema,
  updatePersonSchema,
  type CreatePersonInput,
  type ListPeopleQuery,
  type UpdatePersonInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { PeopleService } from './people.service';

@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  /** Also the autocomplete behind the credit editor — `?q=` matches the name. */
  @Get()
  list(@Query(validate(listPeopleSchema)) query: ListPeopleQuery) {
    return this.people.list(query);
  }

  /** By slug, because a person is a linkable page. Returns their filmography. */
  @Get(':slug')
  findBySlug(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.people.findBySlug(slug, user.role);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body(validate(createPersonSchema)) dto: CreatePersonInput) {
    return this.people.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body(validate(updatePersonSchema)) dto: UpdatePersonInput) {
    return this.people.update(id, dto);
  }

  /** Takes their credits with them — a credit with no person is not a fact about anything. */
  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.people.remove(id);
  }
}
