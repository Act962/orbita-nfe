# Resultados dos spikes técnicos — Fase 1

Data: 2026-11-09 · Código: [`spikes/`](../../spikes/README.md) · Execução: `npm run spikes` → **41 testes passando**.

Ambiente: Node 24.12, OpenSSL 3.2.1 (CLI, só para gerar fixtures), xmlsec1 1.3.7 (Docker alpine:3.22), PostgreSQL 17 (Docker).

## Resumo

| Spike | Pergunta | Resultado | Decisão |
|---|---|---|---|
| 01 | Abrir PFX A1 em memória e gerar XMLDSig verificável de forma independente | ✅ 11/11 | **node-forge** (licença BSD-3) para PKCS#12 + **xml-crypto** para XMLDSig. ADR-0014 aceito em parte |
| 02 | mTLS com A1 e classificação segura da fase de falha | ✅ 10/10 | **undici** + `diagnostics_channel`. ADR-0022 confirmado, com 1 achado |
| 03 | Validar XSD com include/import sem binding nativo; parser seguro de respostas | ✅ 15/15 | **xmllint-wasm** (libxml2/wasm, MIT) + **@xmldom/xmldom** com bloqueio de DOCTYPE |
| 04 | O enqueue do pg-boss participa da transação da aplicação? | ✅ 5/5 | **pg-boss 12** com `db` da transação. ADR-0005: pg-boss confirmado |

## Spike 01 — PKCS#12 e XMLDSig
**Confirmado**
- PFX aberto inteiramente em memória (sem disco, sem processo externo), nos formatos 3DES, AES-256 (PBES2) e **legado RC2/3DES (`openssl -legacy`)**, que é comum em A1 emitidos há mais tempo.
- Chave e certificado conferidos por `X509Certificate.checkPrivateKey`; a cadeia é separada da folha.
- Senha errada → `PKCS12_INVALID_PASSWORD`, sem a senha nem detalhes do material na mensagem.
- Assinatura enveloped do elemento com `Id` (Reference `#Id`, KeyInfo com X509Certificate, `Signature` logo após o elemento assinado) nos perfis RSA-SHA1 e RSA-SHA256 com C14N 1.0.
- **xmlsec1 verificou as assinaturas** e rejeitou o documento adulterado.

**Achados**
1. **O TLS nativo do Node 24 (OpenSSL 3) recusa PFX legado** em `createSecureContext({ pfx })`. Solução validada: abrir com node-forge e passar `key` + `cert` separados ao TLS. Isso vira regra do adapter.
2. A chave privada passa brevemente por uma string PEM no heap antes de virar `KeyObject`. É uma limitação aceita: o controle principal é que esse código só roda no `worker-fiscal` (ADR-0021).
3. O perfil de algoritmos (SHA-1 ou SHA-256, transforms) **não tem padrão no código** e será definido pelo manual de cada leiaute (pendente de leitura oficial).

## Spike 02 — mTLS e classificação de falhas
| Cenário | Resultado | Requisições recebidas pelo servidor |
|---|---|---|
| Sucesso com certificado aceito | `RESPONSE 200` | 1 |
| HTTP 500 | `RESPONSE 500` (o gateway aplica a regra `UNKNOWN`) | 1 |
| Porta fechada | `NOT_SENT` | 0 |
| DNS inexistente | `NOT_SENT` | 0 |
| Certificado do **servidor** não confiável | `NOT_SENT` (falha no handshake) | 0 |
| Certificado do **cliente** rejeitado | `UNKNOWN / response-wait` | 0 |
| Servidor processa e não responde | `UNKNOWN / response-wait` | 1 |
| Servidor processa e derruba a conexão | `UNKNOWN` | **1 (sem retentativa automática)** |
| Resposta cortada no meio | `UNKNOWN / response-read` | 1 |
| 4 requisições concorrentes de tipos diferentes | classificações corretas, sem mistura | — |

**Achado importante**: com TLS 1.3, quando o **servidor recusa o certificado do cliente**, o cliente já concluiu o handshake e enviou a requisição antes de receber o alerta. A classificação correta e segura é `UNKNOWN` (não temos como provar que não chegou). Consequências:
- Validar o certificado **localmente antes do envio** (vencimento, cadeia, CNPJ) é obrigatório, para que esse caso vire `FAILED` antes da transmissão (já previsto no doc 13).
- Na reconciliação, a consulta vai encontrar "não existe" e o fluxo normal resolve. Um certificado revogado ou recusado de forma persistente gera alertas pelo escalonamento do `UNKNOWN`.

**Regra confirmada no código**: só é `NOT_SENT` se o canal `undici:client:sendHeaders` não tiver disparado para aquela requisição. A correlação entre requisição e trace usa `AsyncLocalStorage` no evento síncrono `undici:request:create`. Sem correlação, o resultado é `UNKNOWN` (falha segura).

## Spike 03 — XSD e parser seguro
- Schema principal com `xs:include` (mesmo namespace) e `xs:import` (XMLDSig) resolvidos em memória: o xmllint wasm não acessa disco nem rede.
- Rejeitou enumeração, padrão decimal, campo obrigatório ausente, ordem errada, elemento não previsto e texto vazio, sempre com mensagem.
- XML assinado pelo spike 01 é validado junto com o import XMLDSig.
- Entidade externa (XXE) não foi resolvida pela validação.
- **Desempenho: cerca de 88 ms por documento**, porque o wasm é instanciado a cada chamada. É suficiente para a Fase 2a (o gargalo é o autorizador). Otimizações possíveis depois: instância persistente ou `worker_threads`.
- Parser de XML não confiável: recusa qualquer `DOCTYPE`/`ENTITY` (XXE e *billion laughs*), XML malformado e tamanho acima do limite.
- **Achado**: o xmldom 0.9 lança `ParseError` em erro fatal em vez de usar só o callback. O adapter trata os dois caminhos.

**Limitação**: os XSDs usados são de teste e reproduzem só a estrutura dos pacotes oficiais. Validar com os XSDs oficiais da NFS-e é o primeiro passo da Fase 2a.

## Spike 04 — pg-boss transacional
- `send(..., { db })` com o `client` da transação da aplicação: **COMMIT grava documento e job juntos; ROLLBACK descarta os dois**. Não há dual write.
- Política `exclusive` + `singletonKey = documentId`: **no máximo um job por documento**, na fila ou em execução. É a proteção de fila contra transmissão concorrente do mesmo documento, que se soma ao lock otimista.
- 8 workers concorrentes buscando 20 jobs: nenhum job foi entregue duas vezes (SKIP LOCKED).
- Esgotadas as retentativas, o job vai para a DLQ configurada.

## Pendências que não eram objetivo destes spikes
- S3 local (SeaweedFS × Garage): ainda não testado; será feito junto com o adapter do Fiscal Archive.
- Instância persistente do xmllint-wasm (desempenho).
- XSDs oficiais e algoritmos de assinatura do manual NFS-e Nacional (Fase 2a).
