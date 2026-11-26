import type { NfceDanfeRenderer } from '../../application/ports.js';
import { renderDanfeNfce } from './danfe-nfce-pdf.js';
import { DanfeNfceError, danfeNfceView } from './danfe-nfce-view.js';

/** DANFE NFC-e a partir do `nfeProc` autorizado (ADR-0076): leitura do XML e desenho do PDF. */
export class PdfDanfeNfceRenderer implements NfceDanfeRenderer {
  async render(nfeProcXml: string): Promise<{ readonly ok: true; readonly pdf: Uint8Array } | { readonly ok: false; readonly code: string }> {
    try {
      return { ok: true, pdf: await renderDanfeNfce(danfeNfceView(nfeProcXml)) };
    } catch (error) {
      if (error instanceof DanfeNfceError) return { ok: false, code: error.code };
      throw error;
    }
  }
}
