# ADR-0067 — Contingência off-line da NFC-e (tpEmis = 9)

- Status: **Proposto** · Data: 2026-11-25. Aceito quando o responsável decidir os itens marcados "Decisão do responsável".
- Relacionados:
  - ADR-0062 (só autorização síncrona);
  - ADR-0064 (consulta pela chave);
  - ADR-0065 (chave e assinatura);
  - ADR-0066 (QR Code off-line);
  - ADR-0029 e ADR-0032 (reconciliação de `UNKNOWN`);
  - roadmap: Fase 3b, contingência local no NERP.
- O roadmap exigia ler o MOC antes de decidir a contingência. Este ADR é essa leitura.

## Fontes
- **MOC 7.0, Anexo IV**, "Padrões Técnicos de Contingência Off-line NFC-e" (nov. 2020), e o **Manual de Especificações da Contingência Off-line da NFC-e v2.0** (dez. 2016). Os dois têm o mesmo conteúdo e estão baixados com hash em [fontes oficiais](../fiscal/fontes-oficiais.md).
- **Anexo I:**
  - B22-20 (712): a UF pode não aceitar a contingência off-line;
  - B22-34 (714): EPEC na NFC-e, só a critério da UF;
  - B28-10/B28-20 (556/557): `dhCont` e `xJust` só e sempre em contingência;
  - B09-40 (704): fora da contingência, emissão com mais de 5 minutos de atraso é recusada; mais de 24 h depois, a NFC-e volta com cStat 150 "autorizado fora de prazo".
- **NT 2026.002 v1.11 (QR Code 3):** ZX02-330 (445) e ZX02-334 (474): a assinatura só pode vir, e precisa vir, quando `tpEmis=9`.

## O que as fontes dizem
1. **Quem decide.** A entrada em contingência é **decisão exclusiva do contribuinte**, sem autorização prévia nem termo de início ou fim. A possibilidade de usar a off-line é **decisão da UF**, que pode negar a todos ou a alguns (712).
2. **Exceção, não regra.** O Fisco pode restringir a contingência a quem a usa "em demasia e sem justificativa".
3. **Prazo.** A NFC-e deve ser transmitida **até o fim do primeiro dia útil seguinte** à emissão. Uma autorização depois de 24 h volta com cStat 150.
4. **XML da nota em contingência:**
   - `tpEmis=9`, `dhCont` e `xJust` obrigatórios (557);
   - `idDest=1`, `finNFe=1`, `indFinal=1`, `indPres=1`;
   - sem série especial;
   - **a mesma chave e o mesmo `cNF`** na transmissão posterior.
5. **Numeração.** A recomendação é **avançar um número** ao entrar em contingência. É **vedado reutilizar** em contingência o número de uma NFC-e já transmitida como normal. Na nota normal que ficou sem resposta (o "nº 20" do exemplo):
   - se foi autorizada, **cancela-se**;
   - se não foi, **inutiliza-se** o número.
6. **Rejeição na transmissão posterior.** Gera-se de novo o arquivo **com a mesma série e o mesmo número**, corrigindo o erro.
7. **DANFE.**
   - Mensagem "EMITIDA EM CONTINGÊNCIA" e Detalhe da Venda impresso.
   - **Segunda via ("Via do Estabelecimento")** à disposição do Fisco até a autorização, ou, como alternativa, a **guarda eletrônica do XML**. Esta exige termo no livro modelo 6 ou declaração na forma da UF.
8. **QR Code off-line.** Na 2.00 entram dia, vNF e digVal; na 3.00, dia, vNF, destinatário e assinatura. As duas já estão implementadas (ADR-0066).

## Proposta
- **A. Onde a contingência acontece.**
  - O motor central (VPS) só ajuda quando **o motor está no ar e a SEFAZ não**.
  - Quando o PDV perde a internet, só o NERP local resolve: é a Fase 3b, que o responsável deixou para depois da NFC-e validada.
  - **Decisão do responsável:** o motor central também emite em contingência na Fase 3, ou a contingência fica toda para a Fase 3b?
- **B. Entrada só com pedido do cliente.** Se o motor emitir em contingência, ele **não entra sozinho**, porque a decisão é do contribuinte. Ele precisa de duas coisas ao mesmo tempo:
  1. a contingência **habilitada no estabelecimento**, como configuração auditada;
  2. o pedido explícito na emissão, com a justificativa (`xJust`) informada pelo cliente.

  Sem isso, a falha de comunicação segue o fluxo atual, com `NOT_SENT` ou `UNKNOWN` e reconciliação.
- **C. Número novo, sempre.** A nota em contingência sempre recebe número novo da série, mesmo quando a anterior falhou com `NOT_SENT`. Isso cumpre a vedação do item 5 sem precisar provar que nada saiu. A nota anterior continua no reconciliador:
  - consulta pela chave (ADR-0064);
  - se a consulta mostrar a nota autorizada, ela é **cancelada**;
  - se estiver provado que não existe, o número é **inutilizado** (serviço `NfeInutilizacao4`, ainda a implementar).

  Nenhum desses passos é automático sem a prova dupla da ADR-0029.
- **D. Transmissão posterior.** Uma fila própria transmite a nota em contingência, com a **mesma chave e os mesmos bytes**, assim que o status do serviço (ADR-0063) voltar a 107. Ela também avisa o cliente quando o prazo (fim do primeiro dia útil seguinte) se aproxima. Uma rejeição volta ao cliente para correção, com a mesma série e o mesmo número.
- **E. Guarda.** O XML em contingência já vai para o armazenamento imutável (ADR-0048), o que atende à "guarda eletrônica em local seguro".
  - **Decisão do responsável, com o contador:** usar a guarda eletrônica no lugar da segunda via, que exige termo ou declaração na SEFAZ-PI.
- **F. Indicador de uso.** Contar as notas em contingência por estabelecimento e por dia, porque o Fisco pode restringir o uso excessivo.

## A confirmar com a SEFAZ-PI
- O Piauí aceita a contingência off-line (`tpEmis=9`) e para quais contribuintes (regra B22-20)?
- O Piauí aceita o EPEC na NFC-e (B22-34)? Pela proposta, não usamos EPEC.
- O Piauí dispensa a segunda via, e qual é a forma da declaração de guarda eletrônica?

## Consequências
- Nada de contingência é implementado antes das decisões e das respostas acima.
- O que já existe serve às duas opções de A: chave, assinatura, QR Code off-line, consulta e status.
- O serviço de **inutilização** passa a ser necessário de qualquer forma, por causa do item 5. O schema já está no PL_010d (ADR-0062).
