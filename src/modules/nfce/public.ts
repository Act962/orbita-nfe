/**
 * Fachada pública do módulo NFC-e (Fase 3). Por enquanto, só a consulta do status do serviço,
 * que não emite nada (ADR-0063).
 */
export {
  buildConsStatServ,
  buildSoapEnvelope,
  queryServiceStatus,
  readStatusResponse,
  readWsdlContract,
  STATUS_SCHEMA_PACKAGE,
  SVRS_NFCE_STATUS,
  type ServiceStatus,
  type StatusQuery,
  type StatusResult,
  type WsdlContract,
} from './infrastructure/sefaz/status-service.js';
