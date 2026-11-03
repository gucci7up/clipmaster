import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { AuthUser, CurrentUser, Public } from './auth.guard';
import { AuthService, SESSION_COOKIE } from './auth.service';

class RegisterDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email: string;
  @ApiProperty() @IsString() @Length(2, 80) name: string;
  @ApiProperty({ minLength: 10 }) @IsString() @MinLength(10) @MaxLength(200) password: string;
}
class LoginDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}
class ChangePasswordDto {
  @ApiProperty() @IsString() currentPassword: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(200) newPassword: string;
}
class ForgotDto {
  @ApiProperty() @IsEmail() email: string;
}
class ResetDto {
  @ApiProperty() @IsString() @Length(20, 200) token: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(200) password: string;
}

export function publicUser(u: { id: string; email: string; name: string; role: string }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.register(dto.email, dto.name, dto.password, req.ip);
    const { token, expiresAt, user } = await this.auth.login(dto.email, dto.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(res, token, expiresAt);
    return { user: publicUser(user) };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { token, expiresAt, user } = await this.auth.login(dto.email, dto.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(res, token, expiresAt);
    return { user: publicUser(user) };
  }

  @HttpCode(204)
  @Post('logout')
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { user: publicUser(user) };
  }

  @Public()
  @Get('config')
  config() {
    return { registration: env().ALLOW_REGISTRATION, passwordReset: this.auth.resetEnabled };
  }

  @HttpCode(204)
  @Post('change-password')
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Res({ passthrough: true }) res: Response) {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(202)
  @Post('forgot-password')
  async forgot(@Body() dto: ForgotDto) {
    await this.auth.requestReset(dto.email);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(204)
  @Post('reset-password')
  async reset(@Body() dto: ResetDto) {
    await this.auth.resetPassword(dto.token, dto.password);
  }
}

function setCookie(res: Response, token: string, expires: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env().COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}
