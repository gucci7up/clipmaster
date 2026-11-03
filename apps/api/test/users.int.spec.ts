/**
 * Alta de usuarios por un administrador con PostgreSQL real: contraseña propia o generada, rol y cuota,
 * correos duplicados y que el usuario creado pueda iniciar sesión.
 *
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter @clipmaster/api test
 */
import { Role } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';
import type { AuthUser } from '../src/auth/auth.guard';
import type { AuditService } from '../src/common/audit.service';
import type { PrismaService } from '../src/common/prisma.service';
import type { RedisService } from '../src/common/redis.service';
import { loadEnv, setEnvForTests } from '../src/config/env';
import { SettingsController } from '../src/settings/settings.controller';

const DB = process.env.TEST_DATABASE_URL;
const run = DB ? describe : describe.skip;

run('alta de usuarios por el administrador (PostgreSQL real)', () => {
  let prisma: PrismaService;
  let auth: AuthService;
  let controller: SettingsController;
  let admin: AuthUser;
  const logged: { action: string; data?: unknown }[] = [];
  const stamp = Date.now();
  const emails: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    setEnvForTests(loadEnv({
      NODE_ENV: 'test', DATABASE_URL: DB, S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b', ALLOW_REGISTRATION: 'false',
      SESSION_SECRET: 's'.repeat(40), MEDIA_SIGNING_SECRET: 'm'.repeat(40), INTERNAL_API_TOKEN: 'i'.repeat(40),
    } as NodeJS.ProcessEnv));
    const { PrismaService: PS } = await import('../src/common/prisma.service');
    prisma = new PS();
    await prisma.$connect();
    const audit = { log: async (_u: string, action: string, _t?: string, _ip?: string, data?: unknown) => { logged.push({ action, data }); } } as unknown as AuditService;
    auth = new AuthService(prisma, audit);
    controller = new SettingsController(prisma, audit, {} as RedisService, auth);
    const a = await prisma.user.create({ data: { email: `admin-${stamp}@example.com`, name: 'Admin', passwordHash: 'x', role: Role.ADMIN } });
    emails.push(a.email);
    admin = { id: a.id, email: a.email, name: a.name, role: a.role } as AuthUser;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.$disconnect();
  });

  it('crea un usuario con la contraseña indicada aunque el registro público esté cerrado', async () => {
    const email = `Nuevo-${stamp}@Example.com`;
    emails.push(email.toLowerCase());
    const res = await controller.createUser(admin, { email, name: ' Nuevo ', password: 'contraseña-segura-1' });
    expect(res.generatedPassword).toBeNull();
    expect(res.user).toMatchObject({ email: email.toLowerCase(), name: 'Nuevo', role: 'USER' });
    expect(JSON.stringify(logged)).not.toContain('contraseña-segura-1');
    expect(logged.at(-1)?.action).toBe('admin.user_created');

    await expect(auth.login(email, 'contraseña-segura-1', {})).resolves.toBeTruthy();
    await expect(auth.register(`otro-${stamp}@example.com`, 'Otro', 'contraseña-segura-1')).rejects.toThrow('deshabilitado');
  });

  it('genera una contraseña si no se indica y aplica rol y cuota', async () => {
    const email = `gen-${stamp}@example.com`;
    emails.push(email);
    const res = await controller.createUser(admin, { email, name: 'Generado', role: Role.ADMIN, quotaGb: 7 });
    expect(res.generatedPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(res.user.role).toBe('ADMIN');
    expect(res.user.storageQuotaBytes).toBe(7 * 1024 ** 3);
    const row = await prisma.user.findUniqueOrThrow({ where: { email }, include: { settings: true, aiSettings: true } });
    expect(row.passwordHash).not.toContain(res.generatedPassword!);
    expect(row.settings).not.toBeNull();
    await expect(auth.login(email, res.generatedPassword!, {})).resolves.toBeTruthy();
  });

  it('rechaza un correo ya registrado', async () => {
    await expect(controller.createUser(admin, { email: `GEN-${stamp}@example.com`, name: 'Repetido' })).rejects.toThrow('Ya existe');
  });
});
