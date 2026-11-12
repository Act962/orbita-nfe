import type { BackoffPolicy } from '../domain/backoff.js';

/**
 * Fila persistente no PostgreSQL (ADR-0005, ADR-0030). O job é gravado na MESMA transação da
 * mudança de estado que o originou: ou os dois existem, ou nenhum.
 *
 * Separação por privilégio (ADR-0021): cada fila pertence a uma "lane". O worker-fiscal só
 * enxerga a lane `fiscal`; o worker-general, só a `general` (RLS na tabela de jobs).
 */
export const JOB_LANES = ['fiscal', 'general'] as const;
export type JobLane = (typeof JOB_LANES)[number];

export interface QueueDefinition {
  readonly lane: JobLane;
  /** Tentativas antes de o job ir para a fila de mortos (state `dead`). */
  readonly maxAttempts: number;
  readonly backoff: BackoffPolicy;
  /** Tempo máximo de execução; também define a concessão (lease) do job. */
  readonly timeoutSeconds: number;
  /** Maior = antes. */
  readonly priority: number;
}

/** Catálogo fechado de filas. Fila nova entra aqui, no doc 07 §2 e no runbook de filas. */
export const QUEUES = {
  /** Validação de certificado enviado (CERT-001). Só o worker-fiscal tem a KEK privada. */
  'certificates.validate': {
    lane: 'fiscal',
    maxAttempts: 5,
    backoff: { baseSeconds: 30, maxSeconds: 1800, jitter: 0.2 },
    timeoutSeconds: 60,
    priority: 10,
  },
  /**
   * Aviso de vencimento de certificado (30/15/7/1 dia e vencimento). Agendado pelo worker-fiscal
   * na ativação, executado pelo worker-general, que só vê vencimento e status (ADR-0021).
   */
  'certificates.expiry-notice': {
    lane: 'general',
    maxAttempts: 8,
    backoff: { baseSeconds: 60, maxSeconds: 3600, jitter: 0.2 },
    timeoutSeconds: 30,
    priority: 3,
  },
  /**
   * Âncora diária da cadeia de auditoria de uma empresa no bucket com Object Lock (ADR-0031).
   * Cada execução agenda a do dia seguinte ANTES de gravar, para a corrente não parar se a
   * gravação falhar até o job morrer.
   */
  'audit.anchor-company': {
    lane: 'general',
    maxAttempts: 24,
    backoff: { baseSeconds: 300, maxSeconds: 3600, jitter: 0.2 },
    timeoutSeconds: 60,
    priority: 1,
  },
  /** Âncora diária da cadeia de auditoria da plataforma (operador). */
  'audit.anchor-platform': {
    lane: 'general',
    maxAttempts: 24,
    backoff: { baseSeconds: 300, maxSeconds: 3600, jitter: 0.2 },
    timeoutSeconds: 60,
    priority: 1,
  },
  /**
   * Transmissão de uma NFS-e com write-ahead (ADR-0022, ADR-0032). Também é a recuperação de
   * queda: o job volta quando a concessão vence e o handler aplica a tabela do doc 12 §2.
   */
  'nfse.process': {
    lane: 'fiscal',
    maxAttempts: 20,
    backoff: { baseSeconds: 30, maxSeconds: 1800, jitter: 0.2 },
    timeoutSeconds: 180,
    priority: 20,
  },
  /** Uma consulta de reconciliação de NFS-e em UNKNOWN; a próxima é um job novo com runAt. */
  'nfse.reconcile': {
    lane: 'fiscal',
    maxAttempts: 20,
    backoff: { baseSeconds: 60, maxSeconds: 3600, jitter: 0.2 },
    timeoutSeconds: 120,
    priority: 15,
  },
  /** Distribui um evento do outbox às assinaturas de webhook interessadas. */
  'webhooks.fanout': {
    lane: 'general',
    maxAttempts: 8,
    backoff: { baseSeconds: 15, maxSeconds: 900, jitter: 0.2 },
    timeoutSeconds: 30,
    priority: 5,
  },
  /** Uma tentativa de entrega HTTP de webhook. O calendário de reentrega é do domínio de webhooks. */
  'webhooks.deliver': {
    lane: 'general',
    maxAttempts: 5,
    backoff: { baseSeconds: 30, maxSeconds: 900, jitter: 0.2 },
    timeoutSeconds: 30,
    priority: 5,
  },
} as const satisfies Record<string, QueueDefinition>;

export type QueueName = keyof typeof QUEUES;

export function isQueueName(value: string): value is QueueName {
  return Object.hasOwn(QUEUES, value);
}

/**
 * Conteúdo de um job: SÓ identificadores (UUID). Nada de dados fiscais, pessoais ou segredos:
 * o handler recarrega o estado do banco (docs/architecture/07 §3).
 */
export type JobPayload = Readonly<Record<string, string>>;

export interface JobRequest {
  readonly queue: QueueName;
  readonly payload: JobPayload;
  /** No máximo um job pendente/em execução por (fila, chave). Repetir não duplica. */
  readonly singletonKey?: string;
  readonly runAt?: Date;
  readonly correlationId?: string | null;
}

/** Enfileira jobs na transação corrente (porta usada pelos módulos via unit of work). */
export interface JobScheduler {
  enqueue(job: JobRequest): Promise<void>;
}

/** Job entregue a um handler. */
export interface ClaimedJob {
  readonly id: string;
  readonly queue: QueueName;
  readonly payload: JobPayload;
  /** Tentativa atual (1 = primeira). */
  readonly attempt: number;
  readonly correlationId: string | null;
}

/** Handler de uma fila. Deve ser idempotente: o mesmo job pode rodar mais de uma vez. */
export type JobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;

/**
 * Falha que não adianta repetir (ex.: payload inválido): o job vai direto para `dead`.
 * Qualquer outro erro conta como tentativa e segue o backoff da fila.
 */
export class PermanentJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentJobError';
  }
}
