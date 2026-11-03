-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "hookDuration" DOUBLE PRECISION NOT NULL DEFAULT 3,
ADD COLUMN     "hookEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hookText" TEXT,
ADD COLUMN     "segments" JSONB,
ADD COLUMN     "wordOverride" JSONB;

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "hookTitles" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SubtitlePreset" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "style" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubtitlePreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFont" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "family" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFont_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubtitlePreset_userId_idx" ON "SubtitlePreset"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserFont_storageKey_key" ON "UserFont"("storageKey");

-- CreateIndex
CREATE INDEX "UserFont_userId_idx" ON "UserFont"("userId");

-- AddForeignKey
ALTER TABLE "SubtitlePreset" ADD CONSTRAINT "SubtitlePreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFont" ADD CONSTRAINT "UserFont_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

