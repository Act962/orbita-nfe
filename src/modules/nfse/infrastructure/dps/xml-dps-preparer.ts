import type { FiscalSchemaCatalog, SchemaEnvironment } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { SIGNATURE_PROFILES, signEnveloped } from '../../../../shared/infrastructure/xml/xml-signer.js';
import type { DpsPreparer, DpsValidator, FiscalEnvironment, IssuerCredential, PreparationResult, ServiceInvoice } from '../../application/ports.js';
import { issuerFromDpsId, tpAmbOf, type DpsData } from '../../domain/dps.js';
import { buildDpsXml, LayoutNotSupportedError } from './dps-xml.js';

const DOCUMENT = 'nfse-nacional';
const ROOT_SCHEMA = 'DPS_v1.01.xsd';

/** Produção → pacote de produção; homologação → pacote da produção restrita (ADR-0013). */
export function schemaEnvironmentOf(environment: FiscalEnvironment): SchemaEnvironment {
  return environment === 'PRODUCTION' ? 'production' : 'production-restricted';
}

/**
 * dhEmi em horário de Brasília (UTC−03:00), no formato TSDateTimeUTC.
 * PROVISÓRIO (ADR-0033): o XSD aceita qualquer fuso de −11 a +12; o fuso esperado pela SEFIN
 * para emitentes fora de UTC−03:00 será confirmado na produção restrita.
 */
export function formatDhEmi(at: Date): string {
  return `${new Date(at.getTime() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`;
}

/**
 * Preparador real da DPS (worker-fiscal): monta o XML do contrato v1, assina com o perfil
 * `nfse-nacional-dps` (ADR-0014) e valida o documento assinado no XSD oficial do ambiente (L4).
 * Qualquer falha aqui é local: nada foi transmitido.
 */
export class XmlDpsPreparer implements DpsPreparer {
  constructor(
    private readonly catalog: FiscalSchemaCatalog,
    private readonly verAplic: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepare(invoice: ServiceInvoice, credential: IssuerCredential): Promise<PreparationResult> {
    const issuer = issuerFromDpsId(invoice.dpsId);
    if (issuer === undefined) return { ok: false, code: 'DPS_ID_UNSUPPORTED' };
    const layoutPackage = this.catalog.forEnvironment(DOCUMENT, schemaEnvironmentOf(invoice.environment)).id;
    let xml: string;
    try {
      xml = buildDpsXml({
        layoutPackage,
        dpsId: invoice.dpsId,
        tpAmb: tpAmbOf(invoice.environment),
        dhEmi: formatDhEmi(this.now()),
        verAplic: this.verAplic,
        series: invoice.series,
        number: invoice.number,
        issuerMunicipalityCode: issuer.municipalityCode,
        issuerCnpj: issuer.cnpj,
        dps: invoice.payload as unknown as DpsData,
      });
    } catch (error) {
      if (error instanceof LayoutNotSupportedError) return { ok: false, code: 'LAYOUT_NOT_SUPPORTED' };
      throw error;
    }
    const signed = signEnveloped({
      xml,
      elementLocalName: 'infDPS',
      privateKey: credential.privateKey,
      certificatePem: credential.certificatePem,
      profile: SIGNATURE_PROFILES.nfseNacionalDps,
    });
    const result = await this.catalog.validate(layoutPackage, ROOT_SCHEMA, signed);
    // As mensagens da libxml2 podem citar dados do documento: o resultado leva só o código.
    if (!result.valid) return { ok: false, code: 'DPS_SCHEMA_INVALID' };
    return { ok: true, signedXml: signed, layoutPackage };
  }
}

/** Valores provisórios só para a pré-validação estrutural no aceite (o número real vem depois). */
const PLACEHOLDER = { dpsId: `DPS0000000200000000000191${'0'.repeat(19)}1`, series: '1', number: 1, cnpj: '00000000000191', municipality: '0000000' };

/**
 * Pré-validação no aceite (API): monta o XML com identificadores provisórios e valida no XSD do
 * ambiente, sem assinatura (opcional no XSD). Pega erro de estrutura com 422 antes de numerar.
 * A validação que vale é a do worker, com os valores reais e o documento assinado.
 */
export class XmlDpsValidator implements DpsValidator {
  constructor(private readonly catalog: FiscalSchemaCatalog) {}

  async validate(environment: FiscalEnvironment, dps: DpsData): Promise<readonly string[]> {
    const layoutPackage = this.catalog.forEnvironment(DOCUMENT, schemaEnvironmentOf(environment)).id;
    const xml = buildDpsXml({
      layoutPackage,
      dpsId: PLACEHOLDER.dpsId,
      tpAmb: tpAmbOf(environment),
      dhEmi: formatDhEmi(new Date()),
      verAplic: 'pre-validacao',
      series: PLACEHOLDER.series,
      number: PLACEHOLDER.number,
      issuerMunicipalityCode: PLACEHOLDER.municipality,
      issuerCnpj: PLACEHOLDER.cnpj,
      dps,
    });
    const result = await this.catalog.validate(layoutPackage, ROOT_SCHEMA, xml);
    return result.valid ? [] : result.errors.map((e) => e.message);
  }
}
