---
name: generate-images
description: 장면 프롬프트로 Gemini 이미지 생성. 이미지 생성, Gemini, generate images 시 사용.
allowed-tools: Bash(node *)
---

# 이미지 생성

Google Gemini로 각 장면에 맞는 1920x1080 PNG 이미지를 생성합니다. 스타일 프로필이 자동으로 프롬프트에 반영됩니다.

## 실행

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/generate-images.js" --input ./output/scenes/scenes.json --output-dir ./output/images --style modern
```

## 옵션

| 플래그 | 설명 | 기본값 |
|--------|------|--------|
| `--input` | 장면 JSON | (필수) |
| `--output-dir` | 이미지 출력 디렉토리 | `./output/images` |
| `--manifest` | 메타데이터 JSON | `./output/images/manifest.json` |
| `--style` | 스타일 이름 (analyze 스킬 참조) | `presentation` |

## 출력
- `./output/images/scene_001_{style}.png` ...
- `./output/images/manifest.json`

## 필수 환경변수
- `GOOGLE_API_KEY`
