import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/** Global so feature modules can inject PrismaService without importing this everywhere. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
