/** Porta: verificação de dependência para readiness (banco, object storage, KMS...). */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<void>;
}
