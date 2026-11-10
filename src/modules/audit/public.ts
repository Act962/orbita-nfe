/**
 * Fachada pública do módulo Audit (trilha append-only com hash encadeado).
 */
export { AuditVerifier, type AuditChainRef, type AuditVerification } from './application/audit-verifier.js';
export { companyAuditTrail, platformAuditTrail, DrizzleAuditChainReader, sha256ChainHasher } from './infrastructure/persistence/audit-store.js';
