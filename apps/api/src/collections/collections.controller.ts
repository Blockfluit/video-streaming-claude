import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto, UpdateCollectionDto } from './dto/collection.dto';
import { ResolveService, type ResolveResult } from './resolve.service';

/**
 * Reads are open to any signed-in user and filtered by role in the service —
 * never in the UI. Writes are ADMIN-only, marked per route rather than on the
 * class so the reads stay reachable.
 */
@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collections: CollectionsService,
    private readonly resolver: ResolveService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.collections.list(user.role);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateCollectionDto) {
    return this.collections.create(dto);
  }

  /**
   * Declared before `:slug` — Express matches in order, so a literal segment
   * has to come first or `resolve` would be read as a collection slug.
   */
  @Get(':slug/resolve')
  resolve(
    @Param('slug') slug: string,
    @Query('path', new DefaultValuePipe('')) path: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ResolveResult> {
    return this.resolver.resolve(slug, path, user.role);
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.collections.findBySlug(slug, user.role);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateCollectionDto) {
    return this.collections.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id') id: string,
    // Defaults to false: without it the row goes and reconcile puts it back,
    // which is annoying but recoverable. The other way round is not.
    @Query('deleteFiles', new DefaultValuePipe(false), ParseBoolPipe) deleteFiles: boolean,
  ): Promise<void> {
    return this.collections.remove(id, deleteFiles);
  }

  @Post(':id/publish')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id') id: string,
    @Query('cascade', new DefaultValuePipe(false), ParseBoolPipe) cascade: boolean,
  ) {
    return this.collections.publish(id, cascade);
  }

  @Post(':id/archive')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  archive(@Param('id') id: string) {
    return this.collections.archive(id);
  }
}
