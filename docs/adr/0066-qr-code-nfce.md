# ADR-0066 — URL do QR Code da NFC-e (versões 2.00 e 3.00)

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - ADR-0065 (chave de acesso e assinatura);
  - [diagnóstico da NFC-e no PI](../fiscal/nfce-piaui-diagnostico.md), item "QR Code e CSC";
  - ADR-0027 (o CSC é segredo, como o certificado).
- **Não emite nota.** A escolha entre 2.00 e 3.00 continua sendo do responsável, com o contador.

## Contexto
A NFC-e leva no XML (`infNFeSupl/qrCode`) e no DANFE a URL de consulta pelo QR Code. O manual oficial tem duas versões:
- **2.00:** hash com o CSC, um código de segurança que a SEFAZ fornece;
- **3.00:** sem CSC. Na contingência off-line, os parâmetros são assinados com o certificado.

Implementamos as duas, para que a escolha não atrase a montagem da nota.

## Fontes
- **Manual de Especificações Técnicas do DANFE NFC-e e QR Code, v6.0** (março de 2025), baixado com hash em [fontes oficiais](../fiscal/fontes-oficiais.md):
  - 4.3.1/4.3.2: parâmetros da 2.00, online (`chave|2|tpAmb|idCSC|hash`) e off-line (`chave|2|tpAmb|dia|vNF|digVal|idCSC|hash`);
  - 4.3.3 a 4.3.5: hash = SHA-1 em hexadecimal de 40 posições, sobre os parâmetros unidos por "|", com o CSC acrescentado sem separador. No off-line, o `digVal` entra como o hexadecimal **dos caracteres Base64** do DigestValue. O CSC é alfanumérico, de 16 a 36 posições;
  - 4.3.6.1/4.3.6.2: exemplos resolvidos, usados como teste (hashes `DC6AE2C2…` e `4615A93B…`);
  - 4.4.1/4.4.2: 3.00 online (`chave|3|tpAmb`) e off-line (`chave|3|tpAmb|dia|vNF|tpIdDest|idDest|assinatura`). A assinatura é RSA-SHA1 em Base64 dos parâmetros 1 a 7 com os separadores, com o certificado da NFC-e. Destinatário não identificado ou estrangeiro deixa o campo vazio;
  - 4.5.2/4.5.3: correção de erro nível M e UTF-8, para a imagem, que entra com o DANFE NFC-e.
- **Endereço do PI:** `http://www.sefaz.pi.gov.br/nfce/qrcode`, o mesmo em produção e homologação, da lista oficial do ENCAT.

## Achados no manual
- **As chaves dos exemplos do manual têm DV inválido.** São hipotéticas: o DV calculado é 8 e 3, e o impresso é 4. Já o exemplo do MOC confere (DV 5).
- **O CSC dos exemplos tem 41 caracteres e hífens**, fora da regra do próprio manual (alfanumérico, 16 a 36).

Por isso o hash (`hashWithCsc`) é conferido com os exemplos à parte. A URL só é montada com chave válida e CSC no formato do manual.

## Decisão
1. **`src/modules/nfce/infrastructure/qrcode/qr-code-url.ts`**, com uma função por caso:
   - `qrCodeV2Online` e `qrCodeV2Offline`;
   - `qrCodeV3Online` e `qrCodeV3Offline`.

   Cada uma confere a chave (formato e DV), o dia, o valor e o identificador e o formato do CSC. Erros saem como `QrCodeError` com código estável.
2. **O CSC nunca sai:** ele entra só no cálculo do hash, não aparece na URL, não é devolvido e não vai para log. Quando o CSC for usado de verdade, ele vai para o cofre com a mesma proteção do certificado (ADR-0009): cifrado, e só o worker-fiscal decifra.
3. **A imagem do QR Code** (nível M, UTF-8) e o DANFE NFC-e ficam para a etapa do DANFE NFC-e, que reaproveita o `qrcode` já usado no DANFSe.

## Consequências
- Com a escolha do responsável, basta ligar a versão escolhida na montagem do `infNFeSupl`.
- A contingência off-line (`tpEmis=9`) ainda precisa do seu próprio ADR, porque o roadmap exige a leitura do Anexo IV. As funções off-line já estão prontas para ela.
