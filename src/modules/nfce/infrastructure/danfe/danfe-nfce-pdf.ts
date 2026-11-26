import { PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';
import type { DanfeNfceView } from './danfe-nfce-view.js';

/**
 * Desenho do DANFE NFC-e (ADR-0076), modelo com o QR Code centralizado (Figura 1B / Figura 5 do
 * manual v6.0), em bobina de 80 mm com a altura do conteúdo.
 *
 * O manual não fixa fonte nem largura de papel; fixa o conteúdo e a ordem das divisões, os textos
 * obrigatórios e o QR Code com no mínimo 25 mm x 25 mm (22 mm de conteúdo + 3 mm de margem segura).
 * Usamos 30 mm de conteúdo com margem de 10% (manual 3.1.5, dimensões acima de 25 mm).
 */
const MM = 72 / 25.4;
const WIDTH = 80 * MM;
const MARGIN = 3 * MM;
const CONTENT = WIDTH - 2 * MARGIN;
const QR_SIZE = 30 * MM;
const QR_QUIET = QR_SIZE * 0.1;
const SIZE = { body: 7, small: 6.5, title: 7.5 } as const;
const LEADING = 1.25;
const BLACK = rgb(0, 0, 0);

type Align = 'left' | 'center' | 'right';
type Op = (page: ReturnType<PDFDocument['addPage']>, top: number) => void;

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
}

/** Layout em duas passadas: mede a altura, cria a página e desenha. */
class Receipt {
  private y = MARGIN;
  private readonly ops: Op[] = [];

  constructor(private readonly fonts: Fonts) {}

  get height(): number {
    return this.y + MARGIN;
  }

  text(value: string, opts: { size?: number; bold?: boolean; align?: Align } = {}): void {
    const size = opts.size ?? SIZE.body;
    const font = opts.bold === true ? this.fonts.bold : this.fonts.regular;
    for (const line of this.wrap(safe(value, font), font, size, CONTENT)) this.line(line, font, size, opts.align ?? 'left');
  }

  /** Uma linha com texto à esquerda e valor à direita (totais). */
  pair(label: string, value: string, opts: { bold?: boolean } = {}): void {
    const font = opts.bold === true ? this.fonts.bold : this.fonts.regular;
    const size = SIZE.body;
    const left = safe(label, font);
    const right = safe(value, font);
    const y = this.y;
    this.ops.push((page, top) => {
      page.drawText(left, { x: MARGIN, y: top - y - size, size, font, color: BLACK });
      page.drawText(right, { x: WIDTH - MARGIN - font.widthOfTextAtSize(right, size), y: top - y - size, size, font, color: BLACK });
    });
    this.y += size * LEADING;
  }

  rule(): void {
    const y = this.y + 2;
    this.ops.push((page, top) => {
      page.drawLine({ start: { x: MARGIN, y: top - y }, end: { x: WIDTH - MARGIN, y: top - y }, thickness: 0.4, color: BLACK, dashArray: [2, 1.5] });
    });
    this.y += 5;
  }

  gap(points = 3): void {
    this.y += points;
  }

  qr(content: string): void {
    const qr = QRCode.create(content, { errorCorrectionLevel: 'M' });
    const cell = (QR_SIZE - 2 * QR_QUIET) / qr.modules.size;
    const x0 = (WIDTH - QR_SIZE) / 2 + QR_QUIET;
    const y0 = this.y + QR_QUIET;
    this.ops.push((page, top) => {
      for (let r = 0; r < qr.modules.size; r++) {
        for (let c = 0; c < qr.modules.size; c++) {
          if (qr.modules.get(r, c)) page.drawRectangle({ x: x0 + c * cell, y: top - (y0 + (r + 1) * cell), width: cell, height: cell, color: BLACK });
        }
      }
    });
    this.y += QR_SIZE;
  }

  render(page: ReturnType<PDFDocument['addPage']>): void {
    const top = page.getHeight();
    for (const op of this.ops) op(page, top);
  }

  private line(value: string, font: PDFFont, size: number, align: Align): void {
    const y = this.y;
    const width = font.widthOfTextAtSize(value, size);
    const x = align === 'center' ? (WIDTH - width) / 2 : align === 'right' ? WIDTH - MARGIN - width : MARGIN;
    this.ops.push((page, top) => {
      page.drawText(value, { x, y: top - y - size, size, font, color: BLACK });
    });
    this.y += size * LEADING;
  }

  private wrap(value: string, font: PDFFont, size: number, max: number): string[] {
    const lines: string[] = [];
    let current = '';
    for (const word of value.split(/\s+/).filter((w) => w !== '')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= max) {
        current = candidate;
        continue;
      }
      if (current !== '') lines.push(current);
      // Palavra maior que a linha (URL, chave): quebra por caractere.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > max) {
        let cut = rest.length;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > max) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      current = rest;
    }
    if (current !== '') lines.push(current);
    return lines.length === 0 ? [''] : lines;
  }
}

/** Caracteres fora do WinAnsi (fontes padrão do PDF) viram "?": nunca derruba a geração. */
function safe(value: string, font: PDFFont): string {
  let out = '';
  for (const char of value) {
    try {
      font.encodeText(char);
      out += char;
    } catch {
      out += '?';
    }
  }
  return out;
}

export async function renderDanfeNfce(view: DanfeNfceView): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`DANFE NFC-e ${view.consultation.accessKey.replace(/ /g, '')}`);
  pdf.setProducer('orbita-nfe');
  const fonts: Fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const r = new Receipt(fonts);

  // Divisão I: cabeçalho.
  r.text(view.issuer.document, { align: 'center' });
  r.text(view.issuer.name, { align: 'center', bold: true });
  r.text(view.issuer.address, { align: 'center', size: SIZE.small });
  r.text('Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica', { align: 'center', bold: true });
  r.rule();

  // Divisão II: detalhe dos produtos (mínimo do manual 3.1.2).
  r.text('Código  Descrição  Qtde  Un  Valor unit.  Valor total', { size: SIZE.small, bold: true });
  for (const item of view.items) {
    r.text(`${item.code} ${item.description}`, { size: SIZE.small });
    r.text(`${item.quantity} ${item.unit} x ${item.unitPrice}   ${item.total}`, { size: SIZE.small, align: 'right' });
  }
  r.rule();

  // Divisão III: totais (manual 3.1.3).
  r.pair('Qtde. total de itens', String(view.totals.itemCount));
  r.pair('Valor total R$', view.totals.products);
  if (view.totals.additions !== null) r.pair('Acréscimos (frete, seguro e outras despesas) R$', view.totals.additions);
  if (view.totals.discount !== null) r.pair('Desconto R$', view.totals.discount);
  if (view.totals.amountDue !== null) r.pair('Valor a Pagar R$', view.totals.amountDue, { bold: true });
  r.pair('FORMA PAGAMENTO', 'VALOR PAGO R$', { bold: true });
  for (const p of view.totals.payments) r.pair(p.method, p.amount);
  if (view.totals.change !== null) r.pair('Troco R$', view.totals.change);
  r.rule();

  // Divisão IV: consulta pela chave.
  r.text('Consulte pela Chave de Acesso em', { align: 'center', bold: true, size: SIZE.small });
  r.text(view.consultation.url, { align: 'center', size: SIZE.small });
  r.text(view.consultation.accessKey, { align: 'center', size: SIZE.small });
  r.rule();

  // Divisão VI (antes do QR Code no modelo centralizado), VII e V.
  for (const line of view.consumer) r.text(line, { align: 'center', bold: line.startsWith('CONSUMIDOR') });
  r.gap();
  r.text(`NFC-e nº ${view.identification.number} Série ${view.identification.series} ${view.identification.issuedAt}`, { align: 'center', bold: true });
  if (view.identification.protocol !== null) {
    r.text('Protocolo de autorização:', { align: 'center', size: SIZE.small, bold: true });
    r.text(view.identification.protocol, { align: 'center', size: SIZE.small });
  }
  r.gap(2);
  r.qr(view.qrCode);

  // Divisão VIII: mensagens fiscais (homologação obrigatória, centralizada e em caixa alta).
  if (view.fiscalMessages.length > 0) {
    r.rule();
    for (const message of view.fiscalMessages) r.text(message, { align: 'center', bold: true, size: SIZE.title });
  }

  // Divisão IX: mensagens do contribuinte.
  if (view.taxpayerMessages.length > 0) {
    r.rule();
    for (const message of view.taxpayerMessages) r.text(message, { size: SIZE.small });
  }

  r.render(pdf.addPage([WIDTH, r.height]));
  return pdf.save();
}
