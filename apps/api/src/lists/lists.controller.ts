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
  addListItemSchema,
  createCuratedListSchema,
  listCuratedListsSchema,
  reorderListItemsSchema,
  updateCuratedListSchema,
  type AddListItemInput,
  type CreateCuratedListInput,
  type ListCuratedListsQuery,
  type ReorderListItemsInput,
  type UpdateCuratedListInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { ListsService } from './lists.service';

@Controller('lists')
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  /** The home page's rows, in order, each with the entries the caller may see. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(validate(listCuratedListsSchema)) query: ListCuratedListsQuery,
  ) {
    return this.lists.list(user.role, query);
  }

  @Get(':slug')
  findBySlug(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.lists.findBySlug(slug, user.role);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body(validate(createCuratedListSchema)) dto: CreateCuratedListInput) {
    return this.lists.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id') id: string,
    @Body(validate(updateCuratedListSchema)) dto: UpdateCuratedListInput,
  ) {
    return this.lists.update(id, dto);
  }

  /** Takes the row's entries and nothing else — the library is untouched. */
  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.lists.remove(id);
  }

  @Post(':id/items')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  addItem(@Param('id') id: string, @Body(validate(addListItemSchema)) dto: AddListItemInput) {
    return this.lists.addItem(id, dto);
  }

  /**
   * Declared before `:id/items/:itemId` would matter if they collided; they do
   * not, but `reorder` still comes first so the pattern is not left to chance.
   */
  @Patch(':id/reorder')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  reorder(
    @Param('id') id: string,
    @Body(validate(reorderListItemsSchema)) dto: ReorderListItemsInput,
  ) {
    return this.lists.reorder(id, dto);
  }

  @Delete(':id/items/:itemId')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeItem(@Param('id') id: string, @Param('itemId') itemId: string): Promise<void> {
    return this.lists.removeItem(id, itemId);
  }
}
