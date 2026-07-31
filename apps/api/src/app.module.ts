import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { CollectionsModule } from './collections/collections.module';
import { CommentsModule } from './comments/comments.module';
import { CommonModule } from './common/common.module';
import { CreditsModule } from './credits/credits.module';
import { IngestModule } from './ingest/ingest.module';
import { InvitesModule } from './invites/invites.module';
import { MediaModule } from './media/media.module';
import { PeopleModule } from './people/people.module';
import { PrismaModule } from './prisma/prisma.module';
import { SubtitlesModule } from './subtitles/subtitles.module';
import { TranscodeModule } from './transcode/transcode.module';
import { UploadsModule } from './uploads/uploads.module';
import { UsersModule } from './users/users.module';
import { VideosModule } from './videos/videos.module';
import { WatchModule } from './watch/watch.module';

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
    SubtitlesModule,
    TranscodeModule,
    UploadsModule,
    IngestModule,
    WatchModule,
    PeopleModule,
    CreditsModule,
    CommentsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
