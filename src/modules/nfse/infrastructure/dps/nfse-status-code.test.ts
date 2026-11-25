import { describe, expect, it } from 'vitest';
import { nfseStatusDescription } from '../../domain/nfse-status.js';
import { nfseStatusCode } from './nfse-status-code.js';

const NS = 'http://www.sped.fazenda.gov.br/nfse';

describe('cStat da NFS-e gerada (ADR-0054)', () => {
  it('lê o cStat filho direto de infNFSe, no namespace da NFS-e Nacional', () => {
    expect(nfseStatusCode(`<NFSe xmlns="${NS}" versao="1.01"><infNFSe Id="NFS1"><nNFSe>1</nNFSe><cStat>107</cStat><dhProc>x</dhProc></infNFSe></NFSe>`)).toBe('107');
  });

  it('sem infNFSe, sem cStat, fora do namespace, valor fora do formato ou XML ilegível → null', () => {
    expect(nfseStatusCode('<NFSeSimulada dps="x"/>')).toBeNull();
    expect(nfseStatusCode(`<NFSe xmlns="${NS}"><infNFSe><nNFSe>1</nNFSe></infNFSe></NFSe>`)).toBeNull();
    expect(nfseStatusCode('<NFSe><infNFSe><cStat>100</cStat></infNFSe></NFSe>')).toBeNull();
    expect(nfseStatusCode(`<NFSe xmlns="${NS}"><infNFSe><cStat>abc</cStat></infNFSe></NFSe>`)).toBeNull();
    expect(nfseStatusCode('<NFSe')).toBeNull();
  });

  it('não confunde com um cStat aninhado mais abaixo', () => {
    expect(nfseStatusCode(`<NFSe xmlns="${NS}"><infNFSe><DPS><infDPS><cStat>999</cStat></infDPS></DPS></infNFSe></NFSe>`)).toBeNull();
  });

  it('descrições só as do XSD (TStat); código fora da lista fica sem descrição', () => {
    expect(nfseStatusDescription('100')).toBe('NFS-e Gerada');
    expect(nfseStatusDescription('102')).toBe('NFS-e de Decisão Judicial');
    expect(nfseStatusDescription('103')).toBe('NFS-e Avulsa');
    expect(nfseStatusDescription('107')).toBe('NFS-e MEI');
    expect(nfseStatusDescription('101')).toBeNull();
  });
});
