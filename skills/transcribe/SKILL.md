---
name: transcribe
description: MP3 오디오를 Whisper API로 자막 JSON으로 변환. 음성인식, 자막 생성, transcribe 시 사용.
allowed-tools: Bash(node *)
---

# 음성 → 자막 변환

OpenAI Whisper API로 MP3를 타임스탬프 포함 자막 JSON으로 변환합니다.

## 실행

```bash
NODE_PATH="${CLAUDE_PLUGIN_DATA}/node_modules" node "${CLAUDE_PLUGIN_ROOT}/scripts/transcribe.js" --input $ARGUMENTS --output ./output/subtitles/raw.json
```

## 옵션

| 플래그 | 설명 | 기본값 |
|--------|------|--------|
| `--input` | MP3 파일 경로 | (필수) |
| `--output` | 출력 JSON 경로 | `./output/subtitles/raw.json` |
| `--chunk-duration` | 청크 분할 길이(초) | 600 |

## 입출력
- **입력**: MP3 파일 (25MB 초과 시 자동 청크 분할)
- **출력**: 타임스탬프 포함 자막 JSON (`segments[].start`, `segments[].end`, `segments[].text`)

## 필수 환경변수
- `OPENAI_API_KEY`
