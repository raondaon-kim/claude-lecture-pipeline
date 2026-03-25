---
name: tts
description: 텍스트를 TTS로 음성 생성. ElevenLabs 또는 edge-tts 자동 선택. TTS, 음성 생성, text to speech 시 사용.
allowed-tools: Bash(node *), Bash(python *)
---

# TTS 음성 생성

강의 스크립트를 음성으로 변환합니다. 청크 분할과 음성 생성 두 단계로 구성됩니다.

## TTS 엔진 선택

- `ELEVENLABS_API_KEY`가 있으면 → **ElevenLabs** (고품질)
- `ELEVENLABS_API_KEY`가 없으면 → **edge-tts** 자동 fallback (무료, Python 필요)
- `--engine edge-tts` 플래그로 강제 지정 가능

## 1단계: 청크 분할

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tts-chunk.js" --input ./output/script.json --output ./output/tts/chunks.json
```

## 2단계: 음성 생성

### ElevenLabs (기본)
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tts-generate.js" --input ./output/tts/chunks.json
```

### edge-tts (무료 대안)
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tts-generate.js" --input ./output/tts/chunks.json --engine edge-tts
```

### edge-tts 음성 변경
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tts-generate.js" --input ./output/tts/chunks.json --engine edge-tts --edge-voice ko-KR-SunHiNeural
```

사용 가능한 한국어 음성:
- `ko-KR-HyunsuMultilingualNeural` (남성, 기본값)
- `ko-KR-InJoonNeural` (남성)
- `ko-KR-SunHiNeural` (여성)

## 필수 환경변수
- `GOOGLE_API_KEY` (청크 분할용)
- `ELEVENLABS_API_KEY` (선택 — 없으면 edge-tts 사용)

## 필수 도구
- edge-tts 사용 시: `pip install edge-tts`
