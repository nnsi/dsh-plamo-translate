"""Download verified official Windows CUDA binaries and PLaMo 0.8B weights.

Python 3.11+, standard library only. Assets stay outside version control.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.request
import zipfile

RELEASE = 'b12110'
MODEL_REPO = 'pfnet/plamo-3-translate-0.8b-GGUF'
MODEL_REVISION = '0c4af2b003fdd94b6868aa955414c1c86ee96997'
ASSETS = [
    ('bin', f'https://github.com/ggml-org/llama.cpp/releases/download/{RELEASE}/llama-{RELEASE}-bin-win-cuda-12.4-x64.zip', '1ce755bc3a061889234048f88e33328e17971eaad73c4666cfeb26026b317fee'),
    ('bin', f'https://github.com/ggml-org/llama.cpp/releases/download/{RELEASE}/cudart-llama-bin-win-cuda-12.4-x64.zip', '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6'),
    ('models', f'https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/plamo-3-translate-0.8b-Q4_K_M.gguf', '73a1d942d8ab1e654d83898d997b8b4808c32ba669b378df612230989d18f079'),
    ('models', f'https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/chat_template.jinja', '084af862c7844bdca74e8dca5516fde1f446919e00650ee4d8fae5b193fd064e'),
]

def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def extract_archive(path, destination):
    destination = destination.resolve()
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            target = (destination / item.filename).resolve()
            if not target.is_relative_to(destination):
                raise ValueError('Archive contains a path outside the runtime directory')
        archive.extractall(destination)

def provision(runtime):
    for name in ('downloads', 'bin', 'models', 'logs'):
        (runtime / name).mkdir(parents=True, exist_ok=True)

    def download(asset):
        category, url, expected = asset
        filename = url.rsplit('/', 1)[1]
        target = runtime / ('downloads' if category == 'bin' else category) / filename
        if not target.exists() or sha256(target) != expected:
            partial = target.with_suffix(target.suffix + '.partial')
            with urllib.request.urlopen(url, timeout=120) as response, partial.open('wb') as output:
                while block := response.read(4 * 1024 * 1024):
                    output.write(block)
            if sha256(partial) != expected:
                raise RuntimeError('SHA256 mismatch: ' + filename)
            partial.replace(target)
        print('Verified ' + filename, flush=True)
        return target, category

    with ThreadPoolExecutor(max_workers=4) as pool:
        downloaded = list(pool.map(download, ASSETS))
    for path, category in downloaded:
        if category == 'bin':
            extract_archive(path, runtime / 'bin')
    manifest = {'llamaCppRelease': RELEASE, 'modelRepository': MODEL_REPO, 'modelRevision': MODEL_REVISION, 'assets': [{'url': url, 'sha256': digest} for _, url, digest in ASSETS]}
    (runtime / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print('Runtime ready. Enable the bundle to start or reuse the local API.', flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', type=Path, default=Path(__file__).resolve().parent.parent / '.runtime')
    args = parser.parse_args()
    provision(args.runtime_dir.resolve())
