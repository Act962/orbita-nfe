# ADR-0065 — Chave de acesso e perfil de assinatura da NF-e/NFC-e 4.00

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - ADR-0014 (assinatura XMLDSig e perfis por leiaute);
  - ADR-0062, ADR-0063 e ADR-0064 (preparação da NFC-e);
  - regra [CNPJ-001](../fiscal/regras/CNPJ-001.md).
- **Não emite nota.** São peças que a montagem do XML da NFC-e vai usar.

## Contexto
Toda NFC-e tem uma chave de acesso de 44 posições, que identifica a nota, entra no `Id` do `infNFe`, no QR Code e na consulta (ADR-0064). E tem a assinatura XMLDSig do `infNFe`. As duas coisas são definidas em fontes oficiais com detalhe suficiente para fazer agora, sem depender do credenciamento.

## Fontes
- **MOC 7.0, Visão Geral, Tabela 2-1:**
  - composição: `cUF`(2) + `AAMM`(4) + CNPJ(14) + `mod`(2) + `serie`(3) + `nNF`(9) + `tpEmis`(1) + `cNF`(8) + `cDV`(1);
  - DV por módulo 11, pesos 2 a 9 da direita para a esquerda; resto 0 ou 1 dá DV 0;
  - exemplo resolvido (DV 5), usado como teste.
- **NT Conjunta 2025.001, item 5:** com CNPJ alfanumérico, cada caractere da chave vale `ASCII − 48` antes do módulo 11 (dígitos iguais; A = 17, B = 18…). O formato passa a ser `[0-9]{6}[A-Z0-9]{12}[0-9]{26}`.
- **NT 2019.001, regra B03-10 (cStat 897):** o `cNF` não pode ser uma das 20 sequências listadas (`00000000`…`99999999`, `12345678`…`01234567`) nem igual ao `nNF`.
- **MOC 7.0, item 4.2.3:** o `Id` do `infNFe` é a chave precedida de "NFe", e a `Reference` usa `URI="#NFe…"`.
- **MOC 7.0, item 4.2.4 e Tabela 4-2:**
  - XMLDSig *enveloped*;
  - C14N 1.0 (`REC-xml-c14n-20010315`), RSA-SHA1 e SHA-1;
  - exatamente dois transforms, *enveloped-signature* e C14N;
  - **EndCertOnly** (só o certificado do usuário final);
  - sem `X509SubjectName`, `X509IssuerSerial` nem `KeyValue`.

## Decisão
1. **`src/modules/nfce/domain/access-key.ts`**, no domínio, sem I/O:
   - `buildAccessKey` confere cada parte, inclusive o CNPJ pela regra CNPJ-001 e o `cNF` pela B03-10, e devolve a chave, o `Id` e o DV;
   - `isValidAccessKey` confere formato e DV;
   - `isAcceptableNumericCode` existe para quem sortear o `cNF`. O sorteio fica fora do domínio: se o código não passar, sorteia-se de novo.
2. **Perfil `nfe-4.00`** em `SIGNATURE_PROFILES`, com os algoritmos do MOC e `endCertificateOnly`.
   - Como o cofre entrega o PEM com a cadeia, o assinador passa a usar só o primeiro certificado quando o perfil pede.
   - O perfil da NFS-e não muda.
   - Diferente do da NFS-e, que ainda é provisório (R-31), este perfil é **definitivo**, porque o MOC traz os algoritmos.
3. **Só emitente CNPJ por enquanto.** A NFC-e por CPF (NT 2023.002) tem regra própria de série e fica para quando houver necessidade.

## Verificação
- Unitários: o exemplo do MOC, o DV 0, a chave com CNPJ alfanumérico, a B03-10 e os limites de cada campo.
- Integração: um `infNFe` fictício e mínimo foi assinado com um PEM que traz a cadeia. Resultado:
  - sai um único `X509Certificate`, os dois transforms e a `Reference` `#NFe…`;
  - o **xmlsec1** (libxml2 + OpenSSL, implementação independente) aceita a assinatura e recusa o XML adulterado.

## Consequências
- A montagem do XML da NFC-e, depois do credenciamento, já terá chave, `Id` e assinatura prontos e provados.
- A assinatura só será aceita de verdade no primeiro envio à homologação do SVRS. Até lá, a prova é o xmlsec1.
