// Neonfi backend — object storage (Cloudflare R2, S3-compatible) — retrofit-90.
//
// Used only by the avatar upload/clear endpoints. Exposes the minimum avatars need:
// putObject + deleteObject, plus public-URL helpers. No presigning — avatars are
// public-read (embedded in <img>), so a stable public URL is the right model.
//
// The S3 client is created lazily so the app boots even when R2 isn't configured;
// every method first asserts `isAvatarStorageConfigured` (the controller already
// guards with a 503, so reaching here unconfigured is a programmer error).

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config, isAvatarStorageConfigured } from './config.js';

let client: S3Client | null = null;

function r2(): S3Client {
  if (!isAvatarStorageConfigured) throw new Error('R2 not configured');
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: config.R2_ENDPOINT!,
      forcePathStyle: true,
      // Cloudflare R2 does NOT support the integrity checksums the AWS SDK v3 began sending by
      // default in v3.729+ (x-amz-checksum-* / aws-chunked content-encoding) — they make every
      // PutObject fail. Only compute/validate checksums WHEN_REQUIRED so R2 PUT/GET work. (retrofit-90 fix)
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID!,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return client;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await r2().send(
    new PutObjectCommand({ Bucket: config.R2_BUCKET!, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET!, Key: key }));
}

/** Public URL for a stored object key. */
export function publicUrl(key: string): string {
  return `${config.R2_PUBLIC_BASE_URL!.replace(/\/$/, '')}/${key}`;
}

/** If a stored avatarUrl is one of ours, recover its object key (else null). */
export function keyFromPublicUrl(url: string | null): string | null {
  if (!url || !config.R2_PUBLIC_BASE_URL) return null;
  const base = config.R2_PUBLIC_BASE_URL.replace(/\/$/, '') + '/';
  return url.startsWith(base) ? url.slice(base.length) : null;
}
