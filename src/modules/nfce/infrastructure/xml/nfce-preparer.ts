import type { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { SIGNATURE_PROFILES, signEnveloped } from '../../../../shared/infrastructure/xml/xml-signer.js';
import type { ConsumerInvoice, FiscalEnvironment, NfceCredential, NfceEmitter, NfcePreparation, NfcePreparer } from '../../application/ports.js';
import { buildAccessKey } from '../../domain/access-key.js';
import { AUTHORIZATION_SCHEMA_PACKAGE } from '../sefaz/authorization.js';
import { NFE_NS } from '../sefaz/sefaz-soap.js';
import { buildNfceXml, finishNfceXml } from './nfce-xml.js';

/**
 * QR Code e URL de consulta da NFC-e (`infNFeSupl`). A versão do QR Code (2.00 com CSC ou 3.00) é
 * decisão do responsável (ADR-0066) e a `urlChave` do PI ainda está a confirmar: por isso entram como
 * configuração, nunca escritas aqui.
 */
export interface NfceSupplementSource {
  qrCode(input: { readonly accessKey: string; readonly environment: '1' | '2' }): string;
  readonly consultationUrl: string;
}

/**
 * Fuso do `dhEmi` por UF. Só o Piauí, -03:00 (sem horário de verão), está confirmado para este
 * projeto; outra UF falha antes de qualquer envio, em vez de presumir o fuso.
 */
const UF_OFFSET_MINUTES: Readonly<Record<string, number>> = { PI: -180 };

/** Monta, assina e valida a NFC-e de UMA tentativa (ADR-0072): dhEmi = `issuedAt`. */
export class XmlNfcePreparer implements NfcePreparer {
  constructor(
    private readonly catalog: FiscalSchemaCatalog,
    private readonly supplement: NfceSupplementSource,
    /** verProc: versão do motor. */
    private readonly appVersion: string,
  ) {}

  async prepare(invoice: ConsumerInvoice, emitter: NfceEmitter, credential: NfceCredential, issuedAt: Date): Promise<NfcePreparation> {
    const offset = UF_OFFSET_MINUTES[emitter.address.uf];
    if (offset === undefined) return { ok: false, code: 'NFCE_TIMEZONE_NOT_SUPPORTED' };
    if (emitter.taxRegime !== '1') return { ok: false, code: 'NFCE_REGIME_NOT_SUPPORTED' };
    // xNome e xFant (TString, 2 a 60 e 1 a 60): a razão social do cadastro pode ser maior; não se corta dado fiscal.
    if (emitter.legalName.length < 2 || emitter.legalName.length > 60) return { ok: false, code: 'NFCE_ISSUER_NAME_LENGTH' };

    const local = localDateTime(issuedAt, offset);
    const cUF = emitter.address.municipalityCode.slice(0, 2);
    const key = buildAccessKey({
      cUF,
      yearMonth: local.yearMonth,
      cnpj: emitter.cnpj,
      model: '65',
      series: Number(invoice.series),
      number: invoice.number,
      emissionType: '1',
      numericCode: invoice.numericCode,
    });
    if (!key.ok) return { ok: false, code: key.error };

    const tpAmb = environmentCode(invoice.environment);
    const unsigned = buildNfceXml({
      accessKey: key.value,
      cUF,
      numericCode: invoice.numericCode,
      series: Number(invoice.series),
      number: invoice.number,
      issuedAt: local.dateTime,
      tpAmb,
      appVersion: this.appVersion,
      issuer: {
        cnpj: emitter.cnpj,
        name: emitter.legalName,
        tradeName: emitter.tradeName.length >= 1 && emitter.tradeName.length <= 60 ? emitter.tradeName : undefined,
        address: {
          street: emitter.address.street,
          number: emitter.address.number,
          complement: emitter.address.complement ?? undefined,
          district: emitter.address.district,
          municipalityCode: emitter.address.municipalityCode,
          municipalityName: emitter.address.municipalityName,
          uf: emitter.address.uf,
          postalCode: emitter.address.postalCode,
          phone: emitter.address.phone ?? undefined,
        },
        stateRegistration: emitter.stateRegistration,
        taxRegime: '1',
      },
      sale: invoice.sale,
    });

    let signed: string;
    try {
      signed = signEnveloped({ xml: unsigned, elementLocalName: 'infNFe', privateKey: credential.privateKey, certificatePem: credential.certificatePem, profile: SIGNATURE_PROFILES.nfe400 });
    } catch {
      return { ok: false, code: 'NFCE_SIGNATURE_FAILED' };
    }
    const xml = finishNfceXml(signed, { qrCode: this.supplement.qrCode({ accessKey: key.value.value, environment: tpAmb }), consultationUrl: this.supplement.consultationUrl });

    const valid = await this.catalog.validate(AUTHORIZATION_SCHEMA_PACKAGE, 'nfe_v4.00.xsd', xml);
    if (!valid.valid) return { ok: false, code: 'NFCE_XML_SCHEMA_INVALID' };
    const digestValue = /<DigestValue>([^<]+)<\/DigestValue>/.exec(xml)?.[1];
    if (digestValue === undefined) return { ok: false, code: 'NFCE_SIGNATURE_WITHOUT_DIGEST' };
    return { ok: true, signedXml: xml, accessKey: key.value.value, digestValue };
  }
}

/** `nfeProc` (TNfeProc: NFe + protNFe), o XML que se guarda da nota autorizada. */
export function buildNfeProc(signedXml: string, protocolXml: string): string {
  const nfe = signedXml.replace(/^<\?xml[^>]*\?>\s*/, '');
  return `<nfeProc xmlns="${NFE_NS}" versao="4.00">${nfe}${protocolXml}</nfeProc>`;
}

const environmentCode = (environment: FiscalEnvironment): '1' | '2' => (environment === 'PRODUCTION' ? '1' : '2');

/** Data e hora locais no formato TDateTimeUTC (AAAA-MM-DDThh:mm:ss±hh:mm) e o AAMM da chave. */
export function localDateTime(at: Date, offsetMinutes: number): { readonly dateTime: string; readonly yearMonth: string } {
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = local.getUTCFullYear();
  const month = pad(local.getUTCMonth() + 1);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const dateTime = `${String(year)}-${month}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { dateTime, yearMonth: `${String(year).slice(2)}${month}` };
}
