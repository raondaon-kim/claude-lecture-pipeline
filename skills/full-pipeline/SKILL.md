---
name: full-pipeline
description: MP3 입력으로 자막→분석→이미지→영상까지 전체 파이프라인 실행. 영상 만들기, 파이프라인 실행 시 사용.
allowed-tools: Bash(node *)
disable-model-invocation: true
---

# 전체 파이프라인

MP3 파일을 입력받아 5단계를 순차 실행합니다.

## 실행

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/index.js" --input $ARGUMENTS --style modern
```

## 단계
1. **transcribe**: MP3 → 자막 JSON (Whisper)
2. **validate**: 자막 문법 검증 (Claude)
3. **analyze**: 장면 분리 + 이미지 프롬프트 생성
4. **generate-images**: 장면별 이미지 생성 (Gemini)
5. **compose-video**: 영상 합성 (FFmpeg)

## 옵션

| 플래그 | 설명 | 기본값 |
|--------|------|--------|
| `--input` | MP3 파일 경로 | (필수) |
| `--output` | 출력 MP4 경로 | `./output/videos/output.mp4` |
| `--style` | 스타일 이름 (retro, whiteboard, fairytale, watercolor, atelier, popup, cartoon, magazine, modern, report, minimal, sketch, fairytale-illust, presentation, documentary) | `presentation` |
| `--no-subtitles` | 자막 미포함 | false |
| `--validate` | 자막 검증 포함 | false |

## 필수 환경변수
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`
