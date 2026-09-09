import { Injectable } from '@nestjs/common';
import type { UpdateSettingsInput } from '@video/shared';

import { getSettings, updateSettings, type AppSettingsView } from '../common/settings';
import { PrismaService } from '../prisma/prisma.service';

/** A thin, DI-friendly wrapper around the plain functions in `common/settings.ts`. */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  get(): Promise<AppSettingsView> {
    return getSettings(this.prisma);
  }

  update(dto: UpdateSettingsInput): Promise<AppSettingsView> {
    return updateSettings(this.prisma, dto);
  }
}
