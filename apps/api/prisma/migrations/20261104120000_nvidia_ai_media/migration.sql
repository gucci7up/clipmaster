-- Funciones de IA de NVIDIA (opcionales, desactivadas por defecto). Sólo añade columnas.
ALTER TABLE "Clip" ADD COLUMN "aiEyeContact" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clip" ADD COLUMN "aiRelight" INTEGER;
ALTER TABLE "Clip" ADD COLUMN "hookVoice" TEXT;
ALTER TABLE "Clip" ADD COLUMN "coverPrompt" TEXT;
ALTER TABLE "ClipRender" ADD COLUMN "coverKey" TEXT;
ALTER TABLE "ClipRender" ADD COLUMN "aiStatus" JSONB;
ALTER TABLE "AISettings" ADD COLUMN "visionLLM" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AISettings" ADD COLUMN "aiMedia" BOOLEAN NOT NULL DEFAULT false;
