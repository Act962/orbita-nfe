# 10 — Estratégia de testes

## Pirâmide e tipos
| Nível | Ferramenta | O que cobre | Roda no CI |
|---|---|---|---|
| Unitário de domínio | Vitest + fast-check | VOs (CNPJ numérico e alfanumérico, CPF, chave de acesso + DV), máquinas de estado (todas as transições válidas **e** inválidas), regras fiscais (cada uma com referência à fonte), aritmética decimal | sim |
| Casos de uso | Vitest + fakes em memória das portas | orquestração, idempotência, classificação de resultados, transições | sim |
| Integração de persistência | Testcontainers PostgreSQL | repositories, RLS, constraints, migrations do zero, concorrência real | sim |
| Contrato de adapters | mesma suíte contra fake e homologação | `NfseGateway`, `Sefaz*Gateway`, `XmlSigner`, `SchemaValidator`, `CertificateVault`, `ObjectStorage` (MinIO) | fake: sim; homologação: job manual/noturno com segredo |
| API | `fastify.inject` | autenticação, escopos, isolamento de tenant, validação, códigos HTTP, OpenAPI | sim |
| Idempotência | integração | mesma `Idempotency-Key` em paralelo (N requisições simultâneas → 1 documento); mesmo key + payload diferente → 422 | sim |
| Concorrência | integração | N workers no mesmo documento → 1 transmissão; alocação de números sem duplicata e sem lacuna sob carga | sim |
| Falhas de comunicação | fake-authorities com modos de falha | timeout pós-envio → `UNKNOWN` → consulta → `AUTHORIZED` sem retransmissão | sim |
| Recuperação | integração | worker morto no meio (lease expira), reinício, reconciliação | sim |
| Regressão fiscal | golden files | XML gerado para casos de referência comparado após canonicalização; validação XSD com schemas oficiais | sim |
| Casos oficiais | fixtures | XMLs de exemplo dos manuais e retornos reais de homologação (anonimizados), catálogo de rejeições conhecidas | sim |
| Assinatura | integração | assinar com certificado de teste e verificar com verificador independente (`xmlsec1` em container) | sim |

## Regras
1. TDD para domínio e casos de uso: teste primeiro, especialmente máquinas de estado e classificação de falhas.
2. Nenhuma regra fiscal sem teste **e** sem referência de origem no teste (`// fonte: MOC 7.0 §x / NT 20xx.xxx`).
3. Mock passa ≠ integração funciona. Cada adapter só é considerado "pronto" após passar a suíte de contrato em **homologação oficial**, com evidência registrada em `ACOMPANHAMENTO.md`.
4. Certificados de teste: gerados por uma CA de teste própria para testes automatizados; certificado real de homologação só em ambiente controlado, nunca no repositório.
5. Cobertura como sinal, não meta: domínio e application ≥ 90% de branches; mutation testing (Stryker) no domínio fiscal a partir da Fase 2.
