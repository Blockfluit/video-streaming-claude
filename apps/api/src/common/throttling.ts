import { Injectable } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Rate limiting policy for a **private, invite-only** library.
 *
 * The threat here is not a botnet. It is a guessed password, a spent invite
 * being probed, one person's script hammering an endpoint, and a bug — ours or
 * a client's — turning a loop into a denial of service against a box that also
 * has to transcode video. The limits are sized to be invisible to a person
 * using the app and obvious to a loop.
 *
 * **One bucket, overridden per route.** The first version of this declared five
 * *named* throttlers, which reads well and is wrong: the guard evaluates every
 * named throttler on every request, so a `credentials` bucket of 10/min applied
 * to the whole API, and `@SkipThrottle()` — which skips only the throttler
 * literally named `default` — exempted one of the five. Browsing would have
 * died after ten requests. The e2e tests caught it.
 */
const MINUTE = 60_000;

/**
 * The blanket limit, and the only throttler that exists.
 *
 * Generous: a single page load is easily a dozen requests and browsing quickly
 * is not abuse. This is the ceiling for anything nobody thought about.
 */
export const THROTTLERS = [{ name: 'default', ttl: MINUTE, limit: 300 }];

/**
 * Credentials. `/auth/login` and `/auth/redeem` are the only routes reachable
 * without a session, so they are the only ones an outsider can reach at all.
 *
 * Ten a minute is far more than a person mistyping a password and far less than
 * a useful guessing rate. It matters most for redeem: every failure there
 * returns one identical 400 so a spent token cannot be told from an unknown
 * one, and this is what stops that being probed at speed.
 */
export const ThrottleCredentials = (): MethodDecorator =>
  Throttle({ default: { ttl: MINUTE, limit: 10 } });

/**
 * Writing something a person authored: comments, invites. Fast enough never to
 * notice, slow enough that a spam loop is pointless.
 */
export const ThrottleAuthoring = (): MethodDecorator =>
  Throttle({ default: { ttl: MINUTE, limit: 30 } });

/**
 * Work that costs real resources: a transcode, a probe, a frame capture, an
 * upload, a full media scan. These spawn ffmpeg or walk the disk, and the
 * machine has one CPU budget to spend. Admin-only, but an admin with a script
 * can still saturate the box, and a stuck retry loop in our own UI looks
 * exactly the same from here.
 */
export const ThrottleExpensive = (): MethodDecorator =>
  Throttle({ default: { ttl: MINUTE, limit: 20 } });

/**
 * Playback telemetry.
 *
 * This is the limit `watch/progress.ts` was written expecting: capping
 * `deltaSec` at 30s stops one bad number rewriting a total, but explicitly is
 * *not* a rate limit, because a client beating in a loop still accumulates real
 * seconds. This is the thing that stops that.
 *
 * 40/min leaves room for the player's 10s beat plus the `sendBeacon` on pause,
 * tab-hide and unload, across a couple of open tabs.
 */
export const ThrottleHeartbeat = (): MethodDecorator =>
  Throttle({ default: { ttl: MINUTE, limit: 40 } });

/**
 * Counts against the **signed-in user**, falling back to the IP.
 *
 * The stock guard keys on IP alone, which is wrong in both directions here. A
 * household or an office behind one NAT shares an address, so one person
 * watching would throttle everyone else in the building; and a single account
 * misbehaving from several addresses would not be caught at all. Identity is
 * what this app actually cares about — it is invite-only, so almost every
 * request has one.
 *
 * The IP fallback still matters: `/auth/login` and `/auth/redeem` are reached
 * without a session, and those are exactly the routes that need an IP limit.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(request: Request): Promise<string> {
    const userId = (request as Request & { session?: { userId?: string } }).session?.userId;
    if (userId) return `user:${userId}`;

    // `ips` is populated only when a trusted proxy is configured; falling back
    // to `ip` keeps this correct on a direct connection.
    return `ip:${request.ips?.length ? request.ips[0] : request.ip}`;
  }
}
