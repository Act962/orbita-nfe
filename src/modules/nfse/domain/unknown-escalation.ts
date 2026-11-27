/** Escalonamento de NFS-e em UNKNOWN pela idade (doc 12 §6, ADR-0034 item 5): regra comum em shared. */
export {
  DEFAULT_ESCALATION_POLICY,
  escalationLevel,
  nextEscalationAt,
  type EscalationLevel,
  type EscalationPolicy,
} from '../../../shared/domain/unknown-escalation.js';
