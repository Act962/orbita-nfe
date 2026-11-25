import type { DanfseRenderer } from '../../application/ports.js';
import { verifiedResource, type MunicipalityTable } from '../reference/municipality-table.js';
import { renderDanfse, type DanfseAssets } from './danfse-pdf.js';
import { buildDanfseView, type MunicipalityLookup } from './danfse-view.js';
import { NfseDocumentError, readNfseDocument } from './nfse-document.js';

/** DANFSe em PDF a partir do XML autorizado (ADR-0057). */
export class PdfDanfseRenderer implements DanfseRenderer {
  constructor(
    private readonly assets: DanfseAssets,
    private readonly municipalities: MunicipalityLookup,
  ) {}

  async render(input: { nfseXml: string; accessKey: string; situation: 'AUTHORIZED' | 'CANCELLED' | 'SUBSTITUTED' }) {
    let document;
    try {
      document = readNfseDocument(input.nfseXml);
    } catch (error) {
      if (error instanceof NfseDocumentError) return { ok: false as const, code: error.code };
      throw error;
    }
    const view = buildDanfseView({ document, accessKey: input.accessKey, situation: input.situation, municipalities: this.municipalities });
    return { ok: true as const, pdf: await renderDanfse(view, this.assets) };
  }
}

/**
 * Carrega a logomarca oficial da NFS-e (hash conferido no MANIFEST) e usa a tabela de municípios
 * já carregada. Arquivo alterado ou fora do MANIFEST impede a subida.
 */
export function loadDanfseRenderer(danfseDir: string, municipalities: MunicipalityTable): PdfDanfseRenderer {
  const logoPng = verifiedResource(danfseDir, 'logo-nfse-horizontal.png');
  return new PdfDanfseRenderer({ logoPng }, (code) => municipalities.lookup(code));
}
