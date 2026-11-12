import forge from 'node-forge';

/**
 * PKI de TESTE gerada em memória (CA própria + certificado de "empresa fictícia").
 * Nunca usar fora de testes. Não representa a estrutura completa de um certificado ICP-Brasil.
 */
export interface TestIdentity {
  readonly caCertPem: string;
  readonly certPem: string;
  readonly keyPem: string;
}

function serial(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(9)).replace(/^[89a-f]/, '1');
}

function makeCert(
  subjectCn: string,
  publicKey: forge.pki.PublicKey,
  issuer: { cert?: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey },
  opts: { isCa: boolean; validDays: number; usage: 'server' | 'client' | 'ca'; altNames?: string[] },
): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60_000);
  cert.validity.notAfter = new Date(now.getTime() + opts.validDays * 86_400_000);
  const subject = [{ name: 'commonName', value: subjectCn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(subject);
  cert.setIssuer(issuer.cert ? issuer.cert.subject.attributes : subject);
  const extensions: object[] = [{ name: 'basicConstraints', cA: opts.isCa }];
  if (opts.usage === 'ca') extensions.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true });
  else extensions.push({ name: 'keyUsage', digitalSignature: true, keyEncipherment: true, nonRepudiation: true });
  if (opts.usage === 'client') extensions.push({ name: 'extKeyUsage', clientAuth: true, emailProtection: true });
  if (opts.usage === 'server') {
    extensions.push({ name: 'extKeyUsage', serverAuth: true });
    extensions.push({ name: 'subjectAltName', altNames: (opts.altNames ?? ['localhost']).map((v) => (/^\d/.test(v) ? { type: 7, ip: v } : { type: 2, value: v })) });
  }
  cert.setExtensions(extensions);
  cert.sign(issuer.key, forge.md.sha256.create());
  return cert;
}

export interface TestPki {
  readonly ca: TestIdentity;
  readonly client: TestIdentity;
  readonly server: TestIdentity;
  readonly otherCa: TestIdentity;
  pfx(identity: TestIdentity, password: string, algorithm: '3des' | 'aes256'): Buffer;
}

export function createTestPki(): TestPki {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = makeCert('AC TESTE ORBITA NFE', caKeys.publicKey, { key: caKeys.privateKey }, { isCa: true, validDays: 30, usage: 'ca' });
  const caPem = forge.pki.certificateToPem(caCert);

  const issue = (cn: string, usage: 'server' | 'client'): TestIdentity => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = makeCert(cn, keys.publicKey, { cert: caCert, key: caKeys.privateKey }, { isCa: false, validDays: 30, usage, altNames: ['localhost', '127.0.0.1'] });
    return { caCertPem: caPem, certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
  };

  const otherKeys = forge.pki.rsa.generateKeyPair(2048);
  const otherCaCert = makeCert('AC NAO CONFIAVEL', otherKeys.publicKey, { key: otherKeys.privateKey }, { isCa: true, validDays: 30, usage: 'ca' });
  const otherLeafKeys = forge.pki.rsa.generateKeyPair(2048);
  const otherLeaf = makeCert('INTRUSO:99999999000191', otherLeafKeys.publicKey, { cert: otherCaCert, key: otherKeys.privateKey }, { isCa: false, validDays: 30, usage: 'client' });

  return {
    ca: { caCertPem: caPem, certPem: caPem, keyPem: forge.pki.privateKeyToPem(caKeys.privateKey) },
    client: issue('EMPRESA FICTICIA LTDA:11222333000181', 'client'),
    server: issue('localhost', 'server'),
    otherCa: { caCertPem: forge.pki.certificateToPem(otherCaCert), certPem: forge.pki.certificateToPem(otherLeaf), keyPem: forge.pki.privateKeyToPem(otherLeafKeys.privateKey) },
    pfx(identity, password, algorithm) {
      const key = forge.pki.privateKeyFromPem(identity.keyPem);
      const cert = forge.pki.certificateFromPem(identity.certPem);
      const ca = forge.pki.certificateFromPem(identity.caCertPem);
      const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert, ca], password, { algorithm, friendlyName: 'teste' });
      return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
    },
  };
}
