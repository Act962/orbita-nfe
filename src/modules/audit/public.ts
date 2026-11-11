/**
 * Fachada pública do módulo Audit (trilha append-only com hash encadeado).
 */
export { AuditVerifier, type AuditChainHead, type AuditChainRef, type AuditVerification } from './application/audit-verifier.js';
export { AuditAnchorer, type AnchorOutcome, type AnchorStore, type ChainAnchor, type StoredAnchor } from './application/audit-anchor.js';
export { S3AnchorStore, type S3AnchorStoreOptions } from './infrastructure/anchor/s3-anchor-store.js';
export {
  companyAuditTrail,
  platformAuditTrail,
  DrizzleAuditChainReader,
  sha256ChainHasher,
  anchorHeadReader,
} from './infrastructure/persistence/audit-store.js';
