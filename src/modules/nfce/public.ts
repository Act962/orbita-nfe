/**
 * Fachada pública do módulo NFC-e (Fase 3). Por enquanto, só consultas que não emitem nada:
 * status do serviço (ADR-0063) e situação da nota pela chave (ADR-0064).
 */
export {
  ACCESS_KEY_PATTERN,
  accessKeyCheckDigit,
  buildAccessKey,
  isAcceptableNumericCode,
  isValidAccessKey,
  type AccessKey,
  type AccessKeyIssue,
  type AccessKeyParts,
} from './domain/access-key.js';
export { buildSoapEnvelope, readWsdlContract, type SefazFailure, type WsdlContract } from './infrastructure/sefaz/sefaz-soap.js';
export { ICP_BRASIL_V10_FILE, loadServerTrust, ServerTrustError } from './infrastructure/sefaz/server-trust.js';
export { checkConsumerSale, saleTotals, type ConsumerSale, type SaleIssuer, type SaleTotals } from './domain/consumer-sale.js';
export { consumerSaleSchema } from './presentation/http/consumer-sale-schema.js';
export {
  authorize,
  AUTHORIZATION_SCHEMA_PACKAGE,
  buildEnviNFe,
  readAuthorizationResponse,
  SVRS_NFCE_AUTHORIZATION,
  type AuthorizationOutcome,
  type AuthorizationResult,
  type ExpectedInvoice,
} from './infrastructure/sefaz/authorization.js';
export { buildNfceXml, finishNfceXml, type NfceIssuerData, type NfceXmlInput } from './infrastructure/xml/nfce-xml.js';
export {
  digestValueHex,
  hashWithCsc,
  PI_QR_CODE_URL,
  QrCodeError,
  qrCodeV2Offline,
  qrCodeV2Online,
  qrCodeV3Offline,
  qrCodeV3Online,
  type Csc,
  type QrRecipient,
} from './infrastructure/qrcode/qr-code-url.js';
export {
  buildConsStatServ,
  queryServiceStatus,
  readStatusResponse,
  STATUS_SCHEMA_PACKAGE,
  SVRS_NFCE_STATUS,
  type ServiceStatus,
  type StatusQuery,
  type StatusResult,
} from './infrastructure/sefaz/status-service.js';
export {
  buildConsSitNFe,
  PROTOCOL_SCHEMA_PACKAGE,
  queryProtocol,
  readProtocolResponse,
  SVRS_NFCE_PROTOCOL_QUERY,
  type ProtocolResult,
  type ProtocolSituation,
} from './infrastructure/sefaz/protocol-query.js';
