import { cmyk, degrees, PDFDocument, StandardFonts, type Color, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import type { DanfseParty, DanfsePartyBlock, DanfseView } from './danfse-view.js';

/**
 * Desenho do DANFSe v2.0 (NT 008 SE/CGNFS-e v1.02, Anexo I e itens 2.2 a 2.5), em uma única página
 * A4 retrato.
 *
 * Posições e tamanhos (cm, a partir do canto superior esquerdo da folha) são os da tabela do item
 * 2.4.5. A NT os trata como mínimos: os blocos de texto livre ("Descrição do Serviço" e
 * "Informações Complementares") crescem para caber, e os seguintes descem. A área livre até o fim
 * da folha vai para as informações complementares (itens 2.3.1 e 2.3.3: o canhoto é opcional e
 * não é impresso).
 *
 * Fontes (ADR-0057): a NT pede Arial nos títulos e Microsoft Sans Serif no conteúdo, ambas
 * proprietárias. Usamos a Helvetica, fonte-base do PDF, com as mesmas medidas da Arial e sem
 * arquivo embutido. Caractere fora do WinAnsi vira "?".
 *
 * Cores: preto K100 nos textos, cinza claro com 5% de densidade nos sombreados, vermelho M100/Y100
 * em "NFS-e SEM VALIDADE JURÍDICA" e cinza K35 na marca d'água.
 */
const CM = 72 / 2.54;
const PAGE = { width: 21.0, height: 29.7 };
const LEFT = 0.3;
const FULL = 20.4;
const COL = [0.3, 5.41, 10.51, 15.62] as const;
const NARROW = 5.09;
const WIDE = 10.19;
const BOTTOM = 29.4;

const BLACK = cmyk(0, 0, 0, 1);
const SHADE = cmyk(0, 0, 0, 0.05);
const RED = cmyk(0, 1, 1, 0);
const WATERMARK = cmyk(0, 0, 0, 0.35);

const QR_TEXT = 'A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e';

export interface DanfseAssets {
  /** Logomarca oficial da NFS-e (PNG), item 2.4.3. */
  readonly logoPng: Uint8Array;
}

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
}

interface Cell {
  readonly x: number;
  readonly w: number;
  readonly label?: string;
  readonly value?: string;
  readonly shaded?: boolean;
  /** Título de bloco: 7 pt, negrito, caixa alta, sombreado (item 2.4.1). */
  readonly title?: string;
  /** Texto de várias linhas (bloco de texto livre). */
  readonly multiline?: boolean;
}

interface Row {
  readonly cells: readonly Cell[];
  readonly height: number;
  /** Bloco de texto livre: cresce até `maxHeight` para caber o texto. */
  readonly grow?: boolean;
}

export async function renderDanfse(view: DanfseView, assets: DanfseAssets): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`DANFSe ${view.identification.accessKey}`);
  pdf.setProducer('orbita-nfe');
  pdf.setCreator('orbita-nfe');
  const page = pdf.addPage([PAGE.width * CM, PAGE.height * CM]);
  const fonts: Fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const logo = await pdf.embedPng(assets.logoPng);
  const canvas = new Canvas(page, fonts);

  canvas.complementary = { text: view.complementary, approximateTaxes: view.approximateTaxes };
  drawHeader(canvas, view, logo);
  drawIdentification(canvas, view);
  drawQrCode(canvas, view.qrCodeUrl);

  const rows = bodyRows(view);
  layoutRows(canvas, rows, 4.34);

  // Borda da página: 1 ponto (item 2.2.3).
  canvas.box(LEFT, 0.3, FULL, BOTTOM - 0.3, { width: 1 });
  if (view.watermark !== null) canvas.watermark(view.watermark);
  canvas.flush();
  return pdf.save();
}

function drawHeader(canvas: Canvas, view: DanfseView, logo: PDFImage): void {
  canvas.fill(LEFT, 0.3, FULL, 1.16);
  canvas.box(LEFT, 0.3, FULL, 1.16);
  const scale = Math.min(4.0 / (logo.width / CM), 0.85 / (logo.height / CM));
  const w = (logo.width / CM) * scale;
  const h = (logo.height / CM) * scale;
  canvas.image(logo, 0.49, 0.44 + (0.85 - h) / 2, w, h);
  canvas.box(5.41, 0.3, WIDE, 1.16);
  const lines = ['DANFSe v2.0', 'Documento Auxiliar da NFS-e'];
  const startY = view.homologation ? 0.68 : 0.8;
  lines.forEach((line, i) => {
    canvas.textCentered(line, 5.41, WIDE, startY + i * 0.32, 9, 'bold');
  });
  // Item 2.4.3, observação: só na NFS-e de teste (tpAmb = 2), em vermelho, abaixo do título.
  if (view.homologation) canvas.textCentered('NFS-e SEM VALIDADE JURÍDICA', 5.41, WIDE, startY + 0.64, 9, 'bold', RED);
  canvas.box(15.62, 0.3, NARROW, 1.16);
  if (view.header.municipality !== null) canvas.text(view.header.municipality, 15.72, 0.62, 8, 'regular', NARROW - 0.2);
  canvas.text(view.header.generator, 15.72, 1.13, 6, 'regular', NARROW - 0.2);
  canvas.text(view.header.environment, 15.72, 1.38, 6, 'regular', NARROW - 0.2);
}

function drawIdentification(canvas: Canvas, view: DanfseView): void {
  const id = view.identification;
  canvas.box(LEFT, 1.48, FULL, 2.84);
  const cell = (x: number, y: number, w: number, h: number, label: string, value: string, shaded = false): void => {
    if (shaded) canvas.fill(x, y, w, h);
    canvas.box(x, y, w, h);
    // Item 2.4.2: os títulos deste bloco são de 7 pontos, em negrito e caixa alta.
    canvas.text(label, x + 0.1, y + 0.3, 7, 'bold', w - 0.2);
    canvas.text(value, x + 0.1, y + 0.6, 7, 'regular', w - 0.2);
  };
  cell(LEFT, 1.48, 15.3, 0.77, 'CHAVE DE ACESSO DA NFS-E', id.accessKey);
  cell(COL[0], 2.27, NARROW, 0.67, 'NÚMERO DA NFS-E', id.number);
  cell(COL[1], 2.27, NARROW, 0.67, 'COMPETÊNCIA DA NFS-E', id.competence);
  cell(COL[2], 2.27, NARROW, 0.67, 'DATA E HORA DA EMISSÃO DA NFS-E', id.issuedAt);
  cell(COL[0], 2.96, NARROW, 0.67, 'NÚMERO DA DPS', id.dpsNumber);
  cell(COL[1], 2.96, NARROW, 0.67, 'SÉRIE DA DPS', id.dpsSeries);
  cell(COL[2], 2.96, NARROW, 0.67, 'DATA E HORA DA EMISSÃO DA DPS', id.dpsIssuedAt);
  // Item 2.2.3: "Emitente da NFS-e" sombreado.
  cell(COL[0], 3.65, NARROW, 0.67, 'EMITENTE DA NFS-E', id.emitter, true);
  cell(COL[1], 3.65, NARROW, 0.67, 'SITUAÇÃO DA NFS-E', id.status);
  cell(COL[2], 3.65, NARROW, 0.67, 'FINALIDADE', id.purpose);
}

function drawQrCode(canvas: Canvas, url: string): void {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  canvas.qr(qr.modules, 17.48, 1.67, 1.52);
  canvas.paragraph(QR_TEXT, 15.8, 3.36, 4.72, 0.68, 6, 'regular', 3, true);
}

function partyRows(title: string, block: DanfsePartyBlock, withRegistration: boolean): Row[] {
  // Notas 2 e 3: altura mínima de 0,32 cm; 0,40 cm para o texto de 7 pontos não tocar nas linhas.
  if (block.kind === 'MESSAGE') return [{ height: 0.4, cells: [{ x: LEFT, w: FULL, title: block.message }] }];
  const p: DanfseParty = block.party;
  return [
    {
      height: 0.64,
      cells: withRegistration
        ? [{ x: COL[0], w: NARROW, title }, field(COL[1], NARROW, 'CNPJ / CPF / NIF', p.document), field(COL[2], NARROW, 'Indicador Municipal (Inscrição)', p.municipalRegistration), field(COL[3], NARROW, 'Telefone', p.phone)]
        : [{ x: COL[0], w: NARROW, title }, field(COL[1], WIDE, 'CNPJ / CPF / NIF', p.document), field(COL[3], NARROW, 'Telefone', p.phone)],
    },
    { height: 0.64, cells: [field(COL[0], WIDE, 'Nome / Nome Empresarial', p.name), field(COL[2], NARROW, 'Município / Sigla UF', p.municipality), field(COL[3], NARROW, 'Código IBGE / CEP', p.ibgeAndPostalCode)] },
    { height: 0.66, cells: [field(COL[0], WIDE, 'Endereço', p.address), field(COL[2], WIDE, 'E-mail', p.email)] },
  ];
}

function field(x: number, w: number, label: string, value: string, shaded = false): Cell {
  return { x, w, label, value, shaded };
}

/** Linhas do corpo, na ordem do Anexo I. */
function bodyRows(view: DanfseView): Row[] {
  const m = view.municipalTax;
  const f = view.federalTax;
  const i = view.ibsCbs;
  const t = view.totals;
  const s = view.service;
  const rows: Row[] = [
    ...partyRows('PRESTADOR / FORNECEDOR', { kind: 'PARTY', party: view.provider }, true),
    { height: 0.64, cells: [field(COL[0], WIDE, 'Simples Nacional na Data de Competência', view.provider.simplesNacional), field(COL[2], WIDE, 'Regime de Apuração Tributária pelo SN', view.provider.simplesNacionalRegime)] },
    ...partyRows('TOMADOR / ADQUIRENTE', view.taker, true),
    ...partyRows('DESTINATÁRIO DA OPERAÇÃO', view.recipient, false),
    ...partyRows('INTERMEDIÁRIO DA OPERAÇÃO', view.intermediary, true),
    {
      height: 0.65,
      cells: [{ x: COL[0], w: NARROW, title: 'SERVIÇO PRESTADO' }, field(COL[1], NARROW, 'Código de Tributação Nacional / Municipal', s.taxCode), field(COL[2], NARROW, 'Código da NBS', s.nbs), field(COL[3], NARROW, 'Local da Prestação / Sigla UF / País', s.place)],
    },
    // Item 2.4.5: a descrição do código de tributação não tem título.
    { height: 0.4, grow: true, cells: [{ x: LEFT, w: FULL, value: s.taxCodeDescription, multiline: true }] },
    { height: 0.64, grow: true, cells: [{ x: LEFT, w: FULL, label: 'Descrição do Serviço', value: s.description, multiline: true }] },
    {
      height: 0.65,
      cells: [{ x: COL[0], w: NARROW, title: 'TRIBUTAÇÃO MUNICIPAL (ISSQN)' }, field(COL[1], NARROW, 'Tipo de Tributação do ISSQN', m.taxation), field(COL[2], WIDE, 'Município / Sigla UF / País da Incidência do ISSQN', m.incidence)],
    },
  ];
  if (m.showRegimeRow) {
    rows.push({ height: 0.65, cells: [field(COL[0], NARROW, 'Regime Especial de Tributação do ISSQN', m.specialRegime), field(COL[1], NARROW, 'Tipo de Imunidade do ISSQN', m.immunity), field(COL[2], NARROW, 'Suspensão da Exigibilidade do ISSQN', m.suspension), field(COL[3], NARROW, 'Número Processo Suspensão', m.suspensionProcess)] });
  }
  if (m.showBenefitRow) {
    rows.push({ height: 0.64, cells: [field(COL[0], NARROW, 'Benefício Municipal', m.benefit), field(COL[1], NARROW, 'Cálculo do BM', m.benefitCalculation), field(COL[2], NARROW, 'Total Deduções/Reduções', m.deductions), field(COL[3], NARROW, 'Desconto Incondicionado', m.unconditionalDiscount)] });
  }
  rows.push(
    { height: 0.65, cells: [field(COL[0], NARROW, 'BC ISSQN', m.base), field(COL[1], NARROW, 'Alíquota Aplicada', m.rate), field(COL[2], NARROW, 'Retenção do ISSQN', m.retention), field(COL[3], NARROW, 'ISSQN Apurado', m.issqn)] },
    {
      height: 0.65,
      cells: [{ x: COL[0], w: NARROW, title: 'TRIBUTAÇÃO FEDERAL (EXCETO CBS)' }, field(COL[1], NARROW, 'IRRF', f.irrf), field(COL[2], NARROW, 'Contribuição Previdenciária - Retida', f.socialSecurity), field(COL[3], NARROW, 'Contribuições Sociais - Retidas', f.socialContributions)],
    },
  );
  if (f.showPisCofinsRow) {
    rows.push({ height: 0.65, cells: [field(COL[0], NARROW, 'PIS - Débito Apuração Própria', f.pis), field(COL[1], NARROW, 'COFINS - Débito Apuração Própria', f.cofins), field(COL[2], WIDE, 'Descrição Contrib. Sociais - Retidas', f.socialContributionsDescription)] });
  }
  rows.push(
    { height: 0.64, cells: [{ x: COL[0], w: NARROW, title: 'TRIBUTAÇÃO IBS / CBS' }, field(COL[1], NARROW, 'CST / cClassTrib', i.cstClassification), field(COL[2], WIDE, 'Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF', i.operation)] },
    { height: 0.65, cells: [field(COL[0], NARROW, 'Exclusões e Reduções da Base de Cálculo', i.exclusions), field(COL[1], NARROW, 'Base de Cálculo Após Exclusões e Reduções', i.base), field(COL[2], NARROW, 'Red. Alíquota IBS / Red. Alíquota CBS', i.rateReductions), field(COL[3], NARROW, 'Alíquota - IBS UF / IBS Mun', i.ibsRates)] },
    { height: 0.65, cells: [field(COL[0], NARROW, 'Alíq. Efetiva Municipal - IBS', i.municipalEffectiveRate), field(COL[1], NARROW, 'Valor Apurado Municipal - IBS', i.municipalAmount), field(COL[2], NARROW, 'Alíq. Efetiva Estadual - IBS', i.stateEffectiveRate), field(COL[3], NARROW, 'Valor Apurado Estadual - IBS', i.stateAmount)] },
    { height: 0.64, cells: [field(COL[0], NARROW, 'Valor Total Apurado - IBS', i.ibsTotal), field(COL[1], NARROW, 'Alíquota - CBS', i.cbsRate), field(COL[2], NARROW, 'Alíquota Efetiva - CBS', i.cbsEffectiveRate), field(COL[3], NARROW, 'Valor Total Apurado - CBS', i.cbsTotal)] },
    { height: 0.69, cells: [{ x: COL[0], w: NARROW, title: 'VALOR TOTAL DA NFS-E' }, field(COL[1], NARROW, 'Valor da Operação / Serviço', t.serviceAmount), field(COL[2], NARROW, 'Desconto Incondicionado', t.unconditionalDiscount), field(COL[3], NARROW, 'Desconto Condicionado', t.conditionalDiscount)] },
    // Item 2.2.3: "Valor Líquido da NFS-e + IBS/CBS" sombreado.
    { height: 0.68, cells: [field(COL[0], NARROW, 'Total das Retenções (ISSQN / Federais)', t.retentions), field(COL[1], NARROW, 'Valor Líquido da NFS-e', t.netAmount), field(COL[2], NARROW, 'Total do IBS/CBS', t.ibsCbs), field(COL[3], NARROW, 'Valor Líquido da NFS-e + IBS/CBS', t.netPlusIbsCbs, true)] },
    { height: 0.41, cells: [{ x: LEFT, w: FULL, title: 'INFORMAÇÕES COMPLEMENTARES' }] },
  );
  return rows;
}

/**
 * Empilha as linhas a partir de `top`. As de texto livre crescem para caber; as informações
 * complementares ficam com o resto da folha, e a linha dos totais aproximados é fixa (nota 10).
 */
function layoutRows(canvas: Canvas, rows: readonly Row[], top: number): void {
  let y = top;
  const reserve = 1.2; // mínimo para as informações complementares e a linha dos totais aproximados
  for (const row of rows) {
    let height = row.height;
    if (row.grow === true) {
      const needed = Math.max(...row.cells.map((c) => canvas.paragraphHeight(c.value ?? '', c.w, c.label !== undefined)));
      const remaining = BOTTOM - reserve - y - remainingFixedHeight(rows, row);
      height = Math.min(Math.max(height, needed), Math.max(height, remaining));
    }
    drawRow(canvas, row, y, height);
    y += height;
  }
  drawComplementary(canvas, y, BOTTOM - y);
}

function remainingFixedHeight(rows: readonly Row[], current: Row): number {
  const index = rows.indexOf(current);
  return rows.slice(index + 1).reduce((total, r) => total + r.height, 0);
}

function drawRow(canvas: Canvas, row: Row, y: number, height: number): void {
  for (const cell of row.cells) {
    if (cell.title !== undefined) {
      canvas.fill(cell.x, y, cell.w, height);
      canvas.box(cell.x, y, cell.w, height);
      canvas.paragraph(cell.title.toUpperCase(), cell.x + 0.1, y + 0.05, cell.w - 0.2, height - 0.05, 7, 'bold', 2);
      continue;
    }
    if (cell.shaded === true) canvas.fill(cell.x, y, cell.w, height);
    canvas.box(cell.x, y, cell.w, height);
    if (cell.multiline === true) {
      const labelOffset = cell.label === undefined ? 0 : 0.27;
      if (cell.label !== undefined) canvas.text(cell.label, cell.x + 0.1, y + 0.25, 6, 'bold', cell.w - 0.2);
      canvas.paragraph(cell.value ?? '', cell.x + 0.1, y + 0.05 + labelOffset, cell.w - 0.2, height - 0.08 - labelOffset, 7, 'regular');
      continue;
    }
    if (cell.label !== undefined) canvas.text(cell.label, cell.x + 0.1, y + 0.25, 6, 'bold', cell.w - 0.2);
    canvas.text(cell.value ?? '', cell.x + 0.1, y + 0.53, 7, 'regular', cell.w - 0.2);
  }
}

function drawComplementary(canvas: Canvas, y: number, height: number): void {
  canvas.box(LEFT, y, FULL, height);
  const view = canvas.complementary;
  const taxesHeight = 0.35;
  canvas.paragraph(view.text, LEFT + 0.1, y + 0.05, FULL - 0.2, height - taxesHeight - 0.1, 7, 'regular');
  canvas.text(view.approximateTaxes, LEFT + 0.1, y + height - 0.12, 7, 'regular', FULL - 0.2);
}

type Op = () => void;

/** Fila de desenho em camadas: sombreados → marca d'água → linhas → textos (o texto nunca fica coberto). */
class Canvas {
  private readonly fills: Op[] = [];
  private readonly marks: Op[] = [];
  private readonly lines: Op[] = [];
  private readonly texts: Op[] = [];
  private readonly encodable = new Map<string, boolean>();
  complementary = { text: '-', approximateTaxes: '' };

  constructor(
    private readonly page: PDFPage,
    private readonly fonts: Fonts,
  ) {}

  flush(): void {
    for (const op of [...this.fills, ...this.marks, ...this.lines, ...this.texts]) op();
  }

  fill(x: number, y: number, w: number, h: number): void {
    this.fills.push(() => {
      this.page.drawRectangle({ ...rect(x, y, w, h), color: SHADE });
    });
  }

  /** Linhas divisórias de 0,5 ponto (item 2.2.3). */
  box(x: number, y: number, w: number, h: number, options: { width?: number } = {}): void {
    this.lines.push(() => {
      this.page.drawRectangle({ ...rect(x, y, w, h), borderColor: BLACK, borderWidth: options.width ?? 0.5 });
    });
  }

  image(image: PDFImage, x: number, y: number, w: number, h: number): void {
    this.texts.push(() => {
      this.page.drawImage(image, rect(x, y, w, h));
    });
  }

  qr(modules: { size: number; get(row: number, col: number): number | boolean }, x: number, y: number, size: number): void {
    const cell = size / modules.size;
    this.texts.push(() => {
      for (let r = 0; r < modules.size; r++) {
        for (let c = 0; c < modules.size; c++) {
          if (modules.get(r, c)) this.page.drawRectangle({ ...rect(x + c * cell, y + r * cell, cell, cell), color: BLACK });
        }
      }
    });
  }

  /** Uma linha; se não couber na largura, corta e termina com "..." (item 2.1). */
  text(value: string, x: number, baseline: number, size: number, weight: keyof Fonts, maxWidth: number, color: Color = BLACK): void {
    const font = this.fonts[weight];
    const line = this.ellipsize(this.safe(value, font), font, size, maxWidth * CM);
    this.texts.push(() => {
      this.page.drawText(line, { x: x * CM, y: (PAGE.height - baseline) * CM, size, font, color });
    });
  }

  textCentered(value: string, x: number, w: number, baseline: number, size: number, weight: keyof Fonts, color: Color = BLACK): void {
    const font = this.fonts[weight];
    const line = this.ellipsize(this.safe(value, font), font, size, w * CM);
    const width = font.widthOfTextAtSize(line, size) / CM;
    this.text(line, x + (w - width) / 2, baseline, size, weight, w, color);
  }

  /** Texto quebrado em linhas dentro da caixa; o que não couber termina com "...". */
  paragraph(value: string, x: number, top: number, w: number, h: number, size: number, weight: keyof Fonts, maxLines = Number.POSITIVE_INFINITY, center = false): void {
    const font = this.fonts[weight];
    const leading = size * 1.2;
    const fitLines = Math.max(1, Math.min(maxLines, Math.floor((h * CM) / leading)));
    const lines = this.wrap(this.safe(value, font), font, size, w * CM);
    const shown = lines.slice(0, fitLines);
    const last = shown.length - 1;
    if (lines.length > fitLines) shown[last] = this.ellipsize(`${shown[last] ?? ''}...`, font, size, w * CM, true);
    shown.forEach((line, i) => {
      const baseline = top + ((i + 1) * leading) / CM - 0.04;
      if (center) this.textCentered(line, x, w, baseline, size, weight);
      else this.text(line, x, baseline, size, weight, w);
    });
  }

  paragraphHeight(value: string, w: number, withLabel: boolean): number {
    const font = this.fonts.regular;
    const lines = this.wrap(this.safe(value, font), font, 7, (w - 0.2) * CM).length;
    return (lines * 7 * 1.2) / CM + 0.15 + (withLabel ? 0.27 : 0);
  }

  /** Marca d'água na diagonal, Helvetica normal, cinza K35, maior que 50 pontos (itens 2.5.1 e 2.5.2). */
  watermark(text: string): void {
    const font = this.fonts.regular;
    const size = 90;
    const angle = Math.atan2(PAGE.height, PAGE.width);
    const width = font.widthOfTextAtSize(this.safe(text, font), size);
    const cx = (PAGE.width / 2) * CM;
    const cy = (PAGE.height / 2) * CM;
    this.marks.push(() => {
      this.page.drawText(this.safe(text, font), {
        x: cx - (width / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
        y: cy - (width / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
        size,
        font,
        color: WATERMARK,
        rotate: degrees((angle * 180) / Math.PI),
      });
    });
  }

  private wrap(value: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of value.split(/\r?\n/)) {
      let current = '';
      for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
        const candidate = current === '' ? word : `${current} ${word}`;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          current = candidate;
          continue;
        }
        if (current !== '') lines.push(current);
        current = word;
        while (font.widthOfTextAtSize(current, size) > width && current.length > 1) {
          let cut = current.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(current.slice(0, cut), size) > width) cut--;
          lines.push(current.slice(0, cut));
          current = current.slice(cut);
        }
      }
      lines.push(current);
    }
    return lines;
  }

  private ellipsize(value: string, font: PDFFont, size: number, width: number, force = false): string {
    if (!force && font.widthOfTextAtSize(value, size) <= width) return value;
    let base = force ? value.replace(/\.\.\.$/, '') : value;
    while (base.length > 0 && font.widthOfTextAtSize(`${base}...`, size) > width) base = base.slice(0, -1);
    return `${base.trimEnd()}...`;
  }

  /** Só caracteres que a fonte-base consegue codificar (WinAnsi); o resto vira "?". */
  private safe(value: string, font: PDFFont): string {
    let out = '';
    for (const ch of value.replace(/[\t\r]/g, ' ')) {
      if (ch === '\n') {
        out += ch;
        continue;
      }
      let ok = this.encodable.get(ch);
      if (ok === undefined) {
        try {
          font.encodeText(ch);
          ok = true;
        } catch {
          ok = false;
        }
        this.encodable.set(ch, ok);
      }
      out += ok ? ch : '?';
    }
    return out;
  }
}

/** Retângulo em cm (topo-esquerda da folha) → pontos do PDF (origem embaixo à esquerda). */
function rect(x: number, y: number, w: number, h: number): { x: number; y: number; width: number; height: number } {
  return { x: x * CM, y: (PAGE.height - y - h) * CM, width: w * CM, height: h * CM };
}

