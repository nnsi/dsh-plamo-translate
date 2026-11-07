import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const dsh = require.resolve('@deepseek-ai/dsh/lib/bin.js');
const runtime = join(root, '.test-runtime');
await mkdir(runtime, { recursive: true });
const home = await mkdtemp(join(runtime, 'smoke-'));
const profile = join(home, 'profiles', 'web');
await mkdir(profile, { recursive: true });
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|COMSPEC)$/i.test(key))),
  DSH_HOME: home,
  DSH_TELEMETRY_MODE: 'DISABLED',
};
let apiCalls = 0;
const fake = createServer(async (req, res) => {
  apiCalls += 1;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(body.chat_template_kwargs.target_lang, 'ja');
  assert.equal(body.model, 'plamo-3-translate-0.8b');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '設定を確認します。' } }] }));
});
fake.listen(0, '127.0.0.1');
await once(fake, 'listening');
const apiPort = fake.address().port;
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'plamo-smoke-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }), 'utf8');
await writeFile(join(profile, 'cordis.yml'), '[]\n', 'utf8');
await writeFile(join(profile, 'cordis.patch.yml'), `- id: plamo-translation-api\n  config:\n    autoStart: false\n- id: translator\n  config:\n    plamoEndpoint: http://127.0.0.1:${apiPort}/v1/chat/completions\n`, 'utf8');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dsh, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Isolated install failed (${code}): ${output.replace(/token=[^\s]+/g, 'token=[redacted]')}`)));
  });
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function start() {
  const port = await freePort();
  const child = spawn(process.execPath, [dsh, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated Harness startup timed out')); }, 60000);
    const receive = data => {
      output += data;
      const match = output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[A-Za-z0-9_-]+`));
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Isolated Harness exited (${code}): ${output.replace(/token=[^\s]+/g, 'token=[redacted]')}`)); });
  });
  const exchange = await fetch(url, { redirect: 'manual' });
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers.get('set-cookie').split(';', 1)[0];
  await exchange.body?.cancel();
  const base = `http://127.0.0.1:${port}`;
  return {
    child, base, cookie,
    async rpc(endpoint, args) {
      const response = await fetch(`${base}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: base },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      const message = await response.json();
      assert.equal(message.result.ok, true, JSON.stringify(message.result));
      return message.result.value;
    },
    async stop() {
      if (child.exitCode !== null) return;
      const done = once(child, 'exit');
      child.kill();
      await done;
    },
  };
}

let app;
try {
  const tarball = join(root, 'dsh-plamo-translate-0.1.0.tgz');
  await run(['plugin', '--profile', 'web', 'add', tarball, '--offline', '--ignore-scripts']);
  app = await start();
  assert.deepEqual((await app.rpc('cotTranslation/limits', {})).preferences, { provider: 'plamo', targetLanguage: 'ja' });
  assert.equal(await app.rpc('cotTranslation/translate', { request: { text: 'Hello.', sourceLanguage: 'en', targetLanguage: 'ja', provider: 'plamo' } }), '設定を確認します。');
  apiCalls = 0;
  const { sessionId } = await app.rpc('session/create', { request: { cwd: home } });
  const request = { text: 'I will inspect the configuration.', sourceLanguage: 'en', targetLanguage: 'ja', provider: 'plamo', sessionId };
  assert.equal(await app.rpc('cotTranslation/translate', { request }), '設定を確認します。');
  assert.equal(await app.rpc('cotTranslation/translate', { request }), '設定を確認します。');
  assert.equal(apiCalls, 1);
  const html = await (await fetch(`${app.base}/`, { headers: { cookie: app.cookie } })).text();
  const boot = JSON.parse(html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*({.*?});?<\/script>/s)[1]);
  const client = boot.entries.find(entry => entry.id === 'dsh-plamo-translate');
  assert.ok(client);
  const script = await (await fetch(`${app.base}/${client.url}`)).text();
  assert.ok(script.includes('conversation.chat.reasoning.body'));
  assert.ok(script.includes('PLaMo Translate'));
  await app.stop();
  app = await start();
  assert.equal(await app.rpc('cotTranslation/translate', { request }), '設定を確認します。');
  assert.equal(apiCalls, 1);
  console.log('Smoke passed: tarball install, authenticated RPC, translated output, client bundle, and durable cache after restart. No model inference was used.');
} finally {
  await app?.stop();
  fake.closeAllConnections();
  await new Promise(resolve => fake.close(resolve));
}
