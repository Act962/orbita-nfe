import { createHash } from 'node:crypto';
import type { LookupOutcome, NfseGateway, SubmissionOutcome } from '../../application/ports.js';

/**
 * SIMULADOR do autorizador da NFS-e (ADR-0032 item 8). Não fala com nenhum órgão: guarda em
 * memória as DPS "recebidas" e responde conforme o modo programado. Serve para testes e
 * desenvolvimento; a configuração recusa o simulador em produção.
 *
 * A chave de acesso e o XML devolvidos são FICTÍCIOS (marcados como simulação) e não seguem o
 * leiaute oficial da NFS-e.
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

export class SimulatedNfseGateway implements NfseGateway {
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
    const authorization = this.authorize(dpsId);
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
    const accessKey = `SIM${createHash('sha256').update(dpsId).digest('hex').slice(0, 47).toUpperCase()}`;
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
