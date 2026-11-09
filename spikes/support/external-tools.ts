import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Ferramentas externas usadas SOMENTE nos testes de spike, com material de teste.
 * (Em produção é proibido passar segredos por processos externos — docs/architecture/13.)
 */
export function hasDocker(): boolean {
  return spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
}

export function hasOpenssl(): boolean {
  return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
}

export function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orbita-spike-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Verifica a assinatura com xmlsec1 (implementação independente, libxml2 + OpenSSL). */
export function xmlsec1Verify(signedXml: string, caPem: string, idAttr: { element: string; namespace: string }): { ok: boolean; output: string } {
  return withTempDir((dir) => {
    writeFileSync(join(dir, 'signed.xml'), signedXml);
    writeFileSync(join(dir, 'ca.pem'), caPem);
    const script = `apk add -q xmlsec >/dev/null 2>&1 && xmlsec1 --verify --trusted-pem /w/ca.pem --id-attr:Id ${idAttr.namespace}:${idAttr.element} /w/signed.xml`;
    const result = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/w:ro`, 'alpine:3.22', 'sh', '-c', script], { encoding: 'utf8' });
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  });
}

/** Gera um PFX com o OpenSSL instalado (formato legado RC2/3DES ou padrão moderno). */
export function opensslPfx(keyPem: string, certPem: string, password: string, legacy: boolean): Buffer {
  return withTempDir((dir) => {
    writeFileSync(join(dir, 'k.pem'), keyPem);
    writeFileSync(join(dir, 'c.pem'), certPem);
    const out = join(dir, 'out.pfx');
    const args = ['pkcs12', '-export', '-inkey', join(dir, 'k.pem'), '-in', join(dir, 'c.pem'), '-out', out, '-passout', `pass:${password}`];
    if (legacy) args.push('-legacy');
    execFileSync('openssl', args, { stdio: 'pipe' });
    return readFileSync(out);
  });
}
