import type { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { SIGNATURE_PROFILES, signEnveloped } from '../../../../shared/infrastructure/xml/xml-signer.js';
import type { CancellationPreparer, IssuerCredential, PreparationResult, ServiceInvoice, ServiceInvoiceCancellation } from '../../application/ports.js';
import { pedRegEventoId } from '../../domain/cancellation.js';
import { issuerFromDpsId, tpAmbOf } from '../../domain/dps.js';
import { attr, el, group, NFSE_NS } from '../dps/dps-xml.js';
import { formatDhEmi, schemaEnvironmentOf } from '../dps/xml-dps-preparer.js';

const DOCUMENT = 'nfse-nacional';
const ROOT_SCHEMA = 'pedRegEvento_v1.01.xsd';

export interface CancellationXmlInput {
  readonly tpAmb: '1' | '2';
  readonly verAplic: string;
  readonly dhEvento: string;
  readonly authorCnpj: string;
  readonly accessKey: string;
  readonly reasonCode: string;
  readonly reasonText: string;
}

/**
 * Pedido de registro do evento de cancelamento (TCPedRegEvt / TCInfPedReg / TE101101), na ordem
 * do XSD `tiposEventos_v1.01.xsd`, idêntico nos dois pacotes. `xDesc` é a única enumeração do
 * tipo. Texto do cliente (`xMotivo`) é sempre escapado.
 */
export function buildCancellationXml(input: CancellationXmlInput): string {
  const id = pedRegEventoId(input.accessKey);
  if (!id.ok) throw new Error(id.error);
  const inf =
    el('tpAmb', input.tpAmb) +
    el('verAplic', input.verAplic) +
    el('dhEvento', input.dhEvento) +
    el('CNPJAutor', input.authorCnpj) +
    el('chNFSe', input.accessKey) +
    group('e101101', el('xDesc', 'Cancelamento de NFS-e') + el('cMotivo', input.reasonCode) + el('xMotivo', input.reasonText));
  return `<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="${NFSE_NS}" versao="1.01"><infPedReg Id="${attr(id.value)}">${inf}</infPedReg></pedRegEvento>`;
}

/**
 * Preparador do cancelamento (worker-fiscal): monta, assina `infPedReg` com o perfil
 * `nfse-nacional-dps` (provisório, R-31) e valida no XSD do ambiente. Falha aqui é local.
 */
export class XmlCancellationPreparer implements CancellationPreparer {
  constructor(
    private readonly catalog: FiscalSchemaCatalog,
    private readonly verAplic: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepare(cancellation: ServiceInvoiceCancellation, invoice: ServiceInvoice, credential: IssuerCredential): Promise<PreparationResult> {
    const issuer = issuerFromDpsId(invoice.dpsId);
    if (issuer === undefined) return { ok: false, code: 'DPS_ID_UNSUPPORTED' };
    if (invoice.nfseAccessKey === null || !/^[0-9A-Z]{50}$/.test(invoice.nfseAccessKey)) return { ok: false, code: 'ACCESS_KEY_INVALID' };
    const layoutPackage = this.catalog.forEnvironment(DOCUMENT, schemaEnvironmentOf(invoice.environment)).id;
    const xml = buildCancellationXml({
      tpAmb: tpAmbOf(invoice.environment),
      verAplic: this.verAplic,
      dhEvento: formatDhEmi(this.now()),
      authorCnpj: issuer.cnpj,
      accessKey: invoice.nfseAccessKey,
      reasonCode: cancellation.reasonCode,
      reasonText: cancellation.reasonText,
    });
    const signed = signEnveloped({
      xml,
      elementLocalName: 'infPedReg',
      privateKey: credential.privateKey,
      certificatePem: credential.certificatePem,
      profile: SIGNATURE_PROFILES.nfseNacionalDps,
    });
    const result = await this.catalog.validate(layoutPackage, ROOT_SCHEMA, signed);
    // O XSD do pacote decide o formato da chave e do Id (os dois pacotes divergem; ADR-0035 item 6).
    if (!result.valid) return { ok: false, code: 'EVENT_SCHEMA_INVALID' };
    return { ok: true, signedXml: signed, layoutPackage };
  }
}
