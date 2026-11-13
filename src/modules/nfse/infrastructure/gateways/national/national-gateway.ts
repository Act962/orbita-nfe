import { gunzipSync, gzipSync } from 'node:zlib';
import { createMtlsAgent, sendOnce, type TransportLimits, type TransportOutcome, type TransportRequest } from '../../../../../shared/infrastructure/transport/mtls-transport.js';
import type { EventLookupOutcome, EventOutcome, FiscalEnvironment, GatewayContext, LookupOutcome, NfseGateway, SubmissionOutcome } from '../../../application/ports.js';

/**
 * Cliente do padrão nacional da NFS-e (ADR-0029, ADR-0038): JSON + XML gzip/Base64 com mTLS.
 *
 * Fonte dos caminhos, envelopes e respostas: Swagger 2.0 "API NFS-e - Sefin Nacional" da produção
 * restrita, lido com o A1 em 2026-11-13 e guardado com hash em
 * `resources/fiscal/sefin-docs/producao-restrita/2026-11-13/docs-v1.json`.
 *
 * Regras do resultado (ADR-0029 item 2), em ordem:
 * - nada saiu (fase connect provada pelo transporte) → NOT_SENT;
 * - qualquer outra falha de transporte, 5xx, status fora do documentado ou corpo ilegível → UNKNOWN;
 * - rejeição só com código `Exxxx` do autorizador; duplicidade (E0014 na DPS; E0802 e E0840 no
 *   evento) → ALREADY_EXISTS, que leva à consulta e nunca a "não emitida".
 *
 * Nada do certificado, do XML ou da resposta vai para log: o resultado leva só códigos.
 */
export interface NationalEndpointProfile {
  readonly id: string;
  /** URL base por ambiente (com o `basePath`). Ambiente sem URL não é atendido: nada sai. */
  readonly baseUrls: Partial<Readonly<Record<FiscalEnvironment, string>>>;
  /** ACs confiáveis para o certificado do SERVIDOR. Ausente = repositório padrão do Node. */
  readonly serverTrustPem?: string;
}

/**
 * Perfil da SEFIN Nacional. Só a produção restrita (homologação) está configurada: o Swagger de
 * produção não foi lido e a regra do projeto é não emitir em produção sem habilitação explícita.
 */
export const SEFIN_NACIONAL: NationalEndpointProfile = {
  id: 'sefin-nacional',
  baseUrls: { HOMOLOGATION: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional' },
};

export const DEFAULT_NATIONAL_LIMITS: TransportLimits & { readonly maxXmlBytes: number } = {
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 60_000,
  bodyTimeoutMs: 30_000,
  maxResponseBytes: 5 * 1024 * 1024,
  maxXmlBytes: 10 * 1024 * 1024,
};

/** Códigos de rejeição que significam "o autorizador já tem isto" (fontes no ADR-0038). */
const DPS_ALREADY_EXISTS = new Set(['E0014']);
const EVENT_ALREADY_EXISTS = new Set(['E0802', 'E0840']);

const ACCESS_KEY = /^[0-9A-Z]{50}$/;
const DPS_ID = /^DPS[0-9A-Z]{42}$/;
const REJECTION_CODE = /^E[0-9]{4}$/;
const MESSAGE_MAX = 2000;

interface AuthorizerMessage {
  readonly codigo?: unknown;
  readonly descricao?: unknown;
  readonly complemento?: unknown;
}

/**
 * Diagnóstico das respostas brutas, só para a ferramenta de teste (`npm run sefin:test`), que grava
 * em `.local/` (fora do git). O worker não usa: resposta do autorizador nunca vai para log.
 */
export type NationalResponseSink = (response: { readonly method: string; readonly path: string; readonly status: number; readonly body: string }) => void;

export class NationalNfseGateway implements NfseGateway {
  constructor(
    private readonly profile: NationalEndpointProfile,
    private readonly limits: typeof DEFAULT_NATIONAL_LIMITS = DEFAULT_NATIONAL_LIMITS,
    private readonly diagnostics?: NationalResponseSink,
  ) {}

  async submit(signedDps: string, context: GatewayContext): Promise<SubmissionOutcome> {
    const base = this.profile.baseUrls[context.environment];
    if (base === undefined) return { kind: 'NOT_SENT', errorCode: 'NFSE_ENVIRONMENT_NOT_CONFIGURED' };
    const sentId = /<infDPS[^>]*\sId="(DPS[0-9A-Z]{42})"/.exec(signedDps)?.[1];
    const outcome = await this.send(context, { method: 'POST', url: `${base}/nfse`, body: JSON.stringify({ dpsXmlGZipB64: pack(signedDps) }) });
    if (outcome.kind !== 'RESPONSE') return outcome.kind === 'NOT_SENT' ? { kind: 'NOT_SENT', errorCode: outcome.errorCode } : { kind: 'UNKNOWN', errorCode: outcome.errorCode };

    const json = parseJson(outcome.body);
    if (outcome.status === 201) {
      const accessKey = stringField(json, 'chaveAcesso');
      const nfseXml = this.unpack(stringField(json, 'nfseXmlGZipB64'));
      const idDps = stringField(json, 'idDps');
      // Autorizada, mas sem o que provar: a consulta resolve (nunca "não emitida").
      if (accessKey === undefined || !ACCESS_KEY.test(accessKey) || nfseXml === undefined) return { kind: 'UNKNOWN', errorCode: 'RESPONSE_UNREADABLE' };
      if (sentId !== undefined && idDps !== undefined && idDps !== sentId) return { kind: 'UNKNOWN', errorCode: 'RESPONSE_DPS_MISMATCH' };
      return { kind: 'AUTHORIZED', accessKey, nfseXml };
    }
    if (outcome.status === 400 || outcome.status === 403) {
      const messages = authorizerMessages(json);
      if (messages.some((m) => DPS_ALREADY_EXISTS.has(m.code))) return { kind: 'ALREADY_EXISTS' };
      const first = messages[0];
      if (first !== undefined) return { kind: 'REJECTED', code: first.code, message: describe(messages) };
    }
    return { kind: 'UNKNOWN', errorCode: `HTTP_${outcome.status}` };
  }

  async findByDpsId(dpsId: string, context: GatewayContext): Promise<LookupOutcome> {
    const base = this.profile.baseUrls[context.environment];
    if (base === undefined) return { kind: 'ERROR', errorCode: 'NFSE_ENVIRONMENT_NOT_CONFIGURED' };
    if (!DPS_ID.test(dpsId)) return { kind: 'ERROR', errorCode: 'DPS_ID_INVALID' };
    const dps = await this.send(context, { method: 'GET', url: `${base}/dps/${dpsId}` });
    if (dps.kind !== 'RESPONSE') return { kind: 'ERROR', errorCode: dps.errorCode };
    if (dps.status === 404) return { kind: 'NOT_FOUND' };
    const accessKey = dps.status === 200 ? stringField(parseJson(dps.body), 'chaveAcesso') : undefined;
    if (accessKey === undefined || !ACCESS_KEY.test(accessKey)) return { kind: 'ERROR', errorCode: dps.status === 200 ? 'RESPONSE_UNREADABLE' : `HTTP_${dps.status}` };

    const nfse = await this.send(context, { method: 'GET', url: `${base}/nfse/${accessKey}` });
    if (nfse.kind !== 'RESPONSE') return { kind: 'ERROR', errorCode: nfse.errorCode };
    const nfseXml = nfse.status === 200 ? this.unpack(stringField(parseJson(nfse.body), 'nfseXmlGZipB64')) : undefined;
    // A DPS existe, mas o XML não veio: erro de consulta (tenta de novo), nunca NOT_FOUND.
    if (nfseXml === undefined) return { kind: 'ERROR', errorCode: nfse.status === 200 ? 'RESPONSE_UNREADABLE' : `HTTP_${nfse.status}` };
    return { kind: 'FOUND', accessKey, nfseXml };
  }

  async registerEvent(accessKey: string, signedEvent: string, context: GatewayContext): Promise<EventOutcome> {
    const base = this.profile.baseUrls[context.environment];
    if (base === undefined) return { kind: 'NOT_SENT', errorCode: 'NFSE_ENVIRONMENT_NOT_CONFIGURED' };
    if (!ACCESS_KEY.test(accessKey)) return { kind: 'NOT_SENT', errorCode: 'ACCESS_KEY_INVALID' };
    const outcome = await this.send(context, {
      method: 'POST',
      url: `${base}/nfse/${accessKey}/eventos`,
      body: JSON.stringify({ pedidoRegistroEventoXmlGZipB64: pack(signedEvent) }),
    });
    if (outcome.kind !== 'RESPONSE') return outcome.kind === 'NOT_SENT' ? { kind: 'NOT_SENT', errorCode: outcome.errorCode } : { kind: 'UNKNOWN', errorCode: outcome.errorCode };

    const json = parseJson(outcome.body);
    if (outcome.status === 201) {
      const eventXml = this.unpack(stringField(json, 'eventoXmlGZipB64'));
      return eventXml === undefined ? { kind: 'UNKNOWN', errorCode: 'RESPONSE_UNREADABLE' } : { kind: 'REGISTERED', eventXml };
    }
    if (outcome.status === 400) {
      const messages = authorizerMessages(json);
      if (messages.some((m) => EVENT_ALREADY_EXISTS.has(m.code))) return { kind: 'ALREADY_EXISTS' };
      const first = messages[0];
      if (first !== undefined) return { kind: 'REJECTED', code: first.code, message: describe(messages) };
    }
    return { kind: 'UNKNOWN', errorCode: `HTTP_${outcome.status}` };
  }

  async findEvent(accessKey: string, eventType: string, sequence: number, context: GatewayContext): Promise<EventLookupOutcome> {
    const base = this.profile.baseUrls[context.environment];
    if (base === undefined) return { kind: 'ERROR', errorCode: 'NFSE_ENVIRONMENT_NOT_CONFIGURED' };
    if (!ACCESS_KEY.test(accessKey) || !/^[0-9]{6}$/.test(eventType) || !Number.isInteger(sequence) || sequence < 1) {
      return { kind: 'ERROR', errorCode: 'EVENT_QUERY_INVALID' };
    }
    const outcome = await this.send(context, { method: 'GET', url: `${base}/nfse/${accessKey}/eventos/${eventType}/${sequence}` });
    if (outcome.kind !== 'RESPONSE') return { kind: 'ERROR', errorCode: outcome.errorCode };
    if (outcome.status === 404) return { kind: 'NOT_FOUND' };
    const eventXml = outcome.status === 200 ? this.unpack(stringField(parseJson(outcome.body), 'eventoXmlGZipB64')) : undefined;
    if (eventXml === undefined) return { kind: 'ERROR', errorCode: outcome.status === 200 ? 'RESPONSE_UNREADABLE' : `HTTP_${outcome.status}` };
    return { kind: 'FOUND', eventXml };
  }

  /** Um agente por chamada: a chave do certificado não fica em pool entre empresas. */
  private async send(context: GatewayContext, request: TransportRequest): Promise<TransportOutcome> {
    const agent = createMtlsAgent(
      {
        privateKey: context.credential.privateKey,
        certificatePem: context.credential.certificatePem,
        ...(this.profile.serverTrustPem === undefined ? {} : { serverTrustPem: this.profile.serverTrustPem }),
      },
      this.limits,
    );
    try {
      const outcome = await sendOnce(agent, { ...request, headers: { accept: 'application/json', ...(request.body === undefined ? {} : { 'content-type': 'application/json' }) } }, this.limits);
      if (outcome.kind === 'RESPONSE' && this.diagnostics !== undefined) {
        this.diagnostics({ method: request.method, path: new URL(request.url).pathname, status: outcome.status, body: outcome.body });
      }
      return outcome;
    } finally {
      await agent.close().catch(() => undefined);
    }
  }

  /** gzip + Base64 → XML. `undefined` se ausente, inválido ou grande demais. */
  private unpack(value: string | undefined): string | undefined {
    if (value === undefined || value.length === 0) return undefined;
    try {
      const xml = gunzipSync(Buffer.from(value, 'base64'), { maxOutputLength: this.limits.maxXmlBytes }).toString('utf8');
      return xml.trimStart().startsWith('<') ? xml : undefined;
    } catch {
      return undefined;
    }
  }
}

/** XML → gzip + Base64 (regras E1225/E1226; Swagger: "GZip com representação base64binary"). */
export function pack(xml: string): string {
  return gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function stringField(json: unknown, name: string): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const value = (json as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Mensagens com código `Exxxx`. A emissão usa `erros: [...]`; os eventos e as consultas usam
 * `erro: {...}` (Swagger). Aceita as duas formas.
 *
 * Observado na produção restrita em 2026-11-13 (SefinNacional_1.6.0): o 400 do `POST /nfse` traz
 * `erros[].Codigo`/`Descricao`, com inicial maiúscula, embora o Swagger documente `codigo`; o 404
 * do `GET /dps` traz `erro.codigo`, em minúsculas. Por isso as chaves são lidas sem distinguir caixa.
 */
function authorizerMessages(json: unknown): { code: string; text: string }[] {
  const record = lowerKeys(json);
  if (record === undefined) return [];
  const list: unknown[] = Array.isArray(record.erros) ? record.erros : record.erro === undefined ? [] : [record.erro];
  return list
    .map((m) => lowerKeys(m) as AuthorizerMessage | undefined)
    .filter((m): m is AuthorizerMessage => m !== undefined)
    .map((m) => ({ code: typeof m.codigo === 'string' ? m.codigo.trim() : '', text: [m.descricao, m.complemento].filter((t) => typeof t === 'string' && t !== '').join(' — ') }))
    .filter((m) => REJECTION_CODE.test(m.code));
}

/** Objeto com as chaves em minúsculas (só o primeiro nível). */
function lowerKeys(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key.toLowerCase(), v]));
}

function describe(messages: readonly { code: string; text: string }[]): string {
  return messages
    .map((m) => `${m.code}: ${m.text}`)
    .join('; ')
    .slice(0, MESSAGE_MAX);
}
