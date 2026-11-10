import { z } from 'zod';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { withIssueFields } from '../../../../shared/presentation/http/issue-fields.js';
import { ProblemSchema, commonErrorResponses } from '../../../../shared/presentation/http/problem.js';
import { auditContextOf, authErrorResponses, companyIdOf, CompanyHeaders } from '../../../../shared/presentation/http/request-context.js';
import type { CertificateService } from '../../application/certificate-service.js';
import {
  DISPLAYED_CERTIFICATE_STATUSES,
  EXPIRING_WINDOW_DAYS,
  MAX_PASSWORD_LENGTH,
  MAX_PFX_BYTES,
  REJECTION_REASONS,
  displayedStatus,
  type Certificate,
} from '../../domain/certificate.js';

const TAG = 'Certificados';

/** Base64 de até MAX_PFX_BYTES (4 caracteres a cada 3 bytes), com folga para quebras de linha. */
const MAX_PFX_BASE64 = Math.ceil(MAX_PFX_BYTES / 3) * 4 + 1024;

const CertificateResponse = z
  .object({
    id: z.uuid(),
    establishmentId: z.uuid(),
    status: z.enum(DISPLAYED_CERTIFICATE_STATUSES).meta({
      description: `PENDING_VALIDATION (aguardando o worker fiscal), ACTIVE, EXPIRING (vence em até ${EXPIRING_WINDOW_DAYS} dias), EXPIRED, REJECTED, REPLACED (substituído por um novo) ou REVOKED.`,
    }),
    rejectionReason: z.enum(REJECTION_REASONS).nullable().meta({ description: 'Motivo da rejeição (regra CERT-001).' }),
    subjectCnpj: z.string().nullable().meta({ description: 'CNPJ do titular, lido do certificado (OID 2.16.76.1.3.3).' }),
    subjectName: z.string().nullable(),
    issuerName: z.string().nullable(),
    serialNumber: z.string().nullable(),
    notBefore: z.iso.datetime().nullable(),
    notAfter: z.iso.datetime().nullable(),
    thumbprintSha256: z.string().nullable().meta({ description: 'Impressão digital SHA-256 do certificado, em hexadecimal.' }),
    createdAt: z.iso.datetime(),
    validatedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Certificate', description: 'Somente metadados. A chave privada e a senha nunca saem do cofre.' });

const UploadBody = z
  .object({
    pfx: z
      .base64()
      .max(MAX_PFX_BASE64)
      .meta({ description: `Arquivo PKCS#12 (.pfx/.p12) do e-CNPJ A1 em base64 (até ${MAX_PFX_BYTES / 1024} KB).` }),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH).meta({ description: 'Senha do arquivo. Nunca é devolvida, exibida nem registrada em log.' }),
  })
  .meta({ id: 'UploadCertificate' });

const EstablishmentParams = z.object({ establishmentId: z.uuid() });
const CertificateParams = z.object({ establishmentId: z.uuid(), certificateId: z.uuid() });

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

const certificateJson = (c: Certificate, now: Date): z.infer<typeof CertificateResponse> => ({
  id: c.id,
  establishmentId: c.establishmentId,
  status: displayedStatus(c, now),
  rejectionReason: c.rejectionReason,
  subjectCnpj: c.metadata?.subjectCnpj ?? null,
  subjectName: c.metadata?.subjectName ?? null,
  issuerName: c.metadata?.issuerName ?? null,
  serialNumber: c.metadata?.serialNumber ?? null,
  notBefore: iso(c.metadata?.notBefore ?? null),
  notAfter: iso(c.metadata?.notAfter ?? null),
  thumbprintSha256: c.metadata?.thumbprintSha256 ?? null,
  createdAt: c.createdAt.toISOString(),
  validatedAt: iso(c.validatedAt),
  revokedAt: iso(c.revokedAt),
});

const establishmentNotFound = ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND (inexistente ou de outra empresa).');

export function registerCertificateRoutes(app: HttpApp, service: CertificateService, now: () => Date = () => new Date()): void {
  app.post(
    '/v1/establishments/:establishmentId/certificates',
    {
      config: { auth: { scope: 'certificates:manage', company: true } },
      // Só o necessário para o PFX em base64 + senha.
      bodyLimit: MAX_PFX_BASE64 + 4096,
      schema: {
        tags: [TAG],
        summary: 'Enviar certificado A1',
        description:
          'Recebe o e-CNPJ A1 e a senha, cifra imediatamente (envelope com chave da plataforma) e devolve 202 com status PENDING_VALIDATION. ' +
          'A validação (cadeia ICP-Brasil, validade, CNPJ do titular com a raiz da empresa, uso de chave) é feita pelo worker fiscal. ' +
          'O certificado ativo anterior continua valendo até o novo ser aprovado.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: EstablishmentParams,
        body: UploadBody,
        response: { 202: CertificateResponse, ...commonErrorResponses, ...authErrorResponses, 404: establishmentNotFound },
      },
    },
    async (request, reply) => {
      const material = { pfx: Buffer.from(request.body.pfx, 'base64'), password: Buffer.from(request.body.password, 'utf8') };
      const certificate = await withIssueFields('body', () =>
        service.upload(companyIdOf(request), request.params.establishmentId, material, auditContextOf(request)),
      );
      return reply
        .status(202)
        .header('location', `/v1/establishments/${certificate.establishmentId}/certificates/${certificate.id}`)
        .send(certificateJson(certificate, now()));
    },
  );

  app.get(
    '/v1/establishments/:establishmentId/certificates',
    {
      config: { auth: { scope: 'certificates:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Listar certificados do estabelecimento',
        description: 'Mais recentes primeiro. Apenas metadados.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: EstablishmentParams,
        response: { 200: z.object({ items: z.array(CertificateResponse) }), ...commonErrorResponses, ...authErrorResponses, 404: establishmentNotFound },
      },
    },
    async (request) => {
      const at = now();
      return { items: (await service.list(companyIdOf(request), request.params.establishmentId)).map((c) => certificateJson(c, at)) };
    },
  );

  app.get(
    '/v1/establishments/:establishmentId/certificates/:certificateId',
    {
      config: { auth: { scope: 'certificates:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar certificado',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: CertificateParams,
        response: { 200: CertificateResponse, ...commonErrorResponses, ...authErrorResponses, 404: ProblemSchema.describe('CERTIFICATE_NOT_FOUND') },
      },
    },
    async (request) => certificateJson(await service.get(companyIdOf(request), request.params.establishmentId, request.params.certificateId), now()),
  );

  app.post(
    '/v1/establishments/:establishmentId/certificates/:certificateId/revocation',
    {
      config: { auth: { scope: 'certificates:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Revogar certificado',
        description:
          'Revoga o certificado e destrói a chave do envelope: o conteúdo cifrado deixa de poder ser aberto. Irreversível. ' +
          'Se for o certificado ativo, a emissão do estabelecimento para até outro ser validado.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: CertificateParams,
        response: {
          200: CertificateResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('CERTIFICATE_NOT_FOUND'),
          422: ProblemSchema.describe('CERTIFICATE_ALREADY_REVOKED'),
        },
      },
    },
    async (request) =>
      certificateJson(
        await service.revoke(companyIdOf(request), request.params.establishmentId, request.params.certificateId, auditContextOf(request)),
        now(),
      ),
  );
}
