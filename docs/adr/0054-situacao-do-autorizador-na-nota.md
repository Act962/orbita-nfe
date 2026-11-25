# ADR-0054 — `authorizerStatus`: o que o autorizador respondeu, na resposta da nota

- Status: **Aceito** · Data: 2026-11-24
- Relacionados:
  - ADR-0026 item 5 e doc 16 A7 (código e mensagem do autorizador na resposta);
  - ADR-0048 (dados gravados junto com o XML autorizado);
  - ADR-0028 e ADR-0039 (canal do autorizador).

## Contexto
A nota já trazia `rejection { code, message }` quando rejeitada. Na nota gerada, nada dizia o que o autorizador respondeu: o cliente só via `AUTHORIZED`. O A7 do doc 16 pede o código e a mensagem do autorizador sempre que houver.

Na NFS-e Nacional, o XML da NFS-e gerada traz `infNFSe/cStat`, do tipo `TStat`. O XSD oficial (`tiposSimples_v1.01.xsd`, igual nos pacotes `1.01-20260209` e `1.01-20261020-prodrest`) lista os valores e as descrições:
- 100: NFS-e Gerada;
- 102: NFS-e de Decisão Judicial;
- 103: NFS-e Avulsa;
- 107: NFS-e MEI.

## Decisão
1. **`authorizerStatus: { code, message, source } | null`** em toda resposta com a nota.
   - Rejeitada: `code` e `message` da rejeição, como o autorizador mandou.
   - Gerada (e depois cancelada ou substituída): `code` é o `cStat` do XML autorizado; `message` é a descrição do XSD para esse código, ou `null` se o código não estiver na lista. A descrição nunca é inventada.
   - `source`: o canal gravado no aceite (`NATIONAL_SEFIN` ou `MUNICIPAL_TERESINA_DSF`).
   - Nulo em andamento, em `UNKNOWN` e em `FAILED`: o autorizador não respondeu, ou a falha foi local.
   - `rejection` continua como está, por compatibilidade.
2. **O `cStat` é lido uma vez, na autorização, e gravado com o XML** (`nfse_status_code`, migrations 0030 e 0031).
   - Vale para os três caminhos da autorização (envio, consulta e resolução manual), porque todos passam pela mesma gravação.
   - A leitura usa o parser de XML não confiável do projeto e só aceita o `cStat` filho direto de `infNFSe`, no namespace da NFS-e Nacional, com três dígitos.
   - É informativo: XML sem o grupo, ou ilegível, grava `null` e não impede a autorização. A conferência do XML continua sendo a dos caminhos que já existem.
3. **Travas no banco:** o código é gravado uma única vez, só junto com o XML, e tem de ter três dígitos. Só o worker-fiscal grava; a API lê; o operador vê o código.

## Consequências
- Campo novo na resposta: mudança compatível.
- Notas autorizadas antes da migration ficam com `authorizerStatus` nulo (só existem em desenvolvimento).
- Se uma versão nova do XSD acrescentar valores ao `TStat`, o código aparece sem descrição até a lista do motor ser atualizada a partir do XSD novo.
- O emissor municipal de Teresina (DSF) segue o contrato do padrão nacional e o XSD v1.01 de 09/02/2026 (ADR-0039), que tem o mesmo `TStat`. Isso ainda não foi visto numa nota real da DSF (bloqueio R-44); se ela devolver outro leiaute, o código fica nulo, sem erro.
