import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  loginSchema,
  redeemSchema,
  type LoginInput,
  type RedeemInput,
} from '@video/shared';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import type { AuthUser } from './auth.types';
import { validate } from '../common/zod-validation.pipe';
import { CurrentUser, Public } from './decorators';
import { SkipThrottle } from '@nestjs/throttler';
import { ThrottleCredentials } from '../common/throttling';

/** express-session's callback API, as promises. */
function regenerate(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function save(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function destroy(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Public by necessity: whoever redeems a token has no account yet, so there
   * is nothing for `SessionGuard` to authenticate. The token is the credential.
   */
  @Public()
  /*
   * Every failure here returns one identical 400, so a spent token cannot be
   * told from an unknown one. The limit is what stops that being probed at
   * speed.
   */
  @ThrottleCredentials()
  @Post('redeem')
  @HttpCode(HttpStatus.CREATED)
  async redeem(
    @Body(validate(redeemSchema)) dto: RedeemInput,
    @Req() request: Request,
  ): Promise<AuthUser> {
    const user = await this.auth.redeem(dto);

    // Log them straight in. The alternative is redirecting to a login form to
    // retype the password they just chose, which buys nothing.
    await regenerate(request);
    request.session.userId = user.id;
    await save(request);

    return user;
  }

  @Public()
  /** Tightest limit in the app: this is where a password is guessed. */
  @ThrottleCredentials()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(validate(loginSchema)) dto: LoginInput,
    @Req() request: Request,
  ): Promise<AuthUser> {
    const user = await this.auth.validateCredentials(dto.username, dto.password);
    if (!user) {
      // One message for both "no such account" and "wrong password".
      throw new UnauthorizedException('Invalid username or password');
    }

    // Regenerate before storing the id: without this, a session id captured
    // before login stays valid afterwards (session fixation).
    await regenerate(request);
    request.session.userId = user.id;
    // Save explicitly so the row is committed before the response goes out —
    // otherwise a fast follow-up request can beat the store write.
    await save(request);

    return user;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await destroy(request);
    // rolling cookies are re-sent on every response; clear it explicitly or the
    // browser keeps presenting one whose session no longer exists.
    response.clearCookie('vsc.sid', { path: '/' });
  }

  /*
   * Not throttled: every page load and every route change asks who you are, and
   * the navigation middleware calls it too. It is a session lookup, not work.
   */
  @SkipThrottle()
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
