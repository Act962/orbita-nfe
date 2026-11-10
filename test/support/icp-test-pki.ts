import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

/**
 * PKI de TESTE no formato usado pela ICP-Brasil para e-CNPJ: AC raiz → AC intermediária →
 * certificado da empresa com o CNPJ no otherName 2.16.76.1.3.3 do SubjectAltName (DOC-ICP-04).
 * Tudo fictício e gerado em memória. Nunca usar fora de testes.
 */
export interface TestAuthority {
  readonly certPem: string;
  readonly cert: forge.pki.Certificate;
  readonly key: forge.pki.rsa.PrivateKey;
}

export interface LeafOptions {
  /** CNPJ no otherName; null = sem o OID (certificado que não é de PJ). */
  readonly cnpj: string | null;
  readonly issuer?: TestAuthority;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
  readonly digitalSignature?: boolean;
  /** Formato do valor do otherName (as ACs usam OCTET STRING; algumas, texto). */
  readonly cnpjEncoding?: 'octet' | 'printable';
}

export interface TestPfxOptions {
  readonly password: string;
  readonly algorithm?: '3des' | 'aes256';
  /** Inclui a AC intermediária no PFX (padrão: sim). */
  readonly includeChain?: boolean;
}

const OID_CNPJ = '2.16.76.1.3.3';
const OID_RESPONSAVEL = '2.16.76.1.3.2';

function rsaKeys(): { publicKey: forge.pki.rsa.PublicKey; privateKey: forge.pki.rsa.PrivateKey } {
  // node:crypto gera rápido; o forge só monta e assina os certificados.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: forge.pki.publicKeyFromPem(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    privateKey: forge.pki.privateKeyFromPem(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
  };
}

let serialCounter = 0x1000;
// INTEGER DER mínimo: sem zeros à esquerda (o OpenSSL recusa com "illegal padding").
const nextSerial = (): string => (serialCounter++).toString(16);

function authority(cn: string, issuer?: TestAuthority): TestAuthority {
  const keys = rsaKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = nextSerial();
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86_400_000);
  const subject = [{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'ICP-Teste' }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(subject);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(issuer?.key ?? keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), cert, key: keys.privateKey };
}

function otherName(oid: string, value: string, encoding: 'octet' | 'printable'): forge.asn1.Asn1 {
  const { asn1 } = forge;
  // [0] nos dois níveis do otherName (RFC 5280: otherName [0] e value [0] EXPLICIT).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- tag de contexto [0] não existe no enum Type do forge
  const tag0 = 0 as forge.asn1.Type;
  const inner = asn1.create(asn1.Class.UNIVERSAL, encoding === 'octet' ? asn1.Type.OCTETSTRING : asn1.Type.PRINTABLESTRING, false, value);
  return asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag0, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oid).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag0, true, [inner]),
  ]);
}

export interface TestIcpPki {
  readonly root: TestAuthority;
  readonly intermediate: TestAuthority;
  /** AC fora do bundle confiável. */
  readonly untrustedRoot: TestAuthority;
  /** Bundle confiável (só a raiz). */
  readonly trustBundlePem: string;
  leaf(options: LeafOptions): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey; issuer: TestAuthority };
  pfx(options: LeafOptions & TestPfxOptions): Buffer;
}

export function createTestIcpPki(): TestIcpPki {
  const root = authority('AC RAIZ TESTE ORBITA');
  const intermediate = authority('AC INTERMEDIARIA TESTE ORBITA', root);
  const untrustedRoot = authority('AC NAO CONFIAVEL');

  const leaf: TestIcpPki['leaf'] = (options) => {
    const issuer = options.issuer ?? intermediate;
    const keys = rsaKeys();
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = nextSerial();
    cert.validity.notBefore = options.notBefore ?? new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * 86_400_000);
    cert.setSubject([
      { name: 'commonName', value: `EMPRESA FICTICIA LTDA:${options.cnpj ?? 'SEM-CNPJ'}` },
      { name: 'organizationName', value: 'ICP-Teste' },
      { name: 'countryName', value: 'BR' },
    ]);
    cert.setIssuer(issuer.cert.subject.attributes);

    const altNames = [otherName(OID_RESPONSAVEL, 'RESPONSAVEL FICTICIO', 'octet')];
    if (options.cnpj !== null) altNames.push(otherName(OID_CNPJ, options.cnpj, options.cnpjEncoding ?? 'octet'));
    const san = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, altNames);

    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: options.digitalSignature ?? true, nonRepudiation: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', clientAuth: true, emailProtection: true },
      { id: '2.5.29.17', name: 'subjectAltName', critical: false, value: forge.asn1.toDer(san).getBytes() },
    ]);
    cert.sign(issuer.key, forge.md.sha256.create());
    return { cert, key: keys.privateKey, issuer };
  };

  return {
    root,
    intermediate,
    untrustedRoot,
    trustBundlePem: root.certPem,
    leaf,
    pfx(options) {
      const { cert, key, issuer } = leaf(options);
      const chain = options.includeChain === false ? [cert] : [cert, issuer.cert];
      const asn1 = forge.pkcs12.toPkcs12Asn1(key, chain, options.password, { algorithm: options.algorithm ?? 'aes256', friendlyName: 'teste' });
      return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
    },
  };
}
