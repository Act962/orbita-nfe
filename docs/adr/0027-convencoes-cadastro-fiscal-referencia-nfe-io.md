# ADR-0027 — Cadastro fiscal, certificados e documentação inspirados na NFE.io

- Status: **Aceito** · Data: 2026-11-10 · Aprovado pelo responsável em 2026-11-10

## Contexto
A pedido do responsável, a documentação pública da NFE.io foi analisada como segunda referência de mercado ([doc 17](../architecture/17-referencia-nfe-io.md)), depois da Focus NFe ([ADR-0026](0026-convencoes-api-referencia-mercado.md)). O ponto forte da NFE.io é o **cadastro fiscal**: inscrições municipais e estaduais como recursos próprios, ambiente com padrão de teste, API de certificados com status e validade, contingência configurável e documentação preparada para agentes. Os pontos fracos (vários hosts, dois formatos de erro, webhooks sem assinatura e sem política publicada) confirmam decisões já tomadas.

## Decisão
Adotar, sem alterar os ADRs 0009, 0012, 0015, 0018, 0024 e 0026:
1. **Habilitação de produção** por estabelecimento e modalidade, auditada e com escopo próprio. Uma chave `live` só emite onde houver habilitação; estabelecimento novo nasce só com homologação.
2. **Inscrições fiscais** (municipal e estadual) como recursos do estabelecimento, ligadas a séries e modalidades.
3. **API de certificados** só com metadados (thumbprint SHA-256, titular, validade, status `PENDING_VALIDATION`/`ACTIVE`/`EXPIRING`/`EXPIRED`/`REVOKED`). Só e-CNPJ A1 com a mesma raiz da empresa. Troca com sobreposição, sem janela sem certificado. Chave privada e senha nunca saem do cofre.
4. **CSC da NFC-e** guardado no cofre com o mesmo envelope do certificado.
5. **Estratégia de contingência** por inscrição estadual (`MANUAL` por padrão, `AUTOMATIC` opcional), com motivo e auditoria. Documento já enviado nunca troca de autorizador. As modalidades só entram após leitura do MOC.
6. **Webhooks** com catálogo de tipos de evento e filtros por assinatura.
7. **Downloads** de XML de rejeição e de eventos pelos links 302 do ADR-0026. **Inutilização** por faixa com comprovante.
8. **Documentação para agentes**: OpenAPI em URL estável, `llms.txt` e páginas em Markdown; guia de migração junto de cada versão nova.

## Consequências
- Fase 1: mais requisitos na semana 5 (certificados) e na semana 7 (habilitação de produção, OpenAPI/`llms.txt`). Na semana 6 entram o catálogo e os filtros de webhook.
- Fases 2a e 3: inscrições fiscais, CSC, contingência, inutilização e downloads de eventos.
- Habilitação de produção e credencial `live` formam duas travas independentes, o que reduz o risco de emitir em produção por engano.
- O que foi visto na NFE.io sobre EPEC, contingência, inutilização e tipos de certificado **não** é fonte. Só entra após confirmação oficial (doc 17, §6).
