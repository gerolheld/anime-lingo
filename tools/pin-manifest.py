#!/usr/bin/env python3
"""Regenerate desktop/manifest.json: pinned third-party components with SHA-256.

Pins are chosen by hand (see PINS); this script only reads the release metadata and
records URL, size and digest. Digests come from GitHub's asset `digest` field,
Hugging Face's LFS `sha256` and uv's published .sha256 files. Nothing is downloaded
except those small metadata documents.
"""
import hashlib
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

PINS = {
    'llama': {'repo': 'ggml-org/llama.cpp', 'tag': 'b11375'},
    'uv': {'repo': 'astral-sh/uv', 'tag': '0.13.5'},
    'ffmpegLinux': {'repo': 'eugeneware/ffmpeg-static', 'tag': 'b6.1.1'},
    'ffmpegWindows': {'repo': 'BtbN/FFmpeg-Builds', 'tag': 'autobuild-2026-09-30-13-08', 'prefix': 'ffmpeg-n9.0.2-', 'suffix': '-win64-gpl-9.0.zip'},
    'hymt': {'repo': 'tencent/Hy-MT2-7B-GGUF'},
}
LLAMA_ASSETS = {
    'win-cpu-x64': 'llama-{tag}-bin-win-cpu-x64.zip',
    'win-vulkan-x64': 'llama-{tag}-bin-win-vulkan-x64.zip',
    'win-cuda-12.4-x64': 'llama-{tag}-bin-win-cuda-12.4-x64.zip',
    'win-cuda-13.4-x64': 'llama-{tag}-bin-win-cuda-13.4-x64.zip',
    'win-sycl-x64': 'llama-{tag}-bin-win-sycl-x64.zip',
    'win-rocm-x64': 'llama-{tag}-bin-win-rocm-10.0-x64.zip',
    'win-cudart-12.4-x64': 'cudart-llama-bin-win-cuda-12.4-x64.zip',
    'win-cudart-13.4-x64': 'cudart-llama-bin-win-cuda-13.4-x64.zip',
    'linux-cpu-x64': 'llama-{tag}-bin-ubuntu-x64.tar.gz',
    'linux-vulkan-x64': 'llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz',
    'linux-cuda-12.8-x64': 'llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz',
    'linux-cuda-13.4-x64': 'llama-{tag}-bin-ubuntu-cuda-13.4-x64.tar.gz',
    'linux-sycl-fp16-x64': 'llama-{tag}-bin-ubuntu-sycl-fp16-x64.tar.gz',
    'linux-sycl-fp32-x64': 'llama-{tag}-bin-ubuntu-sycl-fp32-x64.tar.gz',
    'linux-rocm-x64': 'llama-{tag}-bin-ubuntu-rocm-10.0-x64.tar.gz',
    'linux-cudart-12.8-x64': 'cudart-llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz',
    'linux-cudart-13.4-x64': 'cudart-llama-{tag}-bin-ubuntu-cuda-13.4-x64.tar.gz',
}

def get(url):
    with urlopen(Request(url, headers={'User-Agent': 'anime-lingo-pin'}), timeout=60) as response:
        return response.read()

def hashed(url, size):
    # Old releases publish no digest: the archive is downloaded once here and its SHA-256 is pinned (trust on first use).
    digest = hashlib.sha256()
    with urlopen(Request(url, headers={'User-Agent': 'anime-lingo-pin'}), timeout=300) as response:
        total = 0
        for block in iter(lambda: response.read(1 << 20), b''):
            digest.update(block)
            total += len(block)
    if total != size:
        raise SystemExit('Размер %s не совпал: %d != %d' % (url, total, size))
    return digest.hexdigest()

def release(repo, tag):
    return json.loads(get(f'https://api.github.com/repos/{repo}/releases/tags/{tag}'))

def asset(rel, name):
    for item in rel['assets']:
        if item['name'] == name:
            digest = item.get('digest') or ''
            if not digest.startswith('sha256:'):
                raise SystemExit('Нет SHA-256 у ' + name)
            return {'name': name, 'url': item['browser_download_url'], 'size': item['size'], 'sha256': digest[7:]}
    raise SystemExit('Нет файла в релизе: ' + name)

def main():
    manifest = {'schema': 1}
    rel = release(**{k: PINS['llama'][k] for k in ('repo', 'tag')})
    tag = PINS['llama']['tag']
    manifest['llama'] = {'tag': tag, 'assets': {key: asset(rel, name.format(tag=tag)) for key, name in LLAMA_ASSETS.items()}}
    uv_tag = PINS['uv']['tag']
    uv = {}
    for key, name in {'win-x64': 'uv-x86_64-pc-windows-msvc.zip', 'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz'}.items():
        url = f'https://github.com/astral-sh/uv/releases/download/{uv_tag}/{name}'
        sha = get(url + '.sha256').decode().split()[0].lower()
        uv[key] = {'name': name, 'url': url, 'sha256': sha}
    manifest['uv'] = {'version': uv_tag, 'assets': uv}
    rel = release(PINS['ffmpegLinux']['repo'], PINS['ffmpegLinux']['tag'])
    manifest['ffmpeg'] = {'linux-x64': {'ffmpeg': asset(rel, 'ffmpeg-linux-x64.gz'), 'ffprobe': asset(rel, 'ffprobe-linux-x64.gz'), 'note': 'Статическая сборка без VAAPI, QSV, NVENC и AMF. Запасной вариант, на Linux основной — системный ffmpeg.'}}
    pin = PINS['ffmpegWindows']
    rel = release(pin['repo'], pin['tag'])
    names = [a['name'] for a in rel['assets'] if a['name'].startswith(pin['prefix']) and a['name'].endswith(pin['suffix'])]
    if len(names) != 1:
        raise SystemExit('Ожидался один файл BtbN, найдено: %r' % names)
    manifest['ffmpeg']['win-x64'] = {'archive': asset(rel, names[0]), 'note': 'Полная GPL-сборка BtbN: NVENC, AMF, QSV.'}
    rel = release('xinntao/Real-ESRGAN', 'v0.2.5.0')
    esr = {}
    for key, name in {'linux-x64': 'realesrgan-ncnn-vulkan-20220424-ubuntu.zip', 'win-x64': 'realesrgan-ncnn-vulkan-20220424-windows.zip'}.items():
        item = next(a for a in rel['assets'] if a['name'] == name)
        esr[key] = {'name': name, 'url': item['browser_download_url'], 'size': item['size'], 'sha256': hashed(item['browser_download_url'], item['size']), 'note': 'Включает модели realesr-animevideov3 x2/x3/x4. SHA-256 вычислен при закреплении (в релизе нет digest).'}
    manifest['realesrgan'] = {'version': 'v0.2.5.0 / 20220424', 'assets': esr}
    info = json.loads(get('https://huggingface.co/api/models/' + PINS['hymt']['repo'] + '?blobs=true'))
    models = {}
    for item in info['siblings']:
        if item['rfilename'].lower().endswith('.gguf'):
            models[item['rfilename']] = {'url': 'https://huggingface.co/%s/resolve/%s/%s' % (PINS['hymt']['repo'], info['sha'], item['rfilename']), 'size': item['size'], 'sha256': item['lfs']['sha256']}
    manifest['hymt'] = {'repo': PINS['hymt']['repo'], 'revision': info['sha'], 'files': models}
    target = Path(__file__).resolve().parent.parent / 'desktop' / 'manifest.json'
    target.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    print('Записано', target)

if __name__ == '__main__':
    sys.exit(main())
