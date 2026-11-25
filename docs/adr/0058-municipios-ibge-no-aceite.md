# ADR-0058 — Códigos de município conferidos na tabela do IBGE no aceite

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - ADR-0037 (regras do Anexo I no aceite) e o catálogo [NFSE-DPS](../fiscal/regras/NFSE-DPS.md);
  - ADR-0057 (a tabela de municípios do IBGE versionada);
  - doc 16, item A15.

## Contexto
Até aqui o motor só conferia o formato do código de município (7 dígitos, `TSCodMunIBGE`), e a existência ficava com o autorizador. O critério do ADR-0037 deixava de fora as regras "que dependem de tabelas que o motor não tem". Com o ADR-0057, a tabela oficial do IBGE passou a fazer parte do projeto, com hash conferido.

O Anexo I traz, com o mesmo texto e nos dois ambientes (produção, v1.01 de 09/02/2026, e produção restrita, v1.01 de 20/10/2026):
- **E0238:** "O código do município informado para o endereço do tomador do serviço não existe, conforme tabela de municípios do IBGE."
- **E0294:** a mesma regra para o endereço do intermediário.
- **E0302:** para `cLocPrestacao`, "Se informado, o código do município deve existir na tabela de municípios do IBGE ou possuir a codificação 0000000, que representa 'Águas Marítimas'."

## Decisão
1. **As três regras entram no catálogo NFSE-DPS** e são conferidas no aceite e na validação sem efeitos, antes de numerar. A violação dá `422 NFSE_RULES_VIOLATED`, com o código do Anexo em `issues[].code`.
2. **`0000000` continua aceito no local da prestação**, como diz a E0302. A E1402 (`cTribNac` 200101 com "Águas Marítimas") segue como antes.
3. **Endereço no exterior e prestação no exterior não consultam a tabela:** são outras regras (E0246, E0299, E0304), que continuam como estão.
4. **A tabela é injetada no domínio como uma consulta** (`municipalityExists`). Sem ela, as três regras ficam com o autorizador, como antes, e o domínio não depende de arquivo.
5. **Fica de fora o município do estabelecimento (`cLocEmi`).**
   - O Anexo diz que o `cLocEmi` pode ser um município do IBGE "ou um trecho de concessão de exploração de rodovia", que vem de outra tabela que o motor não tem.
   - A regra dele é a E0037, que consulta o cadastro de convênio, não o IBGE.
   - O cadastro do estabelecimento continua conferindo só o formato.

## Consequências
- Um código inexistente é recusado localmente, sem consumir número, em vez de virar uma rejeição E0238, E0294 ou E0302 no autorizador.
- **Risco (registrado):** o Anexo cita a tabela do "ANEXO_A-MUNICIPIO_IBGE-PAISES_ISO2-SNNFSe", e o motor usa a API de localidades do IBGE. Se a tabela do Sistema Nacional atrasar em relação ao IBGE (município novo), a nota passa aqui e é rejeitada lá, como antes. No caso oposto, um código que só exista no ANEXO_A seria recusado aqui. Trocar pela tabela do ANEXO_A, que também traz os países ISO2 das regras E0246, E0299 e E0304, fica como próxima etapa, quando o arquivo for baixado e registrado.
