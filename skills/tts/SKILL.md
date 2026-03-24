---
name: tts
description: 텍스트를 ElevenLabs TTS로 음성 생성. TTS, 음성 생성, text to speech 시 사용.
allowed-tools: Bash(node *)
---

# TTS 음성 생성

강의 스크립트를 ElevenLabs API로 음성으로 변환합니다. 청크 분할과 음성 생성 두 단계로 구성됩니다.

## 1단계: 청크 분할

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tts-chunk.js" --input ./output/script.json --output ./output/tts/chunks.json
```

## 2단계: 음성 생성

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tts-generate.js" --input ./output/tts/chunks.json --audio-dir ./output/tts/audio --merged ./output/audio/merged.mp3
```

## 필수 환경변수
- `GOOGLE_API_KEY` (청크 분할용)
- `ELEVENLABS_API_KEY` (음성 생성용)
