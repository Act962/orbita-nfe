import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { anchorKey, anchorPrefix, parseAnchor, serializeAnchor, type AnchorStore, type ChainAnchor, type StoredAnchor } from '../../application/audit-anchor.js';
import type { AuditChainRef } from '../../application/audit-verifier.js';

export interface S3AnchorStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Provedores compatíveis (SeaweedFS, MinIO) costumam exigir path-style. */
  readonly forcePathStyle: boolean;
  /** Dias de retenção COMPLIANCE de cada âncora. */
  readonly retentionDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Âncoras no S3 com Object Lock (ADR-0031). O bucket precisa ter sido criado com Object Lock
 * habilitado: cada PUT pede retenção COMPLIANCE explícita e falha se o bucket não aceitar, em vez
 * de gravar uma âncora apagável sem avisar.
 */
export class S3AnchorStore implements AnchorStore {
  private readonly client: S3Client;

  constructor(private readonly options: S3AnchorStoreOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Provedores compatíveis nem sempre aceitam os checksums novos do SDK; o Content-MD5
      // (exigido pelo Object Lock) vai explícito.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }

  async put(anchor: ChainAnchor): Promise<StoredAnchor> {
    const body = Buffer.from(serializeAnchor(anchor), 'utf8');
    const key = anchorKey(anchor);
    const retainUntil = new Date(anchor.anchoredAt.getTime() + this.options.retentionDays * DAY_MS);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        ContentMD5: createHash('md5').update(body).digest('base64'),
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );
    return { ...anchor, location: key, retainUntil };
  }

  async latest(chain: AuditChainRef): Promise<StoredAnchor | undefined> {
    let latestKey: string | undefined;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: anchorPrefix(chain), ContinuationToken: token }));
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined && (latestKey === undefined || object.Key > latestKey)) latestKey = object.Key;
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    if (latestKey === undefined) return undefined;

    const object = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: latestKey }));
    const text = (await object.Body?.transformToString('utf8')) ?? '';
    const anchor = parseAnchor(text);
    const sameChain = anchor.chain.kind === chain.kind && (chain.kind === 'PLATFORM' || (anchor.chain.kind === 'COMPANY' && anchor.chain.companyId === chain.companyId));
    if (!sameChain) throw new Error('ANCHOR_CHAIN_MISMATCH');
    return { ...anchor, location: latestKey, retainUntil: object.ObjectLockRetainUntilDate ?? null };
  }

  close(): void {
    this.client.destroy();
  }
}
