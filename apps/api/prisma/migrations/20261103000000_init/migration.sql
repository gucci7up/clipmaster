-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PENDING', 'VALIDATING', 'CAPTURING', 'DOWNLOADING', 'TRANSCRIBING', 'ANALYZING', 'GENERATING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('UPLOAD', 'URL');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('UPLOAD', 'YOUTUBE', 'TWITCH', 'KICK', 'TIKTOK', 'DIRECT', 'HLS');

-- CreateEnum
CREATE TYPE "ContentMode" AS ENUM ('AUTO', 'GAMING', 'DOMINO', 'PODCAST', 'INTERVIEW', 'REACTION', 'HUMOR', 'EDUCATION', 'SPORTS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AspectRatio" AS ENUM ('VERTICAL', 'HORIZONTAL', 'SQUARE');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('IMPORT', 'LIVE_CAPTURE', 'ANALYZE', 'RENDER', 'CLEANUP');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CaptureStatus" AS ENUM ('STARTING', 'RECORDING', 'RECONNECTING', 'STOPPING', 'ENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ClipStatus" AS ENUM ('PENDING', 'RENDERING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('UPLOAD', 'ORIGINAL', 'SEGMENT', 'AUDIO', 'TRANSCRIPT', 'SUBTITLE', 'THUMBNAIL', 'CLIP', 'OTHER');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "storageQuotaBytes" BIGINT NOT NULL DEFAULT 53687091200,
    "storageUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "resetTokenHash" TEXT,
    "resetTokenExpires" TIMESTAMP(3),
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "ContentMode" NOT NULL DEFAULT 'AUTO',
    "language" TEXT,
    "maxClips" INTEGER NOT NULL DEFAULT 10,
    "minDuration" INTEGER NOT NULL DEFAULT 15,
    "maxDuration" INTEGER NOT NULL DEFAULT 60,
    "aspect" "AspectRatio" NOT NULL DEFAULT 'VERTICAL',
    "subtitles" BOOLEAN NOT NULL DEFAULT true,
    "smartDetection" BOOLEAN NOT NULL DEFAULT true,
    "preference" TEXT NOT NULL DEFAULT 'balanced',
    "errorMessage" TEXT,
    "detectedLanguage" TEXT,
    "processingMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoSource" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "provider" "Provider" NOT NULL,
    "url" TEXT,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "uploadKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureSession" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "CaptureStatus" NOT NULL DEFAULT 'STARTING',
    "segmentSeconds" INTEGER NOT NULL DEFAULT 60,
    "segmentsCount" INTEGER NOT NULL DEFAULT 0,
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reconnects" INTEGER NOT NULL DEFAULT 0,
    "endedReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CaptureSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "hasAudio" BOOLEAN NOT NULL,
    "hasVideo" BOOLEAN NOT NULL,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "container" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoSegment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "captureSessionId" UUID,
    "index" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "analyzed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "queue" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "progress" DOUBLE PRECISION,
    "stage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "errorHistory" JSONB NOT NULL DEFAULT '[]',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "segmentId" UUID,
    "language" TEXT,
    "model" TEXT,
    "storageKey" TEXT,
    "srtKey" TEXT,
    "windowStart" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "windowEnd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" UUID NOT NULL,
    "transcriptId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "start" DOUBLE PRECISION NOT NULL,
    "end" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "words" JSONB NOT NULL,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HighlightCandidate" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "start" DOUBLE PRECISION NOT NULL,
    "end" DOUBLE PRECISION NOT NULL,
    "peakTime" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "tags" TEXT[],
    "track" JSONB,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HighlightCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clip" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "candidateId" UUID,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "start" DOUBLE PRECISION NOT NULL,
    "end" DOUBLE PRECISION NOT NULL,
    "aspect" "AspectRatio" NOT NULL,
    "subtitles" BOOLEAN NOT NULL DEFAULT true,
    "subtitleStyle" JSONB NOT NULL,
    "reframeMode" TEXT NOT NULL DEFAULT 'auto',
    "manualX" DOUBLE PRECISION,
    "manualY" DOUBLE PRECISION,
    "status" "ClipStatus" NOT NULL DEFAULT 'PENDING',
    "currentRenderId" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipRender" (
    "id" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "status" "ClipStatus" NOT NULL DEFAULT 'PENDING',
    "start" DOUBLE PRECISION NOT NULL,
    "end" DOUBLE PRECISION NOT NULL,
    "aspect" "AspectRatio" NOT NULL,
    "outputKey" TEXT,
    "thumbnailKey" TEXT,
    "sizeBytes" BIGINT,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "encoder" TEXT,
    "error" TEXT,
    "renderMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ClipRender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubtitleTrack" (
    "id" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "renderId" UUID,
    "format" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubtitleTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingEvent" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobId" UUID,
    "type" TEXT NOT NULL,
    "stage" TEXT,
    "progress" DOUBLE PRECISION,
    "message" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "defaultMode" "ContentMode" NOT NULL DEFAULT 'AUTO',
    "defaultAspect" "AspectRatio" NOT NULL DEFAULT 'VERTICAL',
    "defaultLanguage" TEXT DEFAULT 'es',
    "subtitleStyle" JSONB,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AISettings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "weights" JSONB,
    "visualAnalysis" BOOLEAN NOT NULL DEFAULT true,
    "semanticLLM" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AISettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageAsset" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "projectId" UUID,
    "kind" "AssetKind" NOT NULL,
    "key" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "mimeType" TEXT,
    "temporary" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "ip" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_resetTokenHash_key" ON "User"("resetTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Project_userId_createdAt_idx" ON "Project"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VideoSource_projectId_key" ON "VideoSource"("projectId");

-- CreateIndex
CREATE INDEX "CaptureSession_projectId_idx" ON "CaptureSession"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAsset_storageKey_key" ON "VideoAsset"("storageKey");

-- CreateIndex
CREATE INDEX "VideoAsset_projectId_idx" ON "VideoAsset"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoSegment_storageKey_key" ON "VideoSegment"("storageKey");

-- CreateIndex
CREATE INDEX "VideoSegment_projectId_startSec_idx" ON "VideoSegment"("projectId", "startSec");

-- CreateIndex
CREATE UNIQUE INDEX "VideoSegment_captureSessionId_index_key" ON "VideoSegment"("captureSessionId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_dedupeKey_key" ON "ProcessingJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "ProcessingJob_projectId_type_idx" ON "ProcessingJob"("projectId", "type");

-- CreateIndex
CREATE INDEX "ProcessingJob_status_updatedAt_idx" ON "ProcessingJob"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Transcript_projectId_idx" ON "Transcript"("projectId");

-- CreateIndex
CREATE INDEX "TranscriptSegment_projectId_start_idx" ON "TranscriptSegment"("projectId", "start");

-- CreateIndex
CREATE INDEX "TranscriptSegment_transcriptId_idx" ON "TranscriptSegment"("transcriptId");

-- CreateIndex
CREATE INDEX "HighlightCandidate_projectId_score_idx" ON "HighlightCandidate"("projectId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "Clip_candidateId_key" ON "Clip"("candidateId");

-- CreateIndex
CREATE INDEX "Clip_projectId_score_idx" ON "Clip"("projectId", "score");

-- CreateIndex
CREATE INDEX "ClipRender_clipId_createdAt_idx" ON "ClipRender"("clipId", "createdAt");

-- CreateIndex
CREATE INDEX "SubtitleTrack_clipId_idx" ON "SubtitleTrack"("clipId");

-- CreateIndex
CREATE INDEX "ProcessingEvent_projectId_createdAt_idx" ON "ProcessingEvent"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AISettings_userId_key" ON "AISettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageAsset_key_key" ON "StorageAsset"("key");

-- CreateIndex
CREATE INDEX "StorageAsset_userId_deletedAt_idx" ON "StorageAsset"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "StorageAsset_projectId_idx" ON "StorageAsset"("projectId");

-- CreateIndex
CREATE INDEX "StorageAsset_temporary_expiresAt_idx" ON "StorageAsset"("temporary", "expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoSource" ADD CONSTRAINT "VideoSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureSession" ADD CONSTRAINT "CaptureSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoSegment" ADD CONSTRAINT "VideoSegment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoSegment" ADD CONSTRAINT "VideoSegment_captureSessionId_fkey" FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HighlightCandidate" ADD CONSTRAINT "HighlightCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "HighlightCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipRender" ADD CONSTRAINT "ClipRender_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubtitleTrack" ADD CONSTRAINT "SubtitleTrack_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingEvent" ADD CONSTRAINT "ProcessingEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AISettings" ADD CONSTRAINT "AISettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageAsset" ADD CONSTRAINT "StorageAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

