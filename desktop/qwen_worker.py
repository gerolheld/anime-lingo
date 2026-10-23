#!/usr/bin/env python3
"""One local inference stage per process: exiting releases its model and GPU context."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import unicodedata
import wave

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

def emit(**data):
    print('LINGO ' + json.dumps(data, ensure_ascii=False), flush=True)

def save(file, data):
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(file)

def read(file, default):
    return json.loads(file.read_text(encoding='utf-8')) if file.exists() else default

def english_skip_reason(language, text):
    """ASR language labels can incorrectly call a Japanese ending song English."""
    if language and 'english' not in language.lower():
        return 'non-english-language'
    letters = [char for char in text if char.isalpha()]
    if letters and not any('LATIN' in unicodedata.name(char, '') for char in letters):
        return 'non-latin-transcript'
    if text and not any(char.isalnum() for char in text):
        return 'no-speech-text'
    return None

def restore_word_spans(processor, text, aligned, chunk_index):
    """Map SDK units back to source words, keeping punctuation and actual spans.

    Even in English mode Qwen splits CJK characters inside a whitespace word.
    One original word can therefore own several aligned units, not just one.
    """
    groups = []
    for original in re.findall(r'\S+', text):
        units, _ = processor.encode_timestamp(original, 'English')
        if units:
            groups.append((original, units))
    expected = [unit for _, units in groups for unit in units]
    actual = [item.text for item in aligned]
    if actual != expected:
        raise ValueError(f'ForcedAligner token mismatch at chunk {chunk_index}: '
                         f'expected {len(expected)} units, received {len(actual)}')
    spans, position = [], 0
    for original, units in groups:
        items = aligned[position:position + len(units)]
        position += len(units)
        times = [(float(item.start_time), float(item.end_time)) for item in items]
        if any(not math.isfinite(start) or not math.isfinite(end) or end < start
               for start, end in times):
            raise ValueError(f'ForcedAligner returned invalid timestamps at chunk {chunk_index}')
        spans.append({'text': original, 'start': min(start for start, _ in times),
                      'end': max(end for _, end in times)})
    return spans

def audio_info(file):
    with wave.open(str(file)) as audio:
        if (audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) != (1, 16000, 2):
            raise ValueError('Expected mono 16 kHz PCM16 WAV')
        return audio.getnframes() / 16000

def samples(file, start, end):
    import numpy as np
    with wave.open(str(file)) as audio:
        audio.setpos(round(start * 16000))
        return np.frombuffer(audio.readframes(round((end - start) * 16000)), dtype='<i2').astype(np.float32) / 32768

def plan(args):
    import numpy as np
    duration = audio_info(args.audio)
    signature = [args.audio.stat().st_size, duration, args.chunk_seconds]
    existing = read(args.directory / 'segments.json', {})
    if existing.get('signature') == signature:
        return
    for name in ['asr.json', 'alignment.json']:
        (args.directory / name).unlink(missing_ok=True)
    chunks, start = [], 0.0
    while start < duration - .01:
        end = min(duration, start + args.chunk_seconds)
        if end < duration:
            low = start + args.chunk_seconds * .78
            search = samples(args.audio, low, end)
            window = 1280
            energies = [float(np.mean(search[i:i + window] ** 2)) for i in range(0, len(search) - window + 1, window)]
            if energies:
                end = low + (int(np.argmin(energies)) + .5) * window / 16000
        chunks.append({'index': len(chunks), 'start': start, 'end': end, 'audioStart': max(0, start - .4), 'audioEnd': min(duration, end + .4)})
        start = end
    save(args.directory / 'segments.json', {'signature': signature, 'duration': duration, 'chunks': chunks})
    emit(event='planned', chunks=len(chunks), duration=duration)

def device(requested):
    import torch
    build = torch.__version__
    if requested != 'auto':
        if requested == 'xpu' and not (hasattr(torch, 'xpu') and torch.xpu.is_available()):
            raise RuntimeError('Intel XPU недоступен (установлена сборка PyTorch ' + build + '). Проверь драйвер Intel или выбери CPU в настройках.')
        if requested == 'cuda' and not (torch.version.cuda and torch.cuda.is_available()):
            raise RuntimeError('CUDA недоступна (установлена сборка PyTorch ' + build + '). Нужна видеокарта NVIDIA, свежий драйвер и сборка PyTorch с CUDA.')
        if requested == 'rocm' and not (getattr(torch.version, 'hip', None) and torch.cuda.is_available()):
            raise RuntimeError('ROCm недоступен (установлена сборка PyTorch ' + build + '). Нужна видеокарта AMD, поддерживаемая ROCm, и сборка PyTorch с ROCm.')
        # ROCm builds expose the GPU through torch.cuda.
        return 'cuda' if requested == 'rocm' else requested
    if hasattr(torch, 'xpu') and torch.xpu.is_available():
        return 'xpu'
    return 'cuda' if torch.cuda.is_available() else 'cpu'

def infer(args):
    import numpy as np
    import torch
    from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner
    torch.set_num_threads(6)
    selected = device(args.device)
    emit(event='device', device=selected, name=torch.xpu.get_device_name() if selected == 'xpu' else torch.cuda.get_device_name() if selected == 'cuda' else selected)
    kwargs = {'dtype': torch.bfloat16 if selected != 'cpu' else torch.float32, 'device_map': selected, 'attn_implementation': 'sdpa', 'local_files_only': True}
    segments = read(args.directory / 'segments.json', None)
    if not segments:
        raise ValueError('Audio chunk plan is missing')
    if args.stage == 'asr':
        output = args.directory / 'asr.json'
        state = read(output, {'model': str(args.model), 'chunks': []})
        if state['model'] != str(args.model):
            state = {'model': str(args.model), 'chunks': []}
        done = {c['index']: c for c in state['chunks']}
        pending = [c for c in segments['chunks'] if c['index'] not in done]
        if not pending:
            return
        model = Qwen3ASRModel.from_pretrained(str(args.model), max_inference_batch_size=1, max_new_tokens=768, **kwargs)
        for chunk in segments['chunks']:
            if chunk['index'] in done:
                continue
            audio = samples(args.audio, chunk['audioStart'], chunk['audioEnd'])
            skipped_reason = None
            if float(np.sqrt(np.mean(audio ** 2))) < .0015:
                language, text = '', ''
            else:
                with torch.inference_mode():
                    result = model.transcribe(audio=(audio, 16000), language=None, return_time_stamps=False)[0]
                language = result.language
                text = re.sub(r'\s+', ' ', result.text).strip()
                skipped_reason = english_skip_reason(language, text)
                if skipped_reason:
                    emit(event='skipped-language', index=chunk['index'], language=language, reason=skipped_reason)
                    text = ''
            done[chunk['index']] = {**chunk, 'language': language, 'text': text}
            if skipped_reason:
                done[chunk['index']]['skippedReason'] = skipped_reason
            state['chunks'] = [done[i] for i in sorted(done)]
            save(output, state)
            emit(event='progress', stage='asr', done=len(done), total=len(segments['chunks']), percent=100 * len(done) / len(segments['chunks']))
    else:
        source = read(args.directory / 'asr.json', None)
        if not source or len(source['chunks']) != len(segments['chunks']):
            raise ValueError('Finish speech recognition before alignment')
        output = args.directory / 'alignment.json'
        state = read(output, {'model': str(args.model), 'chunks': []})
        if state['model'] != str(args.model):
            state = {'model': str(args.model), 'chunks': []}
        done = {c['index']: c for c in state['chunks']}
        model = None
        for chunk in source['chunks']:
            # Recheck cached ASR results too: users must be able to resume jobs
            # created before the script guard without running ASR again.
            skipped_reason = chunk.get('skippedReason') or english_skip_reason(chunk.get('language', ''), chunk['text'])
            cached = done.get(chunk['index'])
            if cached and cached.get('text') == chunk['text'] and cached.get('skippedReason') == skipped_reason:
                continue
            words = []
            if skipped_reason:
                emit(event='skipped-language', index=chunk['index'], language=chunk.get('language', ''), reason=skipped_reason)
            elif chunk['text']:
                if model is None:
                    model = Qwen3ForcedAligner.from_pretrained(str(args.model), **kwargs)
                audio = samples(args.audio, chunk['audioStart'], chunk['audioEnd'])
                with torch.inference_mode():
                    aligned = model.align(audio=(audio, 16000), text=chunk['text'], language='English')[0]
                for item in restore_word_spans(model.aligner_processor, chunk['text'], aligned, chunk['index']):
                    start = item['start'] + chunk['audioStart']
                    end = item['end'] + chunk['audioStart']
                    middle = (start + end) / 2
                    if chunk['start'] <= middle < chunk['end']:
                        words.append({'text': item['text'], 'start': round(max(0, start), 3), 'end': round(min(segments['duration'], end), 3)})
            done[chunk['index']] = {'index': chunk['index'], 'text': chunk['text'], 'words': words}
            if skipped_reason:
                done[chunk['index']]['skippedReason'] = skipped_reason
            state['chunks'] = [done[i] for i in sorted(done)]
            save(output, state)
            emit(event='progress', stage='align', done=len(done), total=len(source['chunks']), percent=100 * len(done) / len(source['chunks']))
    emit(event='complete', stage=args.stage)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', choices=['plan', 'asr', 'align', 'probe'], required=True)
    parser.add_argument('--audio', type=Path)
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--model', type=Path)
    parser.add_argument('--device', choices=['auto', 'cpu', 'xpu', 'cuda', 'rocm'], default='auto')
    parser.add_argument('--chunk-seconds', type=float, default=30)
    args = parser.parse_args()
    if not 15 <= args.chunk_seconds <= 60:
        raise ValueError('Audio chunks must be between 15 and 60 seconds')
    if args.stage == 'probe':
        import torch
        import qwen_asr
        chosen = device(args.device)
        emit(event='probe', torch=torch.__version__, device=chosen, name=torch.xpu.get_device_name() if chosen == 'xpu' else chosen)
        return
    args.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.stage == 'plan':
        plan(args)
    else:
        infer(args)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit(event='error', message=str(error))
        raise
