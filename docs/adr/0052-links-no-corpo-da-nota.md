# ADR-0052 — `links` no corpo da NFS-e

- Status: **Aceito** · Data: 2026-11-24
- Relacionados:
  - ADR-0026 item 8 e doc 16 A11 (links de arquivos no corpo);
  - ADR-0036 (substituição);
  - ADR-0050 (download do XML pela API).

## Contexto
O doc 11 já mostrava `links.self` na resposta da emissão, e o A11 da referência Focus NFe (doc 16) pedia os links de arquivos no corpo. Com o download do XML (ADR-0050), o cliente tinha as rotas, mas precisava montá-las e deduzir pelo status quando cada uma existe. Isso espalha regra de negócio pelos sistemas que consomem a API (Orbita e NERP).

## Decisão
1. **Toda resposta com a nota** (emissão, substituição, consulta e lista) traz `links`, com seis campos sempre presentes:
   - `self`: a própria nota;
   - `xml`: o XML autorizado, quando a nota tem chave de acesso (AUTHORIZED, CANCELLED, SUBSTITUTED);
   - `cancellation` e `cancellationXml`: o pedido e o XML do evento, quando a nota está CANCELLED;
   - `substitutes`: na substituta, a nota que ela substitui;
   - `substitutedBy`: na nota SUBSTITUTED, a substituta.
2. **Nulo quando o recurso ainda não existe.** O campo nunca some: o cliente testa `null` e não precisa conhecer a máquina de estados. As regras saem do que o banco grava junto:
   - a chave de acesso e o XML nascem na mesma transação da autorização (ADR-0048);
   - CANCELLED só existe com o evento registrado, que sempre traz o XML (ADR-0035, ADR-0049).
3. **Caminhos relativos ao endereço da API**, sem host. O motor fica atrás de proxy e não sabe com que nome o cliente o alcança. O link usa a mesma credencial e o mesmo `X-Company-Id` da consulta.
4. **Nenhum link aponta para URL pré-assinada.** O XML continua servido pela API (ADR-0050). Os links de PDF e do ZIP mensal entram quando esses arquivos existirem.
5. O pedido de cancelamento em andamento ou recusado não aparece em `links`: a nota não guarda esse estado, e a rota `GET …/cancellation` continua respondendo por ele.

## Consequências
- Campo novo na resposta: mudança compatível (ADR-0026 e o changelog da API). Clientes que validam o corpo de forma estrita precisam aceitar `links`.
- Um link não nulo responde 200 com a mesma credencial, conferido por teste para a nota cancelada e para o par original e substituta.
