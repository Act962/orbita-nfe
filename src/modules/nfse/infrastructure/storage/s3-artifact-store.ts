import { createHash } from 'node:crypto';
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { InternalError } from '../../../../shared/application/errors.js';
import type { NfseArtifactStore, StoredArtifact } from '../../application/ports.js';

export interface S3ArtifactStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Provedores compatíveis (SeaweedFS, MinIO) costumam exigir path-style. */
  readonly forcePathStyle: boolean;
}

/**
 * Artefatos fiscais no S3 com Object Lock (ADR-0010, ADR-0048). O bucket precisa ter sido criado
 * com Object Lock: cada PUT pede retenção COMPLIANCE explícita e falha se o bucket não aceitar, em
 * vez de gravar um XML apagável sem avisar. Depois do PUT, o objeto é relido para conferência.
 */
export class S3ArtifactStore implements NfseArtifactStore {
  private readonly client: S3Client;

  constructor(private readonly options: S3ArtifactStoreOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Como na âncora (ADR-0031): o Content-MD5, exigido pelo Object Lock, vai explícito.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }

  async put(object: { readonly key: string; readonly body: Buffer; readonly contentType: string; readonly retainUntil: Date }): Promise<Buffer> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: object.key,
        Body: object.body,
        ContentType: object.contentType,
        ContentMD5: createHash('md5').update(object.body).digest('base64'),
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: object.retainUntil,
      }),
    );
    const stored = await this.read(object.key);
    if (stored === undefined) throw new InternalError('ARTIFACT_NOT_FOUND_AFTER_PUT');
    if (stored.lockMode !== 'COMPLIANCE' || stored.retainUntil === null || stored.retainUntil.getTime() < object.retainUntil.getTime() - 1000) {
      // O bucket aceitou o PUT, mas o objeto não está travado como pedido: não conta como arquivado.
      throw new InternalError('ARTIFACT_NOT_LOCKED');
    }
    return stored.body;
  }

  /** Só "não existe" vira `undefined`; qualquer outro erro sobe (rede, credencial, provedor fora). */
  async read(key: string): Promise<StoredArtifact | undefined> {
    try {
      const stored = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return {
        body: Buffer.from((await stored.Body?.transformToByteArray()) ?? new Uint8Array()),
        lockMode: stored.ObjectLockMode ?? null,
        retainUntil: stored.ObjectLockRetainUntilDate ?? null,
      };
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  close(): void {
    this.client.destroy();
  }
}
