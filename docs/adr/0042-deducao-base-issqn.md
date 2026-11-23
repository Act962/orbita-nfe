# ADR-0042 — Dedução/redução da base de cálculo do ISSQN

- Status: **Aceito** · Data: 2026-11-16
- Relacionados:
  - ADR-0018 (o motor não decide a tributação);
  - ADR-0037 (regras do Anexo I no aceite);
  - ADR-0041 (descontos e tributos federais);
  - R-45.

## Contexto
O ADR-0041 adiou as deduções porque o grupo muda entre os pacotes do leiaute (R-45):

| Pacote | Grupo em `TCInfoValores` | Conteúdo |
|---|---|---|
| Produção, 09/02/2026 (também o da DSF, ADR-0039) | `vDedRed` (`TCInfoDedRed`) | choice obrigatória: `pDR` (TSDec3V2) \| `vDR` (TSDec15V2) \| `documentos` |
| Produção restrita, 20/10/2026 | `vAjusteBC` (`TCInfoAjusteBC`) | choice opcional: `pAjusteBCISSQN` (TSDec3V2) \| `vAjusteBCISSQN` (TSDec15V2), seguida de `documentos?` com tipos novos ligados ao IBS/CBS |

Nos dois pacotes o grupo vem logo depois de `vDescCondIncond`.

## Fontes
- XSD v1.01 dos dois pacotes (`tiposComplexos_v1.01.xsd`).
- Anexo I, aba "RN DPS_NFS-e", dos dois ambientes. Hashes em [fontes oficiais](../fiscal/fontes-oficiais.md).
  - Os dois descrevem o grupo como dedução/redução considerada só na base do ISSQN.
  - **Produção:** "As três opções para informação de Dedução/Redução, caso exista, são: Valor, Percentual ou Documento".
  - **Produção restrita:** "As três opções para informação de Ajuste (Dedução/Redução), caso exista, são: Valor, Percentual ou Documento".
  - As regras do grupo têm os mesmos códigos nos dois (E0435, E0436, E0453).

## Decisão
1. **Contrato:** campo opcional `values.deduction`:
   - `{ kind: 'PERCENTAGE', rate }` → `pDR` / `pAjusteBCISSQN`;
   - `{ kind: 'AMOUNT', amount }` → `vDR` / `vAjusteBCISSQN`.
   - O valor é do contribuinte. O motor não calcula a dedução nem decide se o serviço a admite: isso é parametrização do município, conferida pelo autorizador (E0440, E0446, E0449, E0454).
2. **XML:** o perfil de leiaute de cada pacote diz o nome do grupo e dos elementos. A nota é montada no pacote do autorizador do canal, então a mesma requisição vira `vDedRed` na DSF e `vAjusteBC` na produção restrita da SEFIN. Validado nos dois XSD.
3. **Dedução por documentos fica de fora.** Os tipos de documento e as regras (E0437, E0462, E0463, as exceções 101 a 199) mudaram muito entre os pacotes e dependem do IBS/CBS.
4. **Regras do aceite** ([NFSE-DPS](../fiscal/regras/NFSE-DPS.md)):
   - **E0435** (os dois): sem dedução com `tribISSQN` 2, 3 ou 4.
     - O texto da produção termina com "ou seja, tpRetISSQN tem que ser igual a 1", em contradição com a condição e com a mensagem. O motor segue a condição e a mensagem (`tribISSQN`), que são iguais às da produção restrita.
     - As exceções da produção restrita só valem para documentos, que o contrato não tem.
   - **E0436** (os dois): sem dedução para MEI.
   - **E0438** (produção): sem dedução com `regEspTrib` diferente de 0.
   - **E0445** (produção restrita): sem ajuste com `regEspTrib` de 1 a 6. O texto lista 1 a 6, sem o 9; na dúvida, o motor confere menos.
   - **E0453** (os dois): percentual maior que 0 e até 100%.
   - **E0427** (os dois): valor do serviço ≥ desconto incondicionado + valor da dedução.
     - O benefício municipal não existe no contrato, então a soma fica completa.
     - A dedução por percentual não entra, porque com a E0453 ela nunca passa do serviço já descontado.
5. **Fora do aceite**, com o motivo no catálogo:
   - **E0441/E0442 (produção) e E0451, E0452 e E0455 (produção restrita):** ME/EPP apurando pelo Simples. O código de rejeição depende da situação do convênio do município, que o motor não tem.
   - **E0440 (produção) e E0449/E0450 (produção restrita):** dependem da situação do convênio e da parametrização do código de serviço no município.
   - **E0444/E0447:** a alíquota efetiva mínima de 2% depende do ISSQN calculado pelo autorizador.
   - **E0439/E0448:** dependem do benefício municipal, que não existe no contrato.

## Consequências
- A nota com dedução por percentual ou por valor passa a ser aceita e montada no grupo certo de cada pacote.
- Quando a produção adotar o pacote novo, basta trocar o perfil de leiaute: o contrato não muda. **R-45 fica mitigado**; resta a dedução por documentos.
- Ficam para depois: dedução por documentos, tomador no exterior, benefício municipal, exigibilidade suspensa e IBS/CBS.
