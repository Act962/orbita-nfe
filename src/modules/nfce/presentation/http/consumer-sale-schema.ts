import { z } from 'zod';
import type { ConsumerSale } from '../../domain/consumer-sale.js';

/**
 * Contrato HTTP v1 da venda para NFC-e (ADR-0069). Confere a forma de cada campo pelos padrões e
 * tamanhos do XSD do PL_010h; as regras fiscais ficam em `checkConsumerSale` (domínio).
 * Campos fora do contrato são recusados (`strict`).
 */
// Padrões dos tipos do XSD (tiposBasico_v4.00.xsd do PL_010h).
const MONEY = /^(0|0\.[0-9]{2}|[1-9][0-9]{0,12}(\.[0-9]{2})?)$/; // TDec_1302
const QUANTITY = /^(0|0\.[0-9]{1,4}|[1-9][0-9]{0,10}(\.[0-9]{1,4})?)$/; // TDec_1104v
const UNIT_PRICE = /^(0|0\.[0-9]{1,10}|[1-9][0-9]{0,10}(\.[0-9]{1,10})?)$/; // TDec_1110v
const RATE = /^(0|0\.[0-9]{2,4}|[1-9][0-9]{0,2}(\.[0-9]{2,4})?)$/; // TDec_0302a04
const QUANTITY_BASE = /^(0|0\.[0-9]{1,4}|[1-9][0-9]{0,11}(\.[0-9]{1,4})?)$/; // TDec_1204v
/** TString: sem espaço nas pontas e só caracteres imprimíveis. */
const TSTRING = /^[!-ÿ](?:[ -ÿ]*[!-ÿ])?$/;

const money = z.string().regex(MONEY, 'valor com até 13 inteiros e exatamente 2 decimais (ex.: "10.50")');
const text = (min: number, max: number) => z.string().min(min).max(max).regex(TSTRING, 'texto sem espaços nas pontas e sem caracteres de controle');

const icmsSn102 = z.object({
  /** Grupo ICMSSN102 do leiaute: CSOSN 102, 103, 300 ou 400. */
  csosn: z.enum(['102', '103', '300', '400']),
  origin: z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8']),
});

const icmsSn500 = z.object({
  /** Grupo ICMSSN500: ICMS cobrado anteriormente por ST ou antecipação. */
  csosn: z.literal('500'),
  origin: z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8']),
  /** vBCSTRet, pST, vICMSSubstituto (opcional) e vICMSSTRet. Sequência opcional do XSD. */
  stRetained: z
    .object({ base: money, consumerRate: z.string().regex(RATE), substituteOwnIcms: money.optional(), amount: money })
    .strict()
    .optional(),
  /** vBCFCPSTRet, pFCPSTRet e vFCPSTRet. */
  fcpStRetained: z.object({ base: money, rate: z.string().regex(RATE), amount: money }).strict().optional(),
  /** pRedBCEfet, vBCEfet, pICMSEfet e vICMSEfet. */
  effective: z.object({ baseReductionRate: z.string().regex(RATE), base: money, rate: z.string().regex(RATE), amount: money }).strict().optional(),
});

/** PIS e COFINS têm os mesmos quatro grupos no leiaute; o grupo sai do CST informado. */
const contribution = z.discriminatedUnion('group', [
  z.object({ group: z.literal('RATE'), cst: z.enum(['01', '02']), base: money, rate: z.string().regex(RATE), amount: money }).strict(),
  z.object({ group: z.literal('QUANTITY'), cst: z.literal('03'), quantityBase: z.string().regex(QUANTITY_BASE), ratePerUnit: z.string().regex(QUANTITY), amount: money }).strict(),
  z.object({ group: z.literal('NOT_TAXED'), cst: z.enum(['04', '05', '06', '07', '08', '09']) }).strict(),
  z
    .object({
      group: z.literal('OTHER'),
      cst: z.enum(['49', '50', '51', '52', '53', '54', '55', '56', '60', '61', '62', '63', '64', '65', '66', '67', '70', '71', '72', '73', '74', '75', '98', '99']),
      base: money.optional(),
      rate: z.string().regex(RATE).optional(),
      quantityBase: z.string().regex(QUANTITY_BASE).optional(),
      ratePerUnit: z.string().regex(QUANTITY).optional(),
      amount: money,
    })
    .strict(),
]);

const gtin = z.string().regex(/^([0-9]{8}|[0-9]{12,14})$/, 'GTIN com 8, 12, 13 ou 14 dígitos');

const item = z
  .object({
    code: text(1, 60),
    /** null = produto sem GTIN ("SEM GTIN" no XML). */
    gtin: gtin.nullable(),
    description: text(1, 120),
    ncm: z.string().regex(/^([0-9]{2}|[0-9]{8})$/),
    cest: z.string().regex(/^[0-9]{7}$/).optional(),
    cfop: z.string().regex(/^[1235-7][0-9]{3}$/),
    unit: text(1, 6),
    quantity: z.string().regex(QUANTITY),
    unitPrice: z.string().regex(UNIT_PRICE),
    /** vProd: informado pelo cliente e conferido contra quantidade × preço (regra I11-10). */
    amount: money,
    discount: money.optional(),
    otherCharges: money.optional(),
    /** Unidade tributável. Ausente = a mesma da comercial (quantidade, preço e GTIN). */
    taxable: z.object({ unit: text(1, 6), quantity: z.string().regex(QUANTITY), unitPrice: z.string().regex(UNIT_PRICE), gtin: gtin.nullable() }).strict().optional(),
    icms: z.union([icmsSn102.strict(), icmsSn500.strict()]),
    pis: contribution.optional(),
    cofins: contribution.optional(),
    /** vTotTrib: valor aproximado dos tributos do item, informado pelo cliente. */
    approximateTaxes: money.optional(),
    additionalInfo: text(1, 500).optional(),
  })
  .strict();

const payment = z
  .object({
    /** tPag: código de dois dígitos da tabela oficial. */
    method: z.string().regex(/^[0-9]{2}$/),
    description: text(2, 60).optional(),
    amount: money,
    card: z
      .object({
        integration: z.enum(['1', '2']),
        acquirerCnpj: z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/).optional(),
        brand: z.string().regex(/^[0-9]{2}$/).optional(),
        authorization: text(1, 128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const consumer = z
  .object({
    document: z.union([
      z.object({ cpf: z.string().regex(/^[0-9]{11}$/) }).strict(),
      z.object({ cnpj: z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/) }).strict(),
      z.object({ foreignId: z.string().regex(/^[!-ÿ]{5,20}$/) }).strict(),
    ]),
    name: text(2, 60).optional(),
    email: text(1, 60).optional(),
  })
  .strict();

export const consumerSaleSchema = z
  .object({
    externalReference: text(1, 100).optional(),
    operationNature: text(1, 60),
    /** indPres: 1 presencial; 5 presencial fora do estabelecimento. O 4 (entrega) fica fora da v1. */
    presence: z.enum(['IN_PERSON', 'IN_PERSON_OFF_PREMISES']),
    consumer: consumer.optional(),
    items: z.array(item).min(1).max(990),
    payments: z.array(payment).min(1).max(100),
    additionalInfo: text(1, 5000).optional(),
  })
  .strict();



/** Garante, na compilação, que o contrato produz exatamente o tipo do domínio. */
export const consumerSaleContract: z.ZodType<ConsumerSale> = consumerSaleSchema;
