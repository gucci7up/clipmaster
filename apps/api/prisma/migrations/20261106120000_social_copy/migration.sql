-- Texto para publicar (título, descripción, hashtags) generado con el LLM. Sólo añade un valor y columnas.
ALTER TYPE "JobType" ADD VALUE 'COPY';
ALTER TABLE "Clip" ADD COLUMN "socialCopy" JSONB;
ALTER TABLE "Clip" ADD COLUMN "socialStatus" TEXT;
ALTER TABLE "Clip" ADD COLUMN "socialError" TEXT;
