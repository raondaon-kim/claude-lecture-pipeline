---
name: pdf-ocr
description: PDF 문서를 Gemini로 OCR하여 Markdown으로 변환. PDF OCR, 텍스트 추출 시 사용.
allowed-tools: Bash(node *)
---

# PDF OCR

Google Gemini API로 PDF를 페이지별로 OCR하여 Markdown으로 변환합니다.

## 실행

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pdf-ocr.js" --input ./input/document.pdf --output ./output/ocr/document.md
```

## 옵션

| 플래그 | 설명 | 기본값 |
|--------|------|--------|
| `--input` | PDF 파일 경로 | (필수) |
| `--output` | Markdown 출력 경로 | 자동 생성 |

## 필수 환경변수
- `GOOGLE_API_KEY`
