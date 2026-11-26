import type { NfceAuthorizerGateway, NfceLookup, NfceSubmission } from '../../application/ports.js';
import { NFE_NS } from './sefaz-soap.js';

/**
 * SIMULADOR do autorizador da NFC-e (ADR-0072). Não fala com nenhum órgão: guarda em memória as
 * notas "recebidas" por chave e responde conforme o modo programado. Serve para testes e
 * desenvolvimento; a configuração o recusa em produção.
 *
 * O protocolo devolvido é FICTÍCIO: `nProt` começa com 9 (não existe na numeração oficial, item 4.3.5
 * do MOC começa com 1 = SEFAZ ou 2 = RFB) e `verAplic` diz SIMULADOR.
 */
export type NfceSubmitMode =
  /** Recebe e autoriza (100). */
  | 'AUTHORIZE'
  /** Recebe e denega (301: irregularidade fiscal do emitente). A nota fica gravada. */
  | 'DENY'
  /** Recebe e rejeita com o código programado; nada fica gravado. */
  | 'REJECT'
  /** Nada sai (falha na conexão). */
  | 'NOT_SENT'
  /** Recebe, autoriza e o cliente fica sem resposta. */
  | 'PROCESS_THEN_DROP'
  /** Nada chega, mas o cliente fica sem resposta. */
  | 'DROP_BEFORE_PROCESSING';

export type NfceLookupMode = 'TRUTHFUL' | 'NOT_YET_VISIBLE' | 'ERROR';

interface Stored {
  readonly kind: 'AUTHORIZED' | 'DENIED';
  readonly digestValue: string;
  readonly statusCode: string;
  readonly protocolNumber: string;
  readonly at: Date;
}

export class SimulatedNfceAuthorizer implements NfceAuthorizerGateway {
  private readonly stored = new Map<string, Stored>();
  private submitModes: NfceSubmitMode[] = [];
  private lookupModes: NfceLookupMode[] = [];
  private rejection = { code: '999', message: 'Rejeicao simulada' };
  private protocolSeq = 0;
  /** Quantas vezes cada chave chegou ao "autorizador" (prova de não duplicidade). */
  readonly received = new Map<string, number>();
  /** Quantas notas diferentes (XML) chegaram por número: tentativas com XML novo contam aqui. */
  readonly payloads: string[] = [];
  submits = 0;
  lookups = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  onSubmit(...modes: NfceSubmitMode[]): this {
    this.submitModes.push(...modes);
    return this;
  }

  onLookup(...modes: NfceLookupMode[]): this {
    this.lookupModes.push(...modes);
    return this;
  }

  rejectWith(code: string, message: string): this {
    this.rejection = { code, message };
    return this;
  }

  submit(signedXml: string, expected: { readonly accessKey: string; readonly digestValue: string }): Promise<NfceSubmission> {
    this.submits++;
    const mode = this.submitModes.shift() ?? 'AUTHORIZE';
    if (mode === 'NOT_SENT') return Promise.resolve({ kind: 'NOT_SENT', errorCode: 'ECONNREFUSED' });
    if (mode === 'DROP_BEFORE_PROCESSING') return Promise.resolve({ kind: 'UNKNOWN', errorCode: 'ETIMEDOUT' });

    this.received.set(expected.accessKey, (this.received.get(expected.accessKey) ?? 0) + 1);
    this.payloads.push(signedXml);
    // Duplicidade (204): a mesma chave já está gravada.
    if (this.stored.has(expected.accessKey)) return Promise.resolve({ kind: 'ALREADY_EXISTS', code: '204' });
    if (mode === 'REJECT') return Promise.resolve({ kind: 'REJECTED', ...this.rejection });

    const stored = this.store(expected, mode === 'DENY' ? 'DENIED' : 'AUTHORIZED');
    if (mode === 'PROCESS_THEN_DROP') return Promise.resolve({ kind: 'UNKNOWN', errorCode: 'ECONNRESET' });
    return Promise.resolve(stored.kind === 'DENIED' ? { kind: 'DENIED', statusCode: stored.statusCode, protocolNumber: stored.protocolNumber } : this.authorized(expected.accessKey, stored));
  }

  lookup(expected: { readonly accessKey: string; readonly digestValue: string }): Promise<NfceLookup> {
    this.lookups++;
    const mode = this.lookupModes.shift() ?? 'TRUTHFUL';
    if (mode === 'ERROR') return Promise.resolve({ kind: 'ERROR', errorCode: 'LOOKUP_SIMULATED_ERROR' });
    const stored = this.stored.get(expected.accessKey);
    if (stored === undefined || mode === 'NOT_YET_VISIBLE') return Promise.resolve({ kind: 'NOT_FOUND' });
    // Gravada com outro digest: não é a nota desta tentativa (ADR-0070).
    if (stored.digestValue !== expected.digestValue) return Promise.resolve({ kind: 'ERROR', errorCode: 'DIGEST_DIFERENTE' });
    return Promise.resolve(stored.kind === 'DENIED' ? { kind: 'DENIED', statusCode: stored.statusCode, protocolNumber: stored.protocolNumber } : this.authorized(expected.accessKey, stored));
  }

  private store(expected: { readonly accessKey: string; readonly digestValue: string }, kind: Stored['kind']): Stored {
    this.protocolSeq++;
    const stored: Stored = {
      kind,
      digestValue: expected.digestValue,
      statusCode: kind === 'DENIED' ? '301' : '100',
      protocolNumber: `9${String(this.protocolSeq).padStart(14, '0')}`,
      at: this.now(),
    };
    this.stored.set(expected.accessKey, stored);
    return stored;
  }

  private authorized(accessKey: string, stored: Stored): NfceSubmission & { kind: 'AUTHORIZED' } {
    const protocolXml =
      `<protNFe xmlns="${NFE_NS}" versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SIMULADOR</verAplic><chNFe>${accessKey}</chNFe>` +
      `<dhRecbto>${stored.at.toISOString().replace(/\.\d{3}Z$/, '-00:00')}</dhRecbto><nProt>${stored.protocolNumber}</nProt><digVal>${stored.digestValue}</digVal>` +
      `<cStat>${stored.statusCode}</cStat><xMotivo>Autorizado o uso da NF-e (SIMULADOR)</xMotivo></infProt></protNFe>`;
    return { kind: 'AUTHORIZED', statusCode: stored.statusCode, protocolNumber: stored.protocolNumber, authorizedAt: stored.at, protocolXml };
  }
}
