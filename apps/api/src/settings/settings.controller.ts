import { Body, Controller, Get, Patch } from '@nestjs/common';
import { updateSettingsSchema, type UpdateSettingsInput } from '@video/shared';

import { Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import type { AppSettingsView } from '../common/settings';
import { SettingsService } from './settings.service';

/**
 * Admin-only. `SessionGuard` is global so authentication is already handled;
 * `@Roles` is what keeps a USER out.
 */
@Controller('admin/settings')
@Roles('ADMIN')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(): Promise<AppSettingsView> {
    return this.settings.get();
  }

  @Patch()
  update(@Body(validate(updateSettingsSchema)) dto: UpdateSettingsInput): Promise<AppSettingsView> {
    return this.settings.update(dto);
  }
}
