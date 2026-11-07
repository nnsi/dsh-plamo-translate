"""Build a local PLaMo adapter from the installed, version-pinned MIT DSH plugins.

The generated files live under vendor/; the global DSH installation is unchanged.
Existing scheduling, Session persistence, cancellation and source rendering remain
upstream implementations. This script fails on unexpected upstream code changes.
"""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parent.parent
import argparse
import subprocess

parser = argparse.ArgumentParser(description='Rebuild vendored adapters from an installed, pinned DSH package')
parser.add_argument('--dsh-dir', type=Path, help='Optional path to the installed @deepseek-ai/dsh package')
args = parser.parse_args()
if args.dsh_dir:
    DSH = args.dsh_dir.resolve()
else:
    resolved = subprocess.check_output(['node', '-e', "process.stdout.write(require.resolve('@deepseek-ai/dsh/package.json'))"], cwd=ROOT, text=True)
    DSH = Path(resolved).parent
def resolve_package(name):
    program = "const {createRequire}=require('node:module');process.stdout.write(createRequire(process.argv[1]).resolve(process.argv[2]+'/package.json'))"
    resolved = subprocess.check_output(['node', '-e', program, str(DSH / 'package.json'), name], text=True)
    return Path(resolved).parent
VERSION = '0.2.2-rc.1'
RENAMES = {
    '@deepseek-ai/dsh-experimental-cot-translation-bundle': 'dsh-plamo-translate',
    '@deepseek-ai/dsh-experimental-client-ui-cot-translation': 'dsh-plamo-translate',
    '@deepseek-ai/dsh-experimental-translator': 'dsh-plamo-translate',
}
manifest = json.loads((DSH / 'package.json').read_text(encoding='utf-8'))
if manifest['version'] != VERSION:
    raise RuntimeError('Review adapter against the new Harness version before rebuilding')

def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('Upstream adapter point changed: ' + old[:90])
    return source.replace(old, new, 1)

hashes = {}
for upstream, folder in [
    ('dsh-experimental-translator', 'translator'),
    ('dsh-experimental-client-ui-cot-translation', 'cot-translation'),
]:
    source_root = resolve_package('@deepseek-ai/' + upstream)
    dest = ROOT / 'vendor' / folder
    for source in sorted(source_root.rglob('*'), key=lambda path: path.as_posix()):
        if not source.is_file() or 'node_modules' in source.relative_to(source_root).parts:
            continue
        relative = source.relative_to(source_root)
        wanted = {'lib/index.js', 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js'}
        if relative.as_posix() not in wanted:
            continue
        target = dest / relative.relative_to('lib')
        target.parent.mkdir(parents=True, exist_ok=True)
        original = source.read_text(encoding='utf-8')
        hashes[f'{upstream}/{relative.as_posix()}'] = hashlib.sha256(original.encode()).hexdigest()
        content = original
        for old, new in RENAMES.items():
            content = content.replace(old, new)
        content = content.replace('"google"', '"plamo"').replace("'google'", "'plamo'")
        content = content.replace('googleEndpoint', 'plamoEndpoint')
        content = content.replace('google-form-v1', 'plamo-chat-v1')
        content = re.sub(r'\bgoogle:\s*"[^"]*"', 'plamo: "PLaMo Translate"', content)
        if folder == 'cot-translation' and relative.as_posix() == 'lib/index.js':
            content = content.replace('from "dsh-plamo-translate"', 'from "../translator/index.js"')
            content = content.replace('.default("bing").volatile()', '.default("plamo").volatile()')
            content = content.replace('.default("auto").volatile()', '.default("ja").volatile()')
        if folder == 'translator' and relative.as_posix() == 'lib/index.js':
            start = content.index('\t\tcase "plamo": {', content.index('function requestFor('))
            end = content.index('\n\t\tcase "bing": {', start)
            content = content[:start] + '''\t\tcase "plamo": {
            if (config.plamoApiKeyEnv && !process.env[config.plamoApiKeyEnv]) throw new TranslationError("TRANSLATION_UNAVAILABLE", "The configured PLaMo API key environment variable is unset");
            const options = { target_lang: spec.targetLanguage };
            if (spec.sourceLanguage !== "auto") options.source_lang = spec.sourceLanguage;
            return {
                url: new URL(config.plamoEndpoint),
                init: {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        ...(config.plamoApiKeyEnv ? { authorization: `Bearer ${process.env[config.plamoApiKeyEnv]}` } : {})
                    },
                    body: JSON.stringify({
                        model: config.plamoModel,
                        messages: [{ role: "user", content: spec.text }],
                        chat_template_kwargs: options,
                        temperature: 0,
                        max_tokens: config.plamoMaxOutputTokens,
                        stop: ["<|plamo:tag|>", "<|plamo:bos|>"]
                    })
                }
            };
        }''' + content[end:]
            content = replace_once(content, 'function translationOf(payload, provider) {', '''function translationOf(payload, provider) {
    if (provider === "plamo") {
        const choice = payload?.choices?.[0];
        const text = choice?.message?.content;
        if (choice?.finish_reason !== "stop" || typeof text !== "string" || text.trim() === "") throw invalidResponse(provider);
        return text;
    }''')
            content = replace_once(content, '.default("https://translate.googleapis.com/translate_a/single")', '.default("http://127.0.0.1:18080/v1/chat/completions")')
            content = replace_once(content, '\t\tmaxTextChars: z.natural().min(2).default(4e3),', '''        plamoModel: z.string().default("plamo-3-translate-0.8b"),
        plamoApiKeyEnv: z.string().default(""),
        plamoMaxOutputTokens: z.natural().min(1).default(2048),
        maxTextChars: z.natural().min(2).default(1200),''')
            start = content.index('\tasync availableProviders(signal) {')
            end = content.index('\n\t/**', start)
            content = content[:start] + '\tasync availableProviders(signal) {\n\t\tthis.signal(signal);\n\t\treturn ["plamo"];\n\t}\n' + content[end:]
            content = replace_once(content, '\t\tconst provider = request.provider ?? this.config.provider;', '''        const provider = request.provider ?? this.config.provider;
        if (provider !== "plamo") throw new TranslationError("TRANSLATION_UNAVAILABLE", "This bundle uses the configured PLaMo translation API only");''')
            content = replace_once(content, 'function anonymousRecipe(provider, config) {', '''function anonymousRecipe(provider, config) {
    if (provider === "plamo") return JSON.stringify(["plamo-chat-v1", config.plamoEndpoint, config.plamoModel, config.plamoMaxOutputTokens, 0]);''')
            content = content.replace(']).default("bing")', ']).default("plamo")')
        if folder == 'cot-translation' and relative.as_posix() == 'lib/client.js':
            content = content.replace('children: t("privacy")', 'children: t("plamoPrivacy")')
            content = content.replace('children: t(paid ? "paidNotice" : "anonymousNotice")', 'children: t("plamoNotice")')
            content = content.replace('const en = {', 'const en = { plamoPrivacy: "Expanded Thinking is sent to your configured PLaMo API.", plamoNotice: "Original reasoning remains available. Saved translations are reused.",')
            content = content.replace('const ja = {', 'const ja = { plamoPrivacy: "Thinkingの原文は、設定したPLaMo翻訳APIで処理されます。", plamoNotice: "原文は保持され、保存した翻訳結果を再利用できます。",')
        content = re.sub(r'^.*sourceMappingURL=.*$', '', content, flags=re.M)
        content = re.sub(r'^\s*//#region.*dsh-css:.*$', '\t\t//#region bundled styles', content, flags=re.M)
        target.write_text(content.rstrip() + '\n', encoding='utf-8', newline='\n')

(ROOT / 'upstream.json').write_text(json.dumps({'dshVersion': VERSION, 'repository': 'https://github.com/deepseek-ai/deepseek-harness', 'sha256': hashes}, indent=2, sort_keys=True) + '\n', encoding='utf-8', newline='\n')
(ROOT / 'vendor' / 'LICENSE.upstream').write_text((resolve_package('@deepseek-ai/dsh-experimental-translator') / 'LICENSE').read_text(encoding='utf-8'), encoding='utf-8', newline='\n')
print('Built portable PLaMo translator and Thinking UI')
