import { createHash } from 'node:crypto';
import { InternalError } from '../../../shared/application/errors.js';
import type { StoredXml } from './ports.js';

/** XML pronto para download (ADR-0050): os bytes e o SHA-256 conferido. */
export interface XmlDownload {
  /** O XML como gravado; o hash é dos bytes UTF-8. */
  readonly xml: string;
  readonly sha256: string;
  /** Nome sugerido do arquivo (Content-Disposition). */
  readonly fileName: string;
}

/**
 * Confere os bytes do banco contra o hash gravado junto com eles (ADR-0048, ADR-0049) antes de
 * entregá-los. Se não baterem, nada sai: é sinal de alteração indevida, para investigar pelo log.
 * Linha anterior às migrations do hash (só em desenvolvimento) sai com o hash calculado agora.
 */
export function verifiedXml(stored: StoredXml & { readonly xml: string }, fileName: string): XmlDownload {
  const sha256 = createHash('sha256').update(stored.xml, 'utf8').digest('hex');
  if (stored.sha256 !== null && stored.sha256 !== sha256) throw new InternalError('NFSE_XML_HASH_MISMATCH');
  return { xml: stored.xml, sha256, fileName };
}
