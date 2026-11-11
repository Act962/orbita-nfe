// Cria no S3 LOCAL (SeaweedFS do docker-compose) o bucket das âncoras de auditoria COM Object
// Lock, como em produção (ADR-0031). Idempotente.
//   docker compose -f docker/docker-compose.yml up -d object-storage && npm run dev:object-storage
import process from 'node:process';
import { CreateBucketCommand, GetObjectLockConfigurationCommand, S3Client } from '@aws-sdk/client-s3';

const endpoint = process.env.AUDIT_ANCHOR_S3_ENDPOINT ?? 'http://127.0.0.1:8333';
const bucket = process.env.AUDIT_ANCHOR_S3_BUCKET ?? 'orbita-audit-anchors-dev';
const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'dev-only', secretAccessKey: 'dev-only' } });
try {
  await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  process.stdout.write(`bucket ${bucket} criado com Object Lock em ${endpoint}\n`);
} catch (error) {
  if (error?.name !== 'BucketAlreadyOwnedByYou' && error?.name !== 'BucketAlreadyExists') throw error;
  const lock = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
  process.stdout.write(`bucket ${bucket} já existe (Object Lock: ${lock.ObjectLockConfiguration?.ObjectLockEnabled ?? 'desligado'})\n`);
} finally {
  s3.destroy();
}
