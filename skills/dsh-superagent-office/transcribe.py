#!/usr/bin/env python3
"""Local SenseVoice + Silero VAD, timestamped segments, bounded streaming decode.

Host-owned connector, not a worker shell tool. No network access is needed.
Dependencies: sherpa-onnx==2.0.1, numpy==2.2.6; ffmpeg/ffprobe on PATH.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--model-dir', required=True)
    args = parser.parse_args()
    path = Path(args.input).resolve(strict=True)
    if not path.is_file() or path.stat().st_size > 80 * 1024 * 1024:
        raise ValueError('invalid audio size')
    # Restrict demuxer protocols: a playlist disguised as audio cannot read an HTTP resource.
    formats = 'mp3,wav,mov,matroska,webm,ogg,flac,aac,amr,asf'
    probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
                            '-show_entries', 'format=duration', '-of', 'json', str(path)],
                           capture_output=True, check=True, timeout=20)
    duration = float(json.loads(probe.stdout)['format']['duration'])
    if not 0 < duration <= 7200:
        raise ValueError('audio must be at most two hours; no silent truncation')
    import numpy as np
    import sherpa_onnx
    model = Path(args.model_dir)
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model / 'model.int8.onnx'), tokens=str(model / 'tokens.txt'),
        num_threads=4, use_itn=True, debug=False)
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(model / 'silero_vad.onnx')
    config.silero_vad.threshold = 0.5
    config.silero_vad.min_silence_duration = 0.5
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = 25
    config.sample_rate = 16000
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=60)
    window = config.silero_vad.window_size
    decoder = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
                                '-i', str(path), '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    segments, count, chars = [], 0, 0

    def collect():
        nonlocal chars
        while not vad.empty():
            segment = vad.front
            start = segment.start / 16000
            end = start + len(segment.samples) / 16000
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, segment.samples)
            recognizer.decode_stream(stream)
            text = re.sub(r'<\|[^|]+\|>', '', stream.result.text).strip()
            if text:
                chars += len(text)
                if chars > 160000 or len(segments) >= 10000:
                    raise ValueError('transcript exceeds budget; no silent truncation')
                segments.append({'start': round(start, 3), 'end': round(end, 3), 'text': text})
            vad.pop()

    try:
        while True:
            data = decoder.stdout.read(window * 2)
            if not data:
                break
            samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768
            count += len(samples)
            if count > 7200 * 16000:
                raise ValueError('decoded audio exceeds duration budget')
            vad.accept_waveform(samples)
            collect()
            if count % (window * 128) == 0:
                emit({'type': 'progress', 'seconds': round(count / 16000, 2)})
        vad.flush()
        collect()
        if decoder.wait(timeout=10) != 0 or count < duration * 16000 * 0.95:
            raise ValueError('incomplete audio decode')
        if not segments:
            raise ValueError('no intelligible speech detected')
        emit({'type': 'result', 'result': {'engine': 'SenseVoice-int8 / sherpa-onnx-2.0.1',
                                        'duration': round(count / 16000, 3), 'segments': segments}})
    finally:
        if decoder.poll() is None:
            decoder.kill()
            decoder.wait()


if __name__ == '__main__':
    main()
