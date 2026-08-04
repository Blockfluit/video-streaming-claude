import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { CollectionsModule } from './collections/collections.module';
import { CommentsModule } from './comments/comments.module';
import { CommonModule } from './common/common.module';
import { CreditsModule } from './credits/credits.module';
import { IngestModule } from './ingest/ingest.module';
import { InvitesModule } from './invites/invites.module';
import { MetadataModule } from './metadata/metadata.module';
import { TmdbModule } from './metadata/tmdb.module';
import { ListsModule } from './lists/lists.module';
import { MediaModule } from './media/media.module';
import { PeopleModule } from './people/people.module';
import { PrismaModule } from './prisma/prisma.module';
import { RequestsModule } from './requests/requests.module';
import { SubtitlesModule } from './subtitles/subtitles.module';
import { TranscodeModule } from './transcode/transcode.module';
import { UploadsModule } from './uploads/uploads.module';
import { UsersModule } from './users/users.module';
import { VideosModule } from './videos/videos.module';
import { WatchModule } from './watch/watch.module';
import { WatchlistModule } from './watchlist/watchlist.module';
import { THROTTLERS, UserThrottlerGuard } from './common/throttling';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    ThrottlerModule.forRoot({ throttlers: THROTTLERS }),
    PrismaModule,
    CommonModule,
    MediaModule,
    TmdbModule,
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
    WatchlistModule,
    ListsModule,
    RequestsModule,
    MetadataModule,
  ],
  controllers: [AppController],
  providers: [
    /*
     * Registered here rather than alongside the session guards, so it runs
     * first: a request that is already over its limit is rejected without
     * costing the database the user lookup `SessionGuard` does on every call.
     */
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule {}
