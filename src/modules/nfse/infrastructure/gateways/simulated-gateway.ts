import { createHash } from 'node:crypto';
import type { EventLookupOutcome, EventOutcome, LookupOutcome, NfseGateway, SubmissionOutcome } from '../../application/ports.js';

/**
 * SIMULADOR do autorizador da NFS-e (ADR-0032 item 8). Não fala com nenhum órgão: guarda em
 * memória as DPS "recebidas" e responde conforme o modo programado. Serve para testes e
 * desenvolvimento; a configuração recusa o simulador em produção.
 *
 * A chave de acesso e os XML devolvidos são FICTÍCIOS e não seguem o leiaute oficial. A chave tem
 * 50 dígitos e passa nos padrões dos dois pacotes (TSChaveNFSe e, na produção restrita,
 * TSIdPedRegEvt, que exige 1 ou 2 na 9ª posição), mas começa com "0000000", que não é código IBGE
 * de município: nunca se confunde com uma chave real.
 *
 * Substituição (ADR-0036): uma DPS com `chSubstda` só é autorizada se a chave for de uma nota
 * autorizada aqui (senão E0044), ainda não cancelada nem substituída (senão E0046, Anexo I v1.01).
 * Ao autorizar, o simulador registra sozinho o e105102 na original, como a SEFIN.
 */
export type SubmitMode =
  /** Recebe e autoriza. */
  | 'AUTHORIZE'
  /** Recebe e rejeita com o código programado. */
  | 'REJECT'
  /** Nada sai (falha na conexão). */
  | 'NOT_SENT'
  /** Recebe, autoriza e "derruba a conexão": o cliente fica sem resposta. */
  | 'PROCESS_THEN_DROP'
  /** Não recebe nada, mas o cliente fica sem resposta (timeout antes de chegar). */
  | 'DROP_BEFORE_PROCESSING';

export type LookupMode =
  /** Responde conforme o que foi recebido. */
  | 'TRUTHFUL'
  /** Diz "não encontrado" mesmo tendo recebido (consistência eventual). */
  | 'NOT_YET_VISIBLE'
  | 'ERROR';

/** Respostas programáveis do registro de evento (mesmos casos do envio). */
export type EventMode = 'REGISTER' | 'REJECT' | 'NOT_SENT' | 'PROCESS_THEN_DROP' | 'DROP_BEFORE_PROCESSING';

export class SimulatedNfseGateway implements NfseGateway {
  private readonly events = new Map<string, string>();
  private eventModes: EventMode[] = [];
  private eventLookupModes: LookupMode[] = [];
  /** Quantas vezes cada evento (chave:tipo) chegou ao "autorizador". */
  readonly eventsReceived = new Map<string, number>();
  readonly eventPayloadHashes = new Map<string, string[]>();
  eventSubmits = 0;
  eventLookups = 0;
  private readonly authorized = new Map<string, { accessKey: string; nfseXml: string }>();
  private submitModes: SubmitMode[] = [];
  private lookupModes: LookupMode[] = [];
  private rejection = { code: 'E9999', message: 'Rejeição simulada.' };
  /** Quantas vezes cada DPS chegou ao "autorizador" (prova de não duplicidade). */
  readonly received = new Map<string, number>();
  /** Bytes de cada recepção, para provar que a retransmissão é byte a byte a mesma. */
  readonly payloadHashes = new Map<string, string[]>();
  submits = 0;
  lookups = 0;

  /** Programa as próximas respostas de envio (uma por chamada; depois, AUTHORIZE). */
  onSubmit(...modes: SubmitMode[]): this {
    this.submitModes.push(...modes);
    return this;
  }

  /** Programa as próximas respostas de consulta (uma por chamada; depois, TRUTHFUL). */
  onLookup(...modes: LookupMode[]): this {
    this.lookupModes.push(...modes);
    return this;
  }

  onEvent(...modes: EventMode[]): this {
    this.eventModes.push(...modes);
    return this;
  }

  onEventLookup(...modes: LookupMode[]): this {
    this.eventLookupModes.push(...modes);
    return this;
  }

  registerEvent(accessKey: string, signedEvent: string): Promise<EventOutcome> {
    this.eventSubmits++;
    const mode = this.eventModes.shift() ?? 'REGISTER';
    if (mode === 'NOT_SENT') return Promise.resolve({ kind: 'NOT_SENT', errorCode: 'ECONNREFUSED' });
    if (mode === 'DROP_BEFORE_PROCESSING') return Promise.resolve({ kind: 'UNKNOWN', errorCode: 'UND_ERR_HEADERS_TIMEOUT' });
    const type = /<e(\d{6})>/.exec(signedEvent)?.[1] ?? 'desconhecido';
    const key = `${accessKey}:${type}`;
    this.eventsReceived.set(key, (this.eventsReceived.get(key) ?? 0) + 1);
    this.eventPayloadHashes.set(key, [...(this.eventPayloadHashes.get(key) ?? []), createHash('sha256').update(signedEvent).digest('hex')]);
    if (this.events.has(key)) return Promise.resolve({ kind: 'ALREADY_EXISTS' });
    if (mode === 'REJECT') return Promise.resolve({ kind: 'REJECTED', ...this.rejection });
    const eventXml = `<EventoSimulado chave="${accessKey}" tipo="${type}"/>`;
    this.events.set(key, eventXml);
    if (mode === 'PROCESS_THEN_DROP') return Promise.resolve({ kind: 'UNKNOWN', errorCode: 'ECONNRESET' });
    return Promise.resolve({ kind: 'REGISTERED', eventXml });
  }

  /** Cada tipo de evento tem um só registro no simulador: o número sequencial é 1. */
  findEvent(accessKey: string, eventType: string, sequence = 1): Promise<EventLookupOutcome> {
    if (sequence !== 1) return Promise.resolve({ kind: 'NOT_FOUND' });
    this.eventLookups++;
    const mode = this.eventLookupModes.shift() ?? 'TRUTHFUL';
    if (mode === 'ERROR') return Promise.resolve({ kind: 'ERROR', errorCode: 'UND_ERR_CONNECT_TIMEOUT' });
    const found = this.events.get(`${accessKey}:${eventType}`);
    if (mode === 'NOT_YET_VISIBLE' || found === undefined) return Promise.resolve({ kind: 'NOT_FOUND' });
    return Promise.resolve({ kind: 'FOUND', eventXml: found });
  }

  rejectWith(code: string, message: string): this {
    this.rejection = { code, message };
    return this;
  }

  submit(signedDps: string): Promise<SubmissionOutcome> {
    this.submits++;
    const mode = this.submitModes.shift() ?? 'AUTHORIZE';
    if (mode === 'NOT_SENT') return Promise.resolve({ kind: 'NOT_SENT', errorCode: 'ECONNREFUSED' });
    if (mode === 'DROP_BEFORE_PROCESSING') return Promise.resolve({ kind: 'UNKNOWN', errorCode: 'UND_ERR_HEADERS_TIMEOUT' });

    const dpsId = dpsIdOf(signedDps);
    this.received.set(dpsId, (this.received.get(dpsId) ?? 0) + 1);
    this.payloadHashes.set(dpsId, [...(this.payloadHashes.get(dpsId) ?? []), createHash('sha256').update(signedDps).digest('hex')]);

    if (this.authorized.has(dpsId)) return Promise.resolve({ kind: 'ALREADY_EXISTS' });
    if (mode === 'REJECT') return Promise.resolve({ kind: 'REJECTED', ...this.rejection });
    const substituted = /<chSubstda>([0-9A-Z]{50})<\/chSubstda>/.exec(signedDps)?.[1];
    if (substituted !== undefined) {
      if (![...this.authorized.values()].some((a) => a.accessKey === substituted)) {
        return Promise.resolve({ kind: 'REJECTED', code: 'E0044', message: 'NFS-e não existe na base de dados do autorizador (simulado).' });
      }
      if (this.events.has(`${substituted}:101101`) || this.events.has(`${substituted}:105102`)) {
        return Promise.resolve({ kind: 'REJECTED', code: 'E0046', message: 'NFS-e cancelada não pode ser substituída (simulado).' });
      }
    }
    const authorization = this.authorize(dpsId);
    if (substituted !== undefined) {
      this.events.set(`${substituted}:105102`, `<EventoSimulado chave="${substituted}" tipo="105102" substituta="${authorization.accessKey}"/>`);
    }
    if (mode === 'PROCESS_THEN_DROP') return Promise.resolve({ kind: 'UNKNOWN', errorCode: 'ECONNRESET' });
    return Promise.resolve({ kind: 'AUTHORIZED', ...authorization });
  }

  findByDpsId(dpsId: string): Promise<LookupOutcome> {
    this.lookups++;
    const mode = this.lookupModes.shift() ?? 'TRUTHFUL';
    if (mode === 'ERROR') return Promise.resolve({ kind: 'ERROR', errorCode: 'UND_ERR_CONNECT_TIMEOUT' });
    const found = this.authorized.get(dpsId);
    if (mode === 'NOT_YET_VISIBLE' || found === undefined) return Promise.resolve({ kind: 'NOT_FOUND' });
    return Promise.resolve({ kind: 'FOUND', ...found });
  }

  private authorize(dpsId: string): { accessKey: string; nfseXml: string } {
    const digits = BigInt(`0x${createHash('sha256').update(dpsId).digest('hex')}`).toString().padStart(41, '0').slice(0, 41);
    const accessKey = `000000022${digits}`;
    const authorization = { accessKey, nfseXml: `<NFSeSimulada dps="${dpsId}" chave="${accessKey}"/>` };
    this.authorized.set(dpsId, authorization);
    return authorization;
  }
}

function dpsIdOf(signedDps: string): string {
  const match = /<infDPS[^>]*\sId="(DPS[0-9A-Z]{42})"/.exec(signedDps);
  if (match?.[1] === undefined) throw new Error('DPS sem Id no simulador');
  return match[1];
}
