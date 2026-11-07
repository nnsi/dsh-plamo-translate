import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import Translator from '../vendor/translator/index.js';

async function withTranslator(handler, run, overrides = {}) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = new Context();
  const config = {
    provider: 'plamo',
    plamoEndpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    plamoModel: 'plamo-3-translate-0.8b',
    plamoApiKeyEnv: '',
    plamoMaxOutputTokens: 2048,
    maxTextChars: 1200,
    timeoutMs: 1000,
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  };
  const translator = new Translator(context, config);
  try {
    await run(translator);
  } finally {
    translator.lifetime.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('sends the translation template options to the local model', async () => {
  let body;
  await withTranslator(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.method, 'POST');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '設定を確認します。' } }] }));
  }, async translator => {
    assert.deepEqual(await translator.availableProviders(), ['plamo']);
    const source = 'I will inspect the configuration.';
    const result = await translator.translate(translator.resolve({ text: source, targetLanguage: 'ja' }));
    assert.equal(result, '設定を確認します。');
    assert.deepEqual(body.messages, [{ role: 'user', content: source }]);
    assert.deepEqual(body.chat_template_kwargs, { target_lang: 'ja' });
    assert.equal(body.model, 'plamo-3-translate-0.8b');
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 2048);
  });
});

test('rejects truncated or empty output so the reader can retain the source', async () => {
  for (const choice of [
    { finish_reason: 'length', message: { content: '途中まで' } },
    { finish_reason: 'stop', message: { content: '' } },
  ]) {
    await withTranslator((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [choice] }));
    }, async translator => {
      await assert.rejects(translator.translate(translator.resolve({ text: 'Hello', targetLanguage: 'ja' })), { code: 'TRANSLATION_INVALID_RESPONSE' });
    });
  }
});

test('reports API failure without switching to an external service', async () => {
  let calls = 0;
  await withTranslator((req, res) => {
    calls += 1;
    res.writeHead(503);
    res.end('unavailable');
  }, async translator => {
    await assert.rejects(translator.translate(translator.resolve({ text: 'Hello', targetLanguage: 'ja' })), { code: 'TRANSLATION_HTTP_ERROR' });
    assert.throws(() => translator.resolve({ text: 'Hello', targetLanguage: 'ja', provider: 'bing' }), { code: 'TRANSLATION_UNAVAILABLE' });
    assert.equal(calls, 1);
  });
});

test('cancellation stops a request waiting for model output', async () => {
  await withTranslator((req, res) => {}, async translator => {
    const controller = new AbortController();
    const pending = translator.translate(translator.resolve({ text: 'Hello', targetLanguage: 'ja' }), controller.signal);
    controller.abort(new Error('reader closed Thinking'));
    await assert.rejects(pending, /reader closed Thinking/);
  });
});

test('supports authentication from a named environment variable', async () => {
  const variable = 'PLAMO_TRANSLATION_TEST_KEY';
  const previous = process.env[variable];
  process.env[variable] = 'unit-test-value';
  try {
    await withTranslator((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer unit-test-value');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'こんにちは。' } }] }));
    }, async translator => {
      assert.equal(await translator.translate(translator.resolve({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'ja' })), 'こんにちは。');
    }, { plamoApiKeyEnv: variable });
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test('does not dispatch when the selected API key variable is missing', async () => {
  let calls = 0;
  await withTranslator((req, res) => { calls += 1; res.end('{}'); }, async translator => {
    await assert.rejects(translator.translate(translator.resolve({ text: 'Hello', targetLanguage: 'ja' })), { code: 'TRANSLATION_UNAVAILABLE' });
    assert.equal(calls, 0);
  }, { plamoApiKeyEnv: 'PLAMO_TRANSLATION_UNSET_TEST_KEY' });
});
