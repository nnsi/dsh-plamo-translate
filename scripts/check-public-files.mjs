import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['.git', 'node_modules', '.runtime', '.test-runtime', '__pycache__', '.cordis', 'coverage']);
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    if (entry.isFile() && entry.name.endsWith('.tgz')) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}
const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
const files = git.status === 0 && git.stdout ? git.stdout.split('\0').filter(Boolean) : await walk(root);
const patterns = [
  ['absolute Windows path', /\b[A-Za-z]:[\\/]/],
  ['absolute home path', /\/(?:home|Users)\/[^/\s]+\//],
  ['private network address', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['access token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,})\b/],
  ['private key', /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/],
];
const localUser = process.env.USERNAME ?? process.env.USER;
if (localUser && localUser.length >= 4 && !['runner', 'root'].includes(localUser)) {
  const escaped = localUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  patterns.push(['local account name', new RegExp(`\\b${escaped}\\b`, 'i')]);
}
const failures = [];
for (const file of files) {
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.credentials[^/]*|logs|sessions|backups|models|downloads|bin)(?:\/|$)|\.(?:gguf|safetensors|pid|log|zip|tgz|partial)$/i.test(file.replaceAll('\\', '/'))) {
    failures.push([file, 'runtime or private file']);
    continue;
  }
  const bytes = await readFile(resolve(root, file));
  if (bytes.byteLength > 2 * 1024 * 1024) failures.push([file, 'unexpectedly large file']);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { failures.push([file, 'not UTF-8 text']); continue; }
  for (const [label, pattern] of patterns) if (pattern.test(text)) failures.push([file, label]);
}
if (failures.length) {
  for (const [file, label] of failures) process.stderr.write(`${file}: ${label}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} public UTF-8 files; no local paths, private addresses, credentials, or runtime artifacts found.\n`);
}
