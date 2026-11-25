# ADR-0057 — DANFSe (representação impressa da NFS-e)

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - roadmap, Fase 2a item 4 ("DANFSe conforme padrão");
  - ADR-0050 (download do XML);
  - ADR-0052 (links no corpo da nota);
  - doc 16, itens A11 (links de arquivos) e A15 (tabela de municípios do IBGE);
  - R-45 (nomes de campo diferentes entre produção e produção restrita).

## Contexto
A NFS-e é o XML. O DANFSe é o documento auxiliar impresso que o cliente entrega ao tomador. A especificação oficial é a **NT 008 SE/CGNFS-e, v1.02, de 14/07/2026** ([fontes oficiais](../fiscal/fontes-oficiais.md); hash conferido em 25/11/2026).

A NT diz que a API de DANFSe do ADN foi suspensa em **03/08/2026**: "a API de geração do DANFSe (…) será sobrestada (suspensa)". O DANFSe passa a ser gerado pelo emissor, a partir do XML autorizado, no leiaute do Anexo I ("DANFSe v2.0").

## Decisão
1. **`GET /v1/service-invoices/{id}/danfse`**, escopo `nfse:read`.
   - Devolve `application/pdf` com uma página A4, gerada na hora a partir do XML autorizado gravado. O hash do XML é conferido antes, como no download do ADR-0050.
   - Nada é guardado: o documento fiscal é o XML, e o PDF pode ser refeito a qualquer momento.
   - Vale para a nota `AUTHORIZED`, `CANCELLED` e `SUBSTITUTED`. Antes da autorização, responde `404 NFSE_XML_NOT_AVAILABLE`.
   - Um XML sem o grupo `infNFSe` dá `422 DANFSE_NOT_AVAILABLE`, e o XML continua disponível.
   - O link `links.danfse` entra no corpo da nota (ADR-0052).
2. **Conteúdo, do XML e de nada mais** (NT, item 2.1):
   - Campos, ordem, prefixos e máscaras da tabela do item 2.4.5. Isso inclui CNPJ/CPF, CEP, `nn.nn.nn / nnn` do código de tributação, `n.nnnn.nn.nn` da NBS e datas `DD/MM/AAAA hh:mm:ss`.
   - Texto maior que o campo é cortado com reticências (item 2.1). Campo sem dado no XML sai com traço (nota 12).
   - Opções codificadas saem com a descrição do leiaute. Fonte: a anotação dos tipos simples do XSD, igual nos dois pacotes (`danfse-catalog.ts`). Código desconhecido sai como veio; nada é deduzido.
   - Blocos sem dados (tomador, destinatário, intermediário) recebem as frases das notas 2 e 3. `indDest = 0` produz "O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO".
   - Contribuições sociais retidas: com `tpRetPisCofins = 1`, CSLL + PIS + COFINS, e o débito de apuração própria sai zerado. Nos demais casos, só a CSLL (item 2.4.5, v1.02).
   - A linha de PIS/COFINS de apuração própria só sai para competência até 31/12/2026 (nota 6).
   - A linha de totais aproximados dos tributos (Lei 12.741/2012) é obrigatória (nota 10), em valor ou percentual, como o XML trouxer.
   - Município pelo código IBGE: nome e UF pela tabela oficial do IBGE (item 7).
   - QR Code com `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=` + chave de acesso, 1,52 × 1,52 cm em X 17,48 / Y 1,67 cm, e o texto de autenticidade em 3 linhas (item 2.4.3).
3. **Situação e ambiente:**
   - A nota de teste (`tpAmb = 2`) traz "NFS-e SEM VALIDADE JURÍDICA" em vermelho no cabeçalho (item 2.4.3).
   - Nota cancelada ou substituída leva a marca d'água "CANCELADA" ou "SUBSTITUÍDA", na diagonal, cinza K35, acima de 50 pt (itens 2.5.1 e 2.5.2).
   - A marca d'água vem da situação **atual** da nota no motor, porque o XML autorizado não muda com o evento.
4. **Formulário** (itens 2.2 e 2.4):
   - A4 retrato, página única, borda de 1 pt e divisórias de 0,5 pt.
   - Cinza 5% no cabeçalho, nos títulos de bloco, em "Emitente da NFS-e" e em "Valor Líquido da NFS-e + IBS/CBS".
   - Títulos de bloco em 7 pt negrito e caixa alta; títulos de campo em 6 pt negrito; conteúdo em 7 pt.
   - O canhoto, opcional (nota 11), não é impresso. A área dele vai para as informações complementares (item 2.3.3).
   - **Correção de 25/11/2026:** "Ambiente Gerador" e "Tipo de Ambiente" passam a sair com o código (`Ambiente Gerador: 2`, `Tipo de Ambiente: 1`). A tabela da NT dá tamanho 1 aos dois campos, e o DANFSe de produção do emissor nacional, recebido do responsável, imprime assim. Antes, o motor imprimia a descrição do XSD.
5. **Desvios conscientes, decididos pelo responsável em 25/11/2026:**
   - **Fonte:** a NT pede Arial nos títulos e Microsoft Sans Serif no conteúdo. As duas são proprietárias e não podem ir no repositório nem na imagem. Usamos a **Helvetica**, fonte-base do PDF (não embutida), com as mesmas medidas da Arial. Caractere fora do WinAnsi sai como "?".
   - **Tamanhos:** a NT trata posições e tamanhos como mínimos e diz que não são obrigatórios (item 2.1). "Descrição do Serviço" cresce para caber, e os blocos seguintes descem.
     - Algumas larguras foram juntadas para não deixar coluna vazia: o Simples Nacional, o documento do destinatário e o tipo de tributação do ISSQN, que na tabela coincide com o título do bloco.
     - As faixas das notas 2 e 3 têm 0,40 cm (mínimo 0,32 cm), para o texto não tocar nas linhas.
   - **Títulos de campo:** escritos como na tabela da NT, com siglas em maiúsculas (CNPJ, IBGE, ISSQN). A regra "primeira letra de cada palavra maiúscula" não é aplicada a siglas e preposições.
   - **Valores** com "R$ 1.234,56" e percentuais com "5,00%". A NT só dá o tipo do campo (15 posições, 2 decimais).
6. **Recursos oficiais versionados, com hash conferido na subida** (como os XSD, ADR-0013):
   - `resources/fiscal/danfse/`: a logomarca da NFS-e indicada no item 2.4.3, mais o `MANIFEST.json` com a NT 008.
   - `resources/fiscal/ibge/municipios-2026-11-25.json`, gerado por `scripts/ibge-municipios.mjs` a partir da API de localidades do IBGE (5.571 municípios), mais o `MANIFEST.json`. Arquivo alterado impede a API de subir.
7. **Leiaute de produção × produção restrita (R-45):** a NT cita `vDR`, `vCalcDR` e `vCalcReeRepRes`, e o pacote de produção restrita usa `vCalcAjusteBCISSQN`. O DANFSe lê o primeiro nome que existir no XML.
8. **Dependências novas** (MIT, ADR-0023): `pdf-lib` 1.17.1 (PDF) e `qrcode` 1.5.4 (matriz do QR Code, desenhada como vetor).

## Consequências
- O cliente imprime ou envia o DANFSe sem depender da API do ADN, que foi suspensa.
- A tabela do IBGE fica disponível para a validação de `municipalityCode` (A15), que continua sendo uma etapa à parte.
- O simulador passou a devolver o grupo `infNFSe` com a DPS assinada embutida, como o leiaute, e o DANFSe sai completo no sandbox. Os nomes de município e as descrições do simulador são marcados como "simulado".
- **Pendências:**
  - a NT promete outra nota técnica para os "novos fatos geradores" do IBS/CBS (item 1);
  - com `indTotTrib` ou `pTotTribSN`, a linha de totais aproximados sai com traços, porque a nota 10 só prevê valor ou percentual. Isso vai para a revisão do especialista;
  - conferir o DANFSe de uma NFS-e real assim que os bloqueios R-43 e R-44 caírem.
