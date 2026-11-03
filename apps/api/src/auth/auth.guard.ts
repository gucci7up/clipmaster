import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { AuthService, SESSION_COOKIE } from './auth.service';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ROLES = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
export const IS_INTERNAL = 'isInternal';
/** Rutas sólo para workers dentro de la red Docker. */
export const Internal = () => SetMetadata(IS_INTERNAL, true);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
});

/** Guard global: sesión por cookie (o Bearer) salvo rutas @Public / @Internal. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    if (this.reflector.getAllAndOverride<boolean>(IS_INTERNAL, targets)) {
      return checkInternal(req);
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = extractToken(req);
    if (!token) throw new UnauthorizedException('Sesión requerida');
    const user = await this.auth.validateSession(token);
    if (!user) throw new UnauthorizedException('Sesión inválida o expirada');
    req.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles?.length && !roles.includes(user.role)) throw new ForbiddenException('Permisos insuficientes');
    return true;
  }
}

export function extractToken(req: Request): string | null {
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return null;
}

export function checkInternal(req: Request): boolean {
  // Las peticiones que llegan a través de Traefik llevan cabeceras X-Forwarded-*: se rechazan.
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
    throw new ForbiddenException('Ruta interna');
  }
  const h = req.headers.authorization ?? '';
  const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const expected = Buffer.from(env().INTERNAL_API_TOKEN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new UnauthorizedException('Token interno inválido');
  }
  return true;
}
