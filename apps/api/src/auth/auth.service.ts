import { hash, verify } from '@node-rs/argon2';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotImplementedException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import { env } from '../config/env';
import type { AuthUser } from './auth.guard';

export const SESSION_COOKIE = 'cm_session';
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP 2023 (argon2id)

export function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger(AuthService.name);
  private dummyHash?: Promise<string>;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Crea el administrador inicial desde variables de entorno si no existe. */
  async onModuleInit() {
    const { ADMIN_EMAIL, ADMIN_PASSWORD, NODE_ENV } = env();
    if (NODE_ENV === 'test' || !ADMIN_EMAIL || !ADMIN_PASSWORD) return;
    const exists = await this.prisma.user.findUnique({ where: { email: ADMIN_EMAIL.toLowerCase() } });
    if (!exists) {
      await this.createUser(ADMIN_EMAIL, 'Administrador', ADMIN_PASSWORD, Role.ADMIN);
      this.log.log(`Administrador inicial creado: ${ADMIN_EMAIL}`);
    }
  }

  async createUser(email: string, name: string, password: string, role: Role = Role.USER) {
    const normalized = email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email: normalized } })) {
      throw new ConflictException('Ya existe una cuenta con ese correo');
    }
    const passwordHash = await hash(password, ARGON_OPTS);
    return this.prisma.user.create({
      data: {
        email: normalized,
        name: name.trim(),
        passwordHash,
        role,
        storageQuotaBytes: BigInt(env().DEFAULT_QUOTA_GB) * 1024n ** 3n,
        settings: { create: {} },
        aiSettings: { create: {} },
      },
    });
  }

  async register(email: string, name: string, password: string, ip?: string) {
    if (!env().ALLOW_REGISTRATION) throw new ForbiddenException('El registro está deshabilitado');
    const user = await this.createUser(email, name, password);
    await this.audit.log(user.id, 'auth.register', user.id, ip);
    return user;
  }

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Verificación con hash ficticio cuando no existe el usuario para igualar tiempos.
    this.dummyHash ??= hash(randomBytes(16).toString('hex'), ARGON_OPTS);
    const ok = user
      ? await verify(user.passwordHash, password).catch(() => false)
      : await verify(await this.dummyHash, password).then(() => false, () => false);
    if (!user || !ok || user.disabled) {
      await this.audit.log(user?.id ?? null, 'auth.login_failed', email, meta.ip);
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + env().SESSION_TTL_DAYS * 86400_000);
    await this.prisma.session.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) },
    });
    await this.audit.log(user.id, 'auth.login', user.id, meta.ip);
    return { token, expiresAt, user };
  }

  async validateSession(token: string): Promise<AuthUser | null> {
    const session = await this.prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!session || session.expiresAt < new Date() || session.user.disabled) return null;
    // Actualiza lastSeen como mucho una vez cada 5 minutos.
    if (Date.now() - session.lastSeenAt.getTime() > 300_000) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    }
    const { user } = session;
    return { id: user.id, email: user.email, name: user.name, role: user.role, sessionId: session.id };
  }

  async logout(sessionId: string) {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  async changePassword(userId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verify(user.passwordHash, current).catch(() => false))) {
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await hash(next, ARGON_OPTS) } }),
      this.prisma.session.deleteMany({ where: { userId } }),
    ]);
    await this.audit.log(userId, 'auth.password_changed', userId);
  }

  get resetEnabled(): boolean {
    return Boolean(env().SMTP_URL);
  }

  /** Recuperación de contraseña: sólo disponible si SMTP_URL está configurado. */
  async requestReset(email: string) {
    if (!this.resetEnabled) throw new NotImplementedException('La recuperación de contraseña requiere configurar SMTP_URL');
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) return; // respuesta idéntica para no revelar cuentas
    const token = randomBytes(32).toString('base64url');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + 3600_000) },
    });
    const link = `${env().PUBLIC_URL}/restablecer?token=${token}`;
    await nodemailer.createTransport(env().SMTP_URL).sendMail({
      from: env().SMTP_FROM,
      to: user.email,
      subject: 'Restablecer contraseña — ClipMaster AI',
      text: `Para restablecer tu contraseña abre este enlace (válido 1 hora):\n${link}\n\nSi no lo solicitaste, ignora este correo.`,
    });
    await this.audit.log(user.id, 'auth.reset_requested', user.id);
  }

  async resetPassword(token: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { resetTokenHash: sha256(token) } });
    if (!user || !user.resetTokenExpires || user.resetTokenExpires < new Date()) {
      throw new BadRequestException('Enlace inválido o expirado');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hash(password, ARGON_OPTS), resetTokenHash: null, resetTokenExpires: null },
      }),
      this.prisma.session.deleteMany({ where: { userId: user.id } }),
    ]);
    await this.audit.log(user.id, 'auth.reset_done', user.id);
  }
}
