# 06 — Estratégia de integração com os órgãos fiscais

## 1. Princípios
1. **Nada de endpoint, schema ou código fiscal "de memória"**. Toda URL, XSD, tabela de códigos e regra vem de fonte oficial registrada em `docs/fiscal/fontes-oficiais.md` com data de consulta, versão e hash do arquivo baixado.
2. URLs e versões são **dados versionados** (`resources/fiscal/webservices/*.json`), não constantes no código, para que uma mudança de NT seja uma alteração revisável de dados.
3. Cada autorizador fica atrás de uma **porta orientada ao domínio** (não "SoapClient genérico").
4. Cada adapter tem: transporte → serialização → assinatura → validação → **classificação do resultado**. A classificação é a parte mais importante e é testada exaustivamente.

## 2. Portas (contratos iniciais)

```ts
// modules/nfse/application/ports/nfse-gateway.ts
export interface NfseGateway {
  submit(input: SignedDps, ctx: GatewayContext): Promise<SubmissionOutcome>;
  findByDpsId(dpsId: DpsId, ctx: GatewayContext): Promise<LookupOutcome>;
  findByAccessKey(key: NfseAccessKey, ctx: GatewayContext): Promise<LookupOutcome>;
  registerEvent(event: SignedNfseEvent, ctx: GatewayContext): Promise<EventOutcome>;
}

export type SubmissionOutcome =
  | { kind: 'AUTHORIZED'; authorization: NfseAuthorization; raw: RawExchange }
  | { kind: 'REJECTED'; reasons: OfficialReason[]; raw: RawExchange }
  | { kind: 'NOT_SENT'; error: TransportError; retryable: boolean }   // certeza de que não saiu
  | { kind: 'UNKNOWN'; error: TransportError; raw?: RawExchange };     // pode ter chegado

// modules/dfe-sefaz/application/ports/
export interface SefazAuthorizationGateway { authorize(batch: SignedNfeBatch, ctx): Promise<AuthorizationOutcome>; fetchReceipt(...); }
export interface SefazProtocolQueryGateway { queryByAccessKey(key: AccessKey, ctx): Promise<ProtocolQueryOutcome>; }
export interface SefazEventGateway { register(event: SignedEvent, ctx): Promise<EventOutcome>; }
export interface SefazVoidingGateway { voidRange(req: SignedVoidingRequest, ctx): Promise<VoidingOutcome>; }
export interface SefazStatusGateway { serviceStatus(uf: Uf, env: Environment): Promise<ServiceStatus>; }

// transversais
export interface XmlSigner { sign(xml: string, referenceId: string, cert: CertificateHandle): Promise<string>; }
export interface SchemaValidator { validate(xml: string, schema: SchemaRef): ValidationResult; }
export interface CertificateVault { withCertificate<T>(estId: EstablishmentId, purpose: CertPurpose, fn: (h: CertificateHandle) => Promise<T>): Promise<T>; }
```

`CertificateHandle` é opaco: expõe `sign(data)` e `tlsOptions()` usados apenas por infraestrutura.

## 3. Classificação de falhas de transporte

| Situação | Classificação | Ação |
|---|---|---|
| DNS falhou, conexão recusada, handshake TLS falhou antes de enviar o corpo | `NOT_SENT` (retryable) | retry com backoff |
| Certificado do cliente rejeitado no handshake | `NOT_SENT` (não retryable) | `FAILED` + alerta de certificado |
| Timeout **após** escrever o corpo | `UNKNOWN` | consulta |
| Conexão resetada após envio | `UNKNOWN` | consulta |
| HTTP 5xx / SOAP Fault genérico | `UNKNOWN` (conservador) | consulta |
| Resposta com código oficial "em processamento" / lote em processamento | aguardando | consultar recibo |
| Resposta com código de rejeição | `REJECTED` | mapear código oficial |
| Resposta indicando duplicidade | **não é rejeição comum**: consultar e adotar o documento existente se for o mesmo | consulta |

O cliente HTTP registra a fase em que a falha aconteceu (`connect`, `tls`, `request-write`, `response-wait`, `response-read`) — sem isso a classificação é impossível. Implementação com `undici` + hooks de diagnóstico, verificada em *spike* na Fase 1.

## 4. NFS-e — estratégia
1. **Padrão nacional primeiro** (Sefin Nacional para emissão via DPS e ADN para distribuição/consulta), com mTLS por certificado ICP-Brasil. Endpoints, formato (XML assinado transportado em API REST), versões de leiaute e regras de identificação da DPS serão extraídos da documentação oficial em `gov.br/nfse` no início da Fase 2.
2. **Município-piloto**: escolher um município onde o tenant-piloto realmente emite e **confirmar oficialmente** se ele usa o emissor/API nacional diretamente ou mantém sistema próprio. A LC 214/2025 trata da adoção do padrão nacional pelos municípios — o grau de adesão e prazos devem ser verificados no ato (ver R-04).
3. Provedores municipais (ABRASF etc.) só entram com demanda concreta, como adapters da mesma porta `NfseGateway`.
4. Homologação: usar o ambiente de produção restrita/homologação oficial com o CNPJ do piloto.

## 5. NF-e / NFC-e — estratégia
1. Leiaute 4.00 + NTs vigentes (incluindo grupos da Reforma Tributária — IBS/CBS/IS — conforme NT da RTC vigente). XSDs baixados do Portal Nacional da NF-e.
2. Autorizador por UF: SEFAZ própria ou virtual (SVRS/SVAN) conforme tabela oficial; contingência SVC conforme tabela oficial. Mapeamento UF → autorizador também é dado versionado.
3. Envio síncrono de um documento por lote quando suportado pela UF (verificar), com fallback para recibo.
4. Antes de cada transmissão, **não** chamar status do serviço a cada nota (custo/consumo indevido); usar circuit breaker alimentado por resultados reais + checagem periódica de status.
5. Respeitar regras de uso indevido/consumo excessivo publicadas pelas SEFAZ (limites de consulta repetida) — o reconciliador tem rate limit por UF/CNPJ.

## 6. Resiliência por autorizador
- **Circuit breaker** por (autorizador, ambiente, serviço). Aberto → novos jobs ficam `PENDING` com atraso; para NF-e/NFC-e, política de contingência decide se entra em contingência (decisão explícita do tenant, nunca automática sem configuração).
- **Timeouts** explícitos por fase; valores iniciais configuráveis e ajustados por medição.
- **Bulkhead**: concorrência máxima por autorizador e por tenant, para um tenant grande não derrubar os outros.

## 7. Ambientes simulados
- `tools/fake-authorities`: servidor HTTP que imita contratos **a partir de exemplos reais capturados em homologação**, com modos: autoriza, rejeita (código X), timeout antes/depois de processar, resposta lenta, 5xx, "processa mas derruba conexão" (o cenário que gera duplicidade).
- Testes de contrato executam a **mesma suíte** contra o fake e, sob flag, contra homologação real. Um fake que diverge do real é corrigido pelo real, nunca o inverso.
