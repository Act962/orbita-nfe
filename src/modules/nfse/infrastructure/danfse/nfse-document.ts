import type { Element } from '@xmldom/xmldom';
import { parseUntrustedXml } from '../../../../shared/infrastructure/xml/untrusted-xml.js';

const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';

/**
 * Leitura do XML da NFS-e para o DANFSe (ADR-0057). Só navega no XML que o autorizador devolveu e
 * que o motor gravou: o DANFSe "não poderá imprimir informações que não constem do arquivo da
 * NFS-e" (NT 008 v1.02, item 2.1). Valor ausente vira `undefined`, e quem monta o DANFSe imprime "-".
 */
export class NfseNode {
  private constructor(private readonly element: Element | undefined) {}

  static empty(): NfseNode {
    return new NfseNode(undefined);
  }

  static of(element: Element): NfseNode {
    return new NfseNode(element);
  }

  get exists(): boolean {
    return this.element !== undefined;
  }

  /** Caminho de filhos diretos no namespace da NFS-e (ex.: `at('end', 'endNac')`). */
  at(...path: string[]): NfseNode {
    let current = this.element;
    for (const name of path) {
      current = current === undefined ? undefined : childOf(current, name);
    }
    return new NfseNode(current);
  }

  /** Todos os filhos diretos com o nome (ex.: os itens de pedido). */
  all(name: string): NfseNode[] {
    const found: NfseNode[] = [];
    if (this.element === undefined) return found;
    for (let node = this.element.firstChild; node !== null; node = node.nextSibling) {
      if (node.nodeType === 1 && (node as Element).localName === name && (node as Element).namespaceURI === NFSE_NS) found.push(new NfseNode(node as Element));
    }
    return found;
  }

  /** Texto do caminho, sem espaços nas pontas; vazio vira `undefined`. */
  text(...path: string[]): string | undefined {
    const target = this.at(...path).element;
    const value = target?.textContent?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  attribute(name: string): string | undefined {
    const value = this.element?.getAttribute(name)?.trim();
    return value === undefined || value === '' ? undefined : value;
  }
}

export class NfseDocumentError extends Error {
  constructor(readonly code: 'NFSE_XML_UNREADABLE' | 'NFSE_INFO_MISSING') {
    super(code);
    this.name = 'NfseDocumentError';
  }
}

/** `infNFSe` e a `infDPS` embutida. O XML é o gravado na autorização (hash já conferido). */
export interface NfseDocument {
  readonly info: NfseNode;
  readonly dps: NfseNode;
}

export function readNfseDocument(nfseXml: string): NfseDocument {
  let root: Element;
  try {
    root = parseUntrustedXml(nfseXml).documentElement as Element;
  } catch {
    throw new NfseDocumentError('NFSE_XML_UNREADABLE');
  }
  // Raiz oficial `NFSe` (TCNFSe); o simulador embrulha o mesmo `infNFSe` em outra raiz.
  const info = childOf(root, 'infNFSe');
  if (info === undefined) throw new NfseDocumentError('NFSE_INFO_MISSING');
  const node = NfseNode.of(info);
  return { info: node, dps: node.at('DPS', 'infDPS') };
}

function childOf(parent: Element, name: string): Element | undefined {
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as Element).localName === name && (node as Element).namespaceURI === NFSE_NS) return node as Element;
  }
  return undefined;
}
