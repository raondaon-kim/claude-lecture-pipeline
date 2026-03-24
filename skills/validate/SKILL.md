---
name: validate
description: Whisper 자막의 문법과 맞춤법을 Claude로 검증 및 교정. 자막 검증, 맞춤법 교정 시 사용.
allowed-tools: Bash(node *)
---

# 자막 검증

Claude Sonnet으로 자막 문법/맞춤법을 검증하고 교정합니다. 타임스탬프는 보존됩니다.

## 실행

```bash
NODE_PATH="${CLAUDE_PLUGIN_DATA}/node_modules" node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.js" --input ./output/subtitles/raw.json --output ./output/subtitles/validated.json
```

## 옵션

| 플래그 | 설명 | 기본값 |
|--------|------|--------|
| `--input` | 원본 자막 JSON | (필수) |
| `--output` | 교정된 자막 JSON | `./output/subtitles/validated.json` |
| `--batch-size` | 배치 크기 | 10 |

## 필수 환경변수
- `ANTHROPIC_API_KEY`
