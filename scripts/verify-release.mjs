// Audit the Git index and the identical working files before publishing source.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
if (git('diff', '--name-only').trim()) throw new Error('Stage all intended changes before the release audit.');
const files = git('ls-files', '-z').split('\0').filter(Boolean);
if (!files.length) throw new Error('No staged/tracked source files.');
const root = /^(?:\.gitignore|\.gitattributes|package\.json|requirements[^/]*\.txt|LICENSE|README\.md|THIRD_PARTY_NOTICES\.md)$/;
const source = /^(?:src|py|test|scripts|docs|materials|\.github)\/.+\.(?:js|mjs|py|ps1|md|json|yml)$/;
const config = /^cordis\.(?:patch|dev)\.yml$/;
const denied = /(?:^|\/)(?:_tmp|__pycache__|node_modules|datasets|pretrain|data|exp|reports|tools|jobs|logs|backup)(?:\/|$)|(?:\.local\.json|_provenance\.json)$/;
const secret = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/;
const personalPath = /[A-Z]:[\\/](?:Users[\\/]|AI-Song[\\/]|Codex[\\/])/i;
const manifest = [];
for (const file of files) {
  if ((!root.test(file) && !source.test(file) && !config.test(file)) || denied.test(file)) throw new Error(`Unexpected publish file: ${file}`);
  const bytes = readFileSync(file);
  if (bytes.includes(0) || bytes.length > 1024 * 1024 || !statSync(file).isFile()) throw new Error(`Binary or oversized file: ${file}`);
  const content = bytes.toString('utf8');
  if (secret.test(content) || personalPath.test(content)) throw new Error(`Possible credential or personal path: ${file}`);
  manifest.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
console.log(JSON.stringify({ ok: true, sourceFiles: files.length, totalBytes: manifest.reduce((n, f) => n + f.bytes, 0), files: manifest }, null, 2));
