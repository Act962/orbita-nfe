import { describe, expect, it } from 'vitest';
import { assertIdsOnlyPayload } from '../shared/infrastructure/queue/postgres-queue.js';
import { loadConfig } from './config.js';
import { loadFiscalWorkerConfig, loadGeneralWorkerConfig } from './worker-config.js';

const FISCAL = {
  WORKER_DATABASE_URL: 'postgres://app_worker:x@localhost/orbita_nfe',
  WORKER_CERTIFICATE_KEK_PRIVATE_FILE: '/run/secrets/kek-private.pem',
  CERTIFICATE_TRUST_BUNDLE_FILE: '/run/secrets/trust-bundle.pem',
};
const GENERAL = {
  GENERAL_DATABASE_URL: 'postgres://app_general:x@localhost/orbita_nfe',
  GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE: '/run/secrets/webhook-private.pem',
};
const API = {
  DATABASE_URL: 'postgres://app_api:x@localhost/orbita_nfe',
  API_KEY_PEPPER_FILE: '/run/secrets/pepper',
  CERTIFICATE_KEK_PUBLIC_FILE: '/run/secrets/kek-public.pem',
  WEBHOOK_SECRET_KEY_PUBLIC_FILE: '/run/secrets/webhook-public.pem',
};

describe('separação de segredos por processo (ADR-0021)', () => {
  it('worker-fiscal sobe com a KEK e, em produção, recusa a chave de webhooks', () => {
    expect(loadFiscalWorkerConfig(FISCAL).WORKER_CONCURRENCY).toBe(4);
    expect(() => loadFiscalWorkerConfig({ ...FISCAL, WEBHOOK_SECRET_KEY_PRIVATE_FILE: '/x' })).toThrow(/WEBHOOK_SECRET_KEY_PRIVATE_FILE/);
    // .env local único é tolerado; o container de produção não.
    expect(() => loadFiscalWorkerConfig({ ...FISCAL, GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE: '/x' })).not.toThrow();
    expect(() => loadFiscalWorkerConfig({ ...FISCAL, NODE_ENV: 'production', GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE: '/x' })).toThrow(/GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE/);
  });

  it('autorizador da NFS-e: desligado por padrão; o simulador só fora de produção (ADR-0033)', () => {
    expect(loadFiscalWorkerConfig(FISCAL).NFSE_GATEWAY).toBe('none');
    expect(loadFiscalWorkerConfig({ ...FISCAL, NFSE_GATEWAY: 'simulator' }).NFSE_GATEWAY).toBe('simulator');
    expect(() => loadFiscalWorkerConfig({ ...FISCAL, NODE_ENV: 'production', NFSE_GATEWAY: 'simulator' })).toThrow(/NFSE_GATEWAY/);
    expect(loadFiscalWorkerConfig({ ...FISCAL, NFSE_GATEWAY: 'sefin' }).NFSE_GATEWAY).toBe('sefin');
    expect(() => loadFiscalWorkerConfig({ ...FISCAL, NFSE_GATEWAY: 'sefin-producao' })).toThrow(/NFSE_GATEWAY/);
  });

  it('worker-general sobe com a chave de webhooks e, em produção, recusa a KEK dos certificados', () => {
    expect(loadGeneralWorkerConfig(GENERAL).WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(false);
    expect(() => loadGeneralWorkerConfig({ ...GENERAL, CERTIFICATE_KEK_PRIVATE_FILE: '/x' })).toThrow(/CERTIFICATE_KEK_PRIVATE_FILE/);
    expect(() => loadGeneralWorkerConfig({ ...GENERAL, WORKER_CERTIFICATE_KEK_PRIVATE_FILE: '/x' })).not.toThrow();
    expect(() => loadGeneralWorkerConfig({ ...GENERAL, NODE_ENV: 'production', WORKER_CERTIFICATE_KEK_PRIVATE_FILE: '/x' })).toThrow(/WORKER_CERTIFICATE_KEK_PRIVATE_FILE/);
  });

  it('a API recusa as chaves privadas (as dos workers, só em produção)', () => {
    expect(() => loadConfig({ ...API, WEBHOOK_SECRET_KEY_PRIVATE_FILE: '/x' })).toThrow(/WEBHOOK_SECRET_KEY_PRIVATE_FILE/);
    expect(() => loadConfig({ ...API, WEBHOOK_SECRET_KEY_PUBLIC_FILE: undefined })).toThrow(/WEBHOOK_SECRET_KEY_PUBLIC_FILE/);
    expect(() => loadConfig({ ...API, GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE: '/x' })).not.toThrow();
    expect(() => loadConfig({ ...API, NODE_ENV: 'production', GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE: '/x' })).toThrow(/chave privada de webhooks/);
    expect(() => loadConfig({ ...API, NODE_ENV: 'production', WORKER_CERTIFICATE_KEK_PRIVATE_FILE: '/x' })).toThrow(/KEK privada/);
  });

  it('destinos privados de webhook nunca em produção (SSRF)', () => {
    expect(loadConfig({ ...API, WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' }).WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(true);
    expect(() => loadConfig({ ...API, NODE_ENV: 'production', WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' })).toThrow(/WEBHOOK_ALLOW_PRIVATE_TARGETS/);
    expect(() => loadGeneralWorkerConfig({ ...GENERAL, NODE_ENV: 'production', WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' })).toThrow(/WEBHOOK_ALLOW_PRIVATE_TARGETS/);
  });

  it('âncora da auditoria (ADR-0031): opcional fora de produção, obrigatória em produção, nunca pela metade', () => {
    const anchor = {
      AUDIT_ANCHOR_S3_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
      AUDIT_ANCHOR_S3_BUCKET: 'orbita-audit-anchors',
      AUDIT_ANCHOR_S3_ACCESS_KEY_ID_FILE: '/run/secrets/anchor-key-id',
      AUDIT_ANCHOR_S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/anchor-secret',
    };
    expect(loadGeneralWorkerConfig(GENERAL).AUDIT_ANCHOR_RETENTION_DAYS).toBe(1830);
    expect(() => loadGeneralWorkerConfig({ ...GENERAL, NODE_ENV: 'production' })).toThrow(/AUDIT_ANCHOR_S3_BUCKET/);
    expect(() => loadGeneralWorkerConfig({ ...GENERAL, NODE_ENV: 'production', ...anchor })).not.toThrow();
    expect(() => loadGeneralWorkerConfig({ ...GENERAL, AUDIT_ANCHOR_S3_BUCKET: 'so-o-bucket' })).toThrow(/pela metade/);
  });

  it('rate limit com padrões e limites', () => {
    const config = loadConfig(API);
    expect(config).toMatchObject({ RATE_LIMIT_PER_MINUTE: 600, RATE_LIMIT_BURST: 120 });
    expect(() => loadConfig({ ...API, RATE_LIMIT_PER_MINUTE: '0' })).toThrow(/RATE_LIMIT_PER_MINUTE/);
  });
});

describe('conteúdo do job: só identificadores (docs/architecture/07 §3)', () => {
  const id = '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b20';

  it('aceita ids', () => {
    expect(() => { assertIdsOnlyPayload({ companyId: id, certificateId: id }); }).not.toThrow();
  });

  it.each([
    [{ companyId: 'CNPJ 12345678000190' }],
    [{ password: id.replace(/-/g, '') }],
    [{ 'chave com espaço': id }],
    [Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, id]))],
  ])('recusa %j', (payload) => {
    expect(() => { assertIdsOnlyPayload(payload); }).toThrow();
  });
});
