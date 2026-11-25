import { createHash, createSign, type KeyObject } from 'node:crypto';
import { isValidAccessKey } from '../../domain/access-key.js';

/**
 * URL do QR Code da NFC-e, versões 2.00 e 3.00 (ADR-0066).
 *
 * Fonte: Manual de Especificações Técnicas do DANFE NFC-e e QR Code, versão 6.0 (março de 2025):
 * - 4.3.1/4.3.2: parâmetros da versão 2.00, online e contingência off-line;
 * - 4.3.4/4.3.5: hash = SHA-1 em hexadecimal (40 posições) da concatenação dos parâmetros com "|"
 *   seguida do CSC, sem separador; no off-line, o digVal entra como o hexadecimal dos caracteres
 *   Base64 do DigestValue. Os dois exemplos resolvidos (4.3.6.1 e 4.3.6.2) são casos de teste;
 * - 4.4.1/4.4.2: versão 3.00, sem CSC; no off-line, assinatura RSA-SHA1 (Base64), com o
 *   certificado que assina a NFC-e, da concatenação dos parâmetros 1 a 7 com os separadores;
 *   destinatário não identificado ou estrangeiro = campo vazio entre os separadores;
 * - endereço do PI: lista oficial "URL por UF utilizada no QR Code" (ENCAT), o mesmo em produção
 *   e homologação.
 *
 * A escolha entre 2.00 e 3.00 é do responsável, com o contador (diagnóstico da NFC-e). O CSC é
 * segredo: entra só na memória do hash e nunca é devolvido, gravado ou registrado.
 */
export const PI_QR_CODE_URL = 'http://www.sefaz.pi.gov.br/nfce/qrcode';

export class QrCodeError extends Error {
  constructor(readonly code: 'QR_INVALID_ACCESS_KEY' | 'QR_INVALID_CSC' | 'QR_INVALID_CSC_ID' | 'QR_INVALID_DAY' | 'QR_INVALID_TOTAL' | 'QR_INVALID_DIGEST' | 'QR_INVALID_RECIPIENT') {
    super(code);
    this.name = 'QrCodeError';
  }
}

export interface QrBase {
  /** Endereço de consulta da UF (ex.: PI_QR_CODE_URL). */
  readonly baseUrl: string;
  readonly accessKey: string;
  /** tpAmb (B24): 1 produção, 2 homologação. */
  readonly environment: '1' | '2';
}

export interface Csc {
  /** Identificador do CSC na SEFAZ, sem zeros à esquerda (1 a 6 dígitos). */
  readonly id: string;
  /** O código em si (16 a 36 caracteres alfanuméricos). Segredo. */
  readonly secret: string;
}

export interface OfflineData {
  /** Dia da emissão (B09), 2 dígitos. */
  readonly issueDay: string;
  /** vNF (W16) com ponto decimal, sem milhar nem sinal. */
  readonly totalAmount: string;
}

/** Versão 2.00, emissão online: chave|2|tpAmb|idCSC|hash. */
export function qrCodeV2Online(input: QrBase & { readonly csc: Csc }): string {
  const params = [checkBase(input), '2', input.environment, checkCsc(input.csc)].join('|');
  return url(input.baseUrl, `${params}|${hashWithCsc(params, input.csc)}`);
}

/** Versão 2.00, contingência off-line: chave|2|tpAmb|dia|vNF|digVal(hex)|idCSC|hash. */
export function qrCodeV2Offline(input: QrBase & OfflineData & { readonly csc: Csc; readonly digestValueBase64: string }): string {
  if (!/^[A-Za-z0-9+/]{27}=$/.test(input.digestValueBase64)) throw new QrCodeError('QR_INVALID_DIGEST');
  const digestHex = digestValueHex(input.digestValueBase64);
  const params = [checkBase(input), '2', input.environment, checkDay(input.issueDay), checkTotal(input.totalAmount), digestHex, checkCsc(input.csc)].join('|');
  return url(input.baseUrl, `${params}|${hashWithCsc(params, input.csc)}`);
}

/** Item 4.3.5, passo 1: o hexadecimal dos caracteres Base64 do DigestValue (não dos bytes do resumo). */
export function digestValueHex(digestValueBase64: string): string {
  return Buffer.from(digestValueBase64, 'utf8').toString('hex');
}

/** Versão 3.00, emissão online: chave|3|tpAmb (sem CSC). */
export function qrCodeV3Online(input: QrBase): string {
  return url(input.baseUrl, [checkBase(input), '3', input.environment].join('|'));
}

export type QrRecipient =
  | { readonly kind: 'CNPJ'; readonly value: string }
  | { readonly kind: 'CPF'; readonly value: string }
  /** Estrangeiro: o tipo é 3 e a identificação fica vazia (manual, tabela 7). */
  | { readonly kind: 'FOREIGN' };

/** Versão 3.00, contingência off-line: chave|3|tpAmb|dia|vNF|tpIdDest|idDest|assinatura RSA-SHA1. */
export function qrCodeV3Offline(input: QrBase & OfflineData & { readonly recipient?: QrRecipient; readonly privateKey: KeyObject }): string {
  const [type, id] = recipientFields(input.recipient);
  const params = [checkBase(input), '3', input.environment, checkDay(input.issueDay), checkTotal(input.totalAmount), type, id].join('|');
  const signature = createSign('RSA-SHA1').update(params, 'utf8').sign(input.privateKey, 'base64');
  return url(input.baseUrl, `${params}|${signature}`);
}

/**
 * Hash da versão 2.00 sobre os parâmetros já unidos por "|" (itens 4.3.4 e 4.3.5). Exportado à
 * parte porque os exemplos do manual usam chaves hipotéticas com DV inválido: o hash é conferido
 * com eles, e a URL só sai com chave válida.
 */
export function hashWithCsc(params: string, csc: Pick<Csc, 'secret'>): string {
  return createHash('sha1').update(params + csc.secret, 'utf8').digest('hex').toUpperCase();
}

function checkBase(input: QrBase): string {
  if (!isValidAccessKey(input.accessKey)) throw new QrCodeError('QR_INVALID_ACCESS_KEY');
  return input.accessKey;
}

/** Devolve o identificador; confere também o CSC (item 4.3.3: alfanumérico, 16 a 36 posições). */
function checkCsc(csc: Csc): string {
  if (!/^[1-9][0-9]{0,5}$/.test(csc.id)) throw new QrCodeError('QR_INVALID_CSC_ID');
  if (!/^[A-Za-z0-9]{16,36}$/.test(csc.secret)) throw new QrCodeError('QR_INVALID_CSC');
  return csc.id;
}

function checkDay(day: string): string {
  if (!/^(0[1-9]|[12][0-9]|3[01])$/.test(day)) throw new QrCodeError('QR_INVALID_DAY');
  return day;
}

function checkTotal(total: string): string {
  if (!/^[0-9]{1,12}\.[0-9]{2}$/.test(total)) throw new QrCodeError('QR_INVALID_TOTAL');
  return total;
}

function recipientFields(recipient: QrRecipient | undefined): [string, string] {
  if (recipient === undefined) return ['', ''];
  if (recipient.kind === 'FOREIGN') return ['3', ''];
  const pattern = recipient.kind === 'CNPJ' ? /^[0-9A-Z]{12}[0-9]{2}$/ : /^[0-9]{11}$/;
  if (!pattern.test(recipient.value)) throw new QrCodeError('QR_INVALID_RECIPIENT');
  return [recipient.kind === 'CNPJ' ? '1' : '2', recipient.value];
}

function url(base: string, params: string): string {
  return `${base}?p=${params}`;
}
