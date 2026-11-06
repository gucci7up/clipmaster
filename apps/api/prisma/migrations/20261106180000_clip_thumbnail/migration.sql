-- Miniatura con texto de cada clip. Sólo añade un valor y columnas.
ALTER TYPE "JobType" ADD VALUE 'THUMBNAIL';
ALTER TABLE "Clip" ADD COLUMN "thumbConfig" JSONB;
ALTER TABLE "Clip" ADD COLUMN "thumbKey" TEXT;
ALTER TABLE "Clip" ADD COLUMN "thumbStatus" TEXT;
ALTER TABLE "Clip" ADD COLUMN "thumbError" TEXT;
