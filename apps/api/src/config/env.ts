import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

/** Las variables vacías (p. ej. `ADMIN_EMAIL=` en compose) cuentan como no definidas. */
const optional = <T extends z.ZodTypeAny>(inner: T) => z.preprocess((v) => (v === '' ? undefined : v), inner.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().default('clipmaster'),
  S3_FORCE_PATH_STYLE: bool.default(true),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET debe tener al menos 32 caracteres'),
  MEDIA_SIGNING_SECRET: z.string().min(32, 'MEDIA_SIGNING_SECRET debe tener al menos 32 caracteres'),
  INTERNAL_API_TOKEN: z.string().min(32, 'INTERNAL_API_TOKEN debe tener al menos 32 caracteres'),
  CAPTURE_WORKER_URL: z.string().default('http://capture-worker:8000'),
  SESSION_TTL_DAYS: z.coerce.number().default(14),
  COOKIE_SECURE: bool.default(true),
  ALLOW_REGISTRATION: bool.default(true),
  ADMIN_EMAIL: optional(z.string().email()),
  ADMIN_PASSWORD: optional(z.string().min(12)),
  MAX_UPLOAD_MB: z.coerce.number().default(4096),
  UPLOAD_TMP_DIR: z.string().default('/tmp/clipmaster-uploads'),
  DEFAULT_QUOTA_GB: z.coerce.number().default(50),
  MAX_VIDEO_DURATION_SEC: z.coerce.number().default(4 * 3600),
  MAX_LIVE_DURATION_SEC: z.coerce.number().default(6 * 3600),
  LIVE_SEGMENT_SECONDS: z.coerce.number().default(60),
  LIVE_CONTEXT_SECONDS: z.coerce.number().default(20),
  MAX_ACTIVE_PROJECTS_PER_USER: z.coerce.number().default(3),
  JOB_ATTEMPTS: z.coerce.number().default(3),
  TEMP_RETENTION_HOURS: z.coerce.number().default(48),
  MEDIA_URL_TTL_SEC: z.coerce.number().default(3600),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(120),
  SMTP_URL: optional(z.string()),
  SMTP_FROM: z.string().default('ClipMaster AI <no-reply@localhost>'),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Configuración inválida:\n  ${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Sólo para pruebas. */
export function setEnvForTests(e: Env) {
  cached = e;
}
