---
name: lecture-script
description: Markdown을 TTS용 강의 스크립트로 변환. 강의 스크립트, lecture script 시 사용.
allowed-tools: Bash(node *)
---

# 강의 스크립트 변환

OCR된 Markdown을 TTS에 적합한 강의 스크립트 JSON으로 변환합니다.

## 실행

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lecture-script.js" --input ./output/ocr/document.md --output ./output/script.json
```

## 필수 환경변수
- `GOOGLE_API_KEY`
