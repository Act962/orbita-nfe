import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DanfseRenderer } from '../../application/ports.js';
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

export class DanfseResourceError extends Error {
  constructor(readonly code: 'DANFSE_RESOURCE_INVALID' | 'DANFSE_RESOURCE_HASH_MISMATCH', readonly file: string) {
    super(`${code}: ${file}`);
    this.name = 'DanfseResourceError';
  }
}

const manifestSchema = z.object({ files: z.record(z.string(), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })) });

const municipalityTableSchema = z.object({
  version: z.string().regex(/^ibge-municipios\/\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().positive(),
  municipalities: z.record(z.string().regex(/^\d{7}$/), z.tuple([z.string().min(1), z.string().regex(/^[A-Z]{2}$/)])),
});

/** Arquivo listado no MANIFEST.json da pasta, com o SHA-256 conferido (como os XSD, ADR-0013). */
function verifiedFile(dir: string, file: string): Buffer {
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')));
  } catch {
    throw new DanfseResourceError('DANFSE_RESOURCE_INVALID', join(dir, 'MANIFEST.json'));
  }
  const expected = manifest.files[file]?.sha256;
  const bytes = readFileSync(join(dir, file));
  if (expected === undefined || createHash('sha256').update(bytes).digest('hex') !== expected) throw new DanfseResourceError('DANFSE_RESOURCE_HASH_MISMATCH', join(dir, file));
  return bytes;
}

/**
 * Carrega a logomarca oficial da NFS-e e a tabela de municípios do IBGE, com os hashes conferidos.
 * Arquivo alterado ou fora do MANIFEST impede a subida.
 */
export function loadDanfseRenderer(paths: { readonly danfseDir: string; readonly ibgeDir: string; readonly municipalityFile: string }): PdfDanfseRenderer {
  const logoPng = verifiedFile(paths.danfseDir, 'logo-nfse-horizontal.png');
  const parsed = municipalityTableSchema.safeParse(JSON.parse(verifiedFile(paths.ibgeDir, paths.municipalityFile).toString('utf8')));
  if (!parsed.success || Object.keys(parsed.data.municipalities).length !== parsed.data.count) throw new DanfseResourceError('DANFSE_RESOURCE_INVALID', paths.municipalityFile);
  const table = parsed.data.municipalities;
  return new PdfDanfseRenderer({ logoPng }, (code) => {
    const found = table[code];
    return found === undefined ? undefined : { name: found[0], uf: found[1] };
  });
}
