import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { env } from '../config/env';

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;
export const STORAGE_PREFIXES = [
  'uploads', 'originals', 'segments', 'audio', 'transcripts', 'analysis',
  'thumbnails', 'clips', 'subtitles', 'exports',
] as const;
export type StoragePrefix = (typeof STORAGE_PREFIXES)[number];

/**
 * Claves generadas exclusivamente por el servidor: <prefijo>/<userId>/<projectId>/<uuid>.<ext>.
 * Nunca se usan nombres de archivo del usuario → sin colisiones ni traversal.
 */
export function buildKey(prefix: StoragePrefix, userId: string, projectId: string, ext: string): string {
  if (!SAFE_SEGMENT.test(userId) || !SAFE_SEGMENT.test(projectId)) throw new Error('Identificador inválido para clave');
  const cleanExt = ext.replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(cleanExt)) throw new Error('Extensión inválida');
  return `${prefix}/${userId}/${projectId}/${randomUUID()}.${cleanExt}`;
}

export function prefixFor(prefix: StoragePrefix, userId: string, projectId: string): string {
  if (!SAFE_SEGMENT.test(userId) || !SAFE_SEGMENT.test(projectId)) throw new Error('Identificador inválido para prefijo');
  return `${prefix}/${userId}/${projectId}`;
}

/** Comprueba que una clave pertenece al usuario/proyecto (defensa en profundidad). */
export function keyBelongsTo(key: string, userId: string, projectId?: string): boolean {
  if (key.includes('..') || key.startsWith('/')) return false;
  const parts = key.split('/');
  if (parts.length < 4 || !STORAGE_PREFIXES.includes(parts[0] as StoragePrefix)) return false;
  return parts[1] === userId && (projectId === undefined || parts[2] === projectId);
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  readonly s3: S3Client;
  readonly bucket = env().S3_BUCKET;

  constructor() {
    const e = env();
    this.s3 = new S3Client({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
    });
  }

  async onModuleInit() {
    if (env().NODE_ENV === 'test') return;
    await this.ensureBucket().catch((err) => this.log.error(`No se pudo preparar el bucket: ${err.message}`));
  }

  /** Crea el bucket privado si no existe y aplica una política que deniega acceso anónimo. */
  async ensureBucket() {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.log.log(`Bucket ${this.bucket} creado`);
    }
    const policy = {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'DenyAnonymous', Effect: 'Deny', Principal: '*', Action: 's3:GetObject',
        Resource: [`arn:aws:s3:::${this.bucket}/*`],
        Condition: { StringEquals: { 'aws:principaltype': 'Anonymous' } },
      }],
    };
    await this.s3.send(new PutBucketPolicyCommand({ Bucket: this.bucket, Policy: JSON.stringify(policy) })).catch(() => undefined);
  }

  async ping(): Promise<boolean> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }

  async uploadStream(key: string, body: Readable, contentType: string): Promise<void> {
    await new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
    }).done();
  }

  /** Subida multiparte controlada por el llamador (capturadores remotos que envían el archivo por trozos). */
  async createMultipart(key: string, contentType: string): Promise<string> {
    const r = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!r.UploadId) throw new Error('El almacenamiento no devolvió UploadId');
    return r.UploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    const r = await this.s3.send(new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body }));
    if (!r.ETag) throw new Error('El almacenamiento no devolvió ETag');
    return r.ETag;
  }

  async completeMultipart(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]): Promise<void> {
    await this.s3.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
  }

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch {
      return null;
    }
  }

  async getStream(key: string, range?: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
    return r;
  }

  async getJson<T>(key: string): Promise<T> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const text = await r.Body!.transformToString('utf-8');
    return JSON.parse(text) as T;
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
