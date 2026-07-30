import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BootstrapService } from './bootstrap.service';
import { PasswordService } from './password.service';
import { RolesGuard } from './roles.guard';
import { SessionGuard } from './session.guard';
import { SessionStoreService } from './session-store.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    BootstrapService,
    PasswordService,
    SessionStoreService,
    // Order is load-bearing: SessionGuard attaches the user that RolesGuard reads.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, BootstrapService, PasswordService, SessionStoreService],
})
export class AuthModule {}
