import { BusinessRuleError, NotFoundError } from '../../../shared/application/errors.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import type { DanfseRenderer, FiscalEnvironment, NfseApiRepositories } from './ports.js';
import { verifiedXml } from './stored-xml.js';

export interface DanfseDownload {
  readonly pdf: Uint8Array;
  readonly fileName: string;
}

/**
 * DANFSe da nota (ADR-0057): gerado na hora a partir do XML autorizado gravado, com o hash
 * conferido antes. Nada é guardado: o documento fiscal é o XML, e o DANFSe é só a representação
 * impressa (NT 008 v1.02, item 2). A mesma visibilidade do `GET` da nota.
 */
export class DanfseService {
  constructor(
    private readonly uow: UnitOfWork<NfseApiRepositories>,
    private readonly renderer: DanfseRenderer,
  ) {}

  async danfse(companyId: string, clientApplicationId: string, environment: FiscalEnvironment, id: string): Promise<DanfseDownload> {
    const { xml, accessKey, situation } = await this.uow.inCompany(companyId, async (r) => {
      const invoice = await r.invoices.findById(id);
      if (invoice?.clientApplicationId !== clientApplicationId || invoice.environment !== environment) {
        throw new NotFoundError('SERVICE_INVOICE_NOT_FOUND', 'NFS-e não encontrada.');
      }
      const stored = await r.invoices.storedXml(id);
      if (stored?.xml == null || invoice.nfseAccessKey === null) {
        throw new NotFoundError('NFSE_XML_NOT_AVAILABLE', `A NFS-e não tem XML autorizado (a nota está em ${invoice.status}).`);
      }
      const verified = verifiedXml({ xml: stored.xml, sha256: stored.sha256 }, `nfse-${invoice.nfseAccessKey}.xml`);
      const current: 'AUTHORIZED' | 'CANCELLED' | 'SUBSTITUTED' = invoice.status === 'CANCELLED' || invoice.status === 'SUBSTITUTED' ? invoice.status : 'AUTHORIZED';
      return { xml: verified.xml, accessKey: invoice.nfseAccessKey, situation: current };
    });
    const rendered = await this.renderer.render({ nfseXml: xml, accessKey, situation });
    if (!rendered.ok) {
      throw new BusinessRuleError('DANFSE_NOT_AVAILABLE', 'O XML autorizado desta nota não tem o grupo infNFSe; o DANFSe não pode ser gerado. O XML continua disponível.');
    }
    return { pdf: rendered.pdf, fileName: `danfse-${accessKey}.pdf` };
  }
}
