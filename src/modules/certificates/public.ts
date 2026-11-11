/**
 * Fachada pública do módulo Certificate Vault (ADR-0009).
 *
 * A API usa `CertificateService` + `RsaEnvelopeSealer` (KEK pública). O worker-fiscal usa
 * `CertificateVault` + `RsaEnvelopeOpener` (KEK privada). Nunca componha o opener na API.
 */
export { CertificateService } from './application/certificate-service.js';
export { CertificateVault, type CertificateInUse, type ValidationOutcome } from './application/certificate-vault.js';
export { CertificateExpiryNotifier, type ExpiryNoticeOutcome } from './application/expiry-notifier.js';
export type { CompanyLookup, EstablishmentLookup, TrustStore } from './application/ports.js';
export type { Certificate, RejectionReason } from './domain/certificate.js';
export { RsaEnvelopeSealer, RsaEnvelopeOpener, loadPublicKek, loadPrivateKek, KekError, kekIdOf } from './infrastructure/crypto/envelope.js';
export { ForgePkcs12Reader } from './infrastructure/crypto/pkcs12.js';
export { X509TrustStore } from './infrastructure/crypto/trust-store.js';
export { certificateApiUnitOfWork, certificateExpiryUnitOfWork, certificateWorkerUnitOfWork } from './infrastructure/persistence/unit-of-work.js';
export { certificateAvailability } from './infrastructure/persistence/repositories.js';
export { registerCertificateRoutes } from './presentation/http/routes.js';
