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
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import type { AuthUser } from './auth.types';
import { CurrentUser, Public } from './decorators';
import { LoginDto } from './dto/login.dto';
import { RedeemDto } from './dto/redeem.dto';

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
  @Post('redeem')
  @HttpCode(HttpStatus.CREATED)
  async redeem(@Body() dto: RedeemDto, @Req() request: Request): Promise<AuthUser> {
    const user = await this.auth.redeem(dto);

    // Log them straight in. The alternative is redirecting to a login form to
    // retype the password they just chose, which buys nothing.
    await regenerate(request);
    request.session.userId = user.id;
    await save(request);

    return user;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthUser> {
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

  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
