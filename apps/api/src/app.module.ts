import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { CollectionsModule } from './collections/collections.module';
import { CommonModule } from './common/common.module';
import { IngestModule } from './ingest/ingest.module';
import { InvitesModule } from './invites/invites.module';
import { MediaModule } from './media/media.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    PrismaModule,
    CommonModule,
    MediaModule,
    AuthModule,
    InvitesModule,
    UsersModule,
    CollectionsModule,
    VideosModule,
    IngestModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
