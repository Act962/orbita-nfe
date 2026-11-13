# ADR-0029 — Transmissão e reconciliação no padrão nacional da NFS-e

- Status: **Aceito**
- Data: 2026-11-10
- Aprovação: responsável, em 2026-11-10
- Complementa: ADR-0006 (UNKNOWN), ADR-0007 (idempotência), ADR-0008 (numeração), ADR-0022 (write-ahead)

## Contexto
A SEFIN Nacional e o emissor de Teresina (DSF) expõem o mesmo desenho de API.

| | SEFIN Nacional (manual "v1.2 out/2025") | Teresina DSF (Guia V7) |
|---|---|---|
| Emissão | `POST /nfse` | `POST /notafiscal-ws/nfse` |
| Chave pela DPS | `GET /dps/{id}` (só para ator da nota) + `HEAD /dps/{id}` | `GET /notafiscal-ws/nfse/dps/{id}` |
| Consulta | `GET /nfse/{chave}` | `GET /notafiscal-ws/nfse/{chave}` |
| Eventos | `POST/GET /nfse/{chave}/eventos` | `POST /notafiscal-ws/nfse/{chave}/eventos` |
| Envelope | JSON + XML gzip+Base64 (regras E1225/E1226) | JSON `dpsXmlGZipB64` / `pedidoRegistroEventoXmlGZipB64` |
| Autenticação | Certificado de cliente ICP-Brasil (E1200–E1209) | Certificado de cliente com o mesmo CNPJ raiz |

A SEFIN impõe unicidade de série + número + município + CNPJ pela regra **E0014**. O Id da DPS é determinístico (XSD `TSIdDPS`).

## Decisão
1. **Um cliente do padrão nacional**, em `nfse/infrastructure/gateways/national/`, faz a serialização, o gzip+Base64, a assinatura, o mTLS e a leitura do JSON. Ele é parametrizado por um **perfil de endpoint**, que é dado:
   - URLs por ambiente e caminhos;
   - capacidades (`supportsHeadDps`, `dpsLookupPath`);
   - perfil de assinatura (ADR-0014);
   - versão de leiaute por ambiente (ADR-0013).
   - Perfis previstos: `sefin-nacional` (Fase 2a) e `teresina-dsf` (Fase 2b). Fora isso, não há framework genérico de provedores.
2. A porta `NfseGateway` devolve uma união fechada: `Authorized(chave, xml) | Rejected(codigo, mensagem) | AlreadyExists | Indeterminate(fase)`.
   - Timeout, reset de conexão, 5xx e resposta ilegível **sempre** resultam em `Indeterminate`.
   - Rejeição definitiva só vem de uma resposta do autorizador com código `Exxxx`.
3. **Reconciliação antes de qualquer reenvio:**
   - `Indeterminate` deixa o documento em `UNKNOWN`. Daí, consulta `GET` (ou `HEAD`) `/dps/{id}`:
     - chave encontrada → `GET /nfse/{chave}` → `AUTHORIZED`;
     - 404 consistente após uma janela mínima → reenvio **da mesma DPS assinada**, com o mesmo Id, série e número.
   - `E0014` também leva à reconciliação, nunca a uma nova numeração.
4. A DPS assinada é guardada (S3 + hash) **antes** do envio, junto com o write-ahead da tentativa. O reenvio usa os mesmos bytes.
5. Número enviado nunca é reaproveitado, nem depois de rejeição. As séries do motor não usam a faixa 80000–89999, que o Emissor Web usa na transcrição manual (comunicado de implantação do gov.br/nfse; ver [SERIES-002](../fiscal/regras/SERIES-002.md)).

## Alternativas consideradas
- **Gerar uma nova DPS no reenvio.** Rejeitada: arrisca duplicar a nota e perde a reconciliação por Id.
- **Tratar timeout como falha e reenviar.** Rejeitada: contraria a premissa do projeto.

## Consequências
- O adapter de Teresina, se vier, vira um perfil novo mais as validações locais (`cTribMun` obrigatório).
- ~~Pendências a confirmar no Swagger da SEFIN~~: **confirmadas em 2026-11-13** (complemento abaixo).

## Complemento (2026-11-13) — Swagger da SEFIN lido com o A1 real
Fonte: a especificação Swagger 2.0 "API NFS-e - Sefin Nacional" da produção restrita, lida com mTLS pelo `npm run sefin:docs`. Está guardada em `resources/fiscal/sefin-docs/producao-restrita/2026-11-13/docs-v1.json`, com SHA-256 `ea7a720f…3217`.

- **Conexão:**
  - host `sefin.producaorestrita.nfse.gov.br` e `basePath` **`/SefinNacional`**. O `/API/SefinNacional` é só o endereço da página de documentação;
  - "TLS 1.0, TLS 1.1 e TLS 1.2 com autenticação mútua", certificado ICP-Brasil A1 ou A3 com "Autenticação Cliente";
  - sem certificado, a documentação responde 403; com o A1, responde 200. **O mTLS funcionou.**
- **Emissão:** `POST /nfse`.
  - Corpo: `{ "dpsXmlGZipB64" }`.
  - Resposta 201: `{ tipoAmbiente, versaoAplicativo, dataHoraProcessamento, idDps, chaveAcesso, nfseXmlGZipB64, alertas[] }`.
  - Respostas 400, 403 e 500: `{ …, idDPS?, erros: [{ codigo, descricao, complemento }] }`, com `erros` no plural.
- **Chave pela DPS:**
  - `GET /dps/{id}` responde 200 com `{ idDps, chaveAcesso }`, ou 404 com "Não foi gerada uma NFS-e com o identificador de DPS informado";
  - `HEAD /dps/{id}` responde 200 ou 404.
- **Consulta:** `GET /nfse/{chaveAcesso}` responde 200 com `{ chaveAcesso, nfseXmlGZipB64 }`, ou 400, 401, 403 e 404.
- **Eventos:**
  - `POST /nfse/{chaveAcesso}/eventos`, com corpo `{ "pedidoRegistroEventoXmlGZipB64" }`. A resposta 201 traz `{ eventoXmlGZipB64 }`; a 400 traz o erro no formato `{ erro: { codigo, descricao, complemento } }`, **no singular**, diferente da emissão.
  - **Achado:** a consulta de evento é **`GET /nfse/{chave}/eventos/{tipoEvento}/{numSeqEvento}`**, e o `numSeqEvento` é obrigatório. Os tipos aceitos são 101101, 101103, 105102, 105104, 105105, 202201, 202205, 203202, 203206, 204203, 204207, 205204, 205208, 305101, 305102, 305103, 467201 e 907201.
  - A porta `findEvent(chave, tipo)` vai precisar do número sequencial: 1 no primeiro pedido de cada tipo. O formato do Id do pedido continua a confirmar no primeiro registro real (R-40).
- **Fora da SEFIN:** DANFSe e parâmetros municipais foram movidos para o ADN (`adn.producaorestrita.nfse.gov.br/danfse` e `/parametrizacao`). A SEFIN responde 501 nesses caminhos.

## Fontes
[Diagnóstico](../fiscal/nfse-teresina-api-municipal-x-nacional.md) §1.3, §3.2–3.4, §8 e §9.1.
