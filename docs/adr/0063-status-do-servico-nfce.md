# ADR-0063 — Consulta do status do serviço da NFC-e (SVRS, homologação)

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - ADR-0062 (schemas da NFC-e);
  - ADR-0022 (transporte mTLS com a fase da falha);
  - ADR-0038 (CLI de teste da SEFIN);
  - [diagnóstico da NFC-e no PI](../fiscal/nfce-piaui-diagnostico.md).
- **Não emite nota.** O status do serviço não cria documento fiscal.

## Contexto
O status do serviço (`NfeStatusServico4`) é a primeira chamada real possível ao autorizador da NFC-e. Ela não precisa de credenciamento nem de CSC, só de um A1 válido. Ela serve para três coisas:
- provar o transporte (mTLS, TLS do SVRS, SOAP 1.2) antes da emissão;
- confirmar que o **SVRS atende o PI**. A regra K02 do MOC (item 5.5.4) recusa com cStat 289 a UF que o webservice não atende, então um 107 com `cUF=22` é a confirmação;
- dar à operação um "o autorizador está no ar?" (108 e 109 = paralisado).

## Fontes
- **MOC 7.0, Visão Geral:**
  - item 4.4: SOAP 1.2, Document/Literal, XML no parâmetro `nfeDadosMsg`; desde a versão 4.0 sem o SOAP Header `nfeCabecMsg`;
  - item 5.5: leiaute, regras K01 a K04 e o intervalo mínimo de 3 minutos entre consultas.
- **MOC 7.0, Anexo I, item 4.4.1:** 107 Serviço em Operação; 108 Paralisado Momentaneamente; 109 Paralisado sem Previsão.
- **Schemas:** `consStatServ_v4.00.xsd`, `retConsStatServ_v4.00.xsd`, `leiauteConsStatServ_v4.00.xsd` e `tiposBasico_v4.00.xsd` do PL_009q. Versionados em `resources/fiscal/schemas/nfe/4.00-status-pl009q/`, com o zip e o SHA-256 de cada arquivo, conferidos na subida.
- **Endereço:** `https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx`, da relação oficial de webservices de homologação da NFC-e (ENCAT/SVRS).
- **TLS do SVRS:** cadeia ICP-Brasil (AC SERPRO SSLv1 → Raiz Brasileira v10), aceita pelo repositório padrão do Node em 25/11/2026. A verificação nunca é desligada.

## Decisão
1. **Namespace e ação SOAP lidos do WSDL do próprio serviço**, nunca escritos à mão. O WSDL exige o mesmo certificado de cliente: sem ele, o SVRS responde 403.
   - O cliente faz `GET …?wsdl` com mTLS e lê o `targetNamespace` e a **única** `soap12:operation/@soapAction`.
   - Confere também que existe o elemento `nfeDadosMsg`.
   - Mais de uma ação, nenhuma, ou nada de `nfeDadosMsg` dá erro (`WSDL_*`), sem palpite.
2. **Envelope:** SOAP 1.2 sem Header, com `<nfeDadosMsg xmlns="{namespace do WSDL}">` e o `consStatServ` dentro. O `Content-Type` é `application/soap+xml; charset=utf-8; action="{ação do WSDL}"`, como define o SOAP 1.2.
3. **Validação nos dois sentidos:** o `consStatServ` é validado no XSD antes de sair, e o `retConsStatServ` da resposta também. Resposta fora do XSD vira `INVALID`, nunca um status. Um SOAP Fault é reconhecido mesmo com HTTP 500.
4. **Uma tentativa só**, pelo mesmo `sendOnce` do ADR-0022, com a fase da falha (`NOT_SENT`/`UNKNOWN`).
5. **Módulo `nfce`** novo, por enquanto só com `infrastructure/sefaz/status-service.ts` e a fachada `public.ts`.
6. **CLI de teste:** `npm run nfce:test -- status <cert.p12> [--uf 22]`.
   - Só homologação (`tpAmb=2`), e não há URL de produção no código.
   - Senha sem eco, certificado só na memória.
   - A resposta SOAP vai para `.local/nfce-teste/`, fora do git, e nunca para log.
   - Recusa uma nova consulta antes de 3 minutos (MOC 5.5.3), pela data gravada em `.local/nfce-teste/ultima-consulta-status.txt`.

## Consequências
- Ao rodar o CLI com o A1, o responsável descobre de uma vez se o mTLS com o SVRS funciona e se o SVRS atende o PI (cStat 107 = sim; 289 = não).
- O A1 da empresa de teste vence em 26/11/2026: o teste precisa ser feito até lá ou com um certificado novo.
- O catálogo de XSD passa a aceitar `https://www.nfe.fazenda.gov.br/` como origem oficial, além de `https://www.gov.br/`.
- Os testes usam um WSDL e respostas **fictícios** contra um servidor mTLS local. A prova com o SVRS real é o CLI.
