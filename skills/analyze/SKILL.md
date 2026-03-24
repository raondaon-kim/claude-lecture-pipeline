---
name: analyze
description: 자막을 주제별 장면으로 분리하고 이미지 프롬프트 생성. 장면 분석, 프롬프트 생성, analyze 시 사용.
allowed-tools: Bash(node *)
---

# 장면 분석

검증된 자막을 주제별 장면으로 분리하고, 선택한 스타일 프로필에 맞는 이미지 생성 프롬프트를 작성합니다.

## 실행

```bash
NODE_PATH="${CLAUDE_PLUGIN_DATA}/node_modules" node "${CLAUDE_PLUGIN_ROOT}/scripts/analyze.js" --input ./output/subtitles/validated.json --output ./output/scenes/scenes.json --style modern
```

## 옵션

| 플래그 | 설명 | 기본값 |
|--------|------|--------|
| `--input` | 자막 JSON | (필수) |
| `--output` | 장면 JSON | `./output/scenes/scenes.json` |
| `--style` | 스타일 이름 (아래 목록 참조) | `presentation` |

## 사용 가능한 스타일

| 이름 | 설명 |
|------|------|
| `retro` | 레트로 — 빈티지 컬러, 대각선 레이아웃 |
| `whiteboard` | 화이트보드 — 손그림 스케치 스타일 |
| `fairytale` | 동화 — 수채화 동화책 분위기 |
| `watercolor` | 수채화 — 따뜻한 붓터치 페인팅 |
| `atelier` | 아뜰리에 — 따뜻한 일러스트레이션 |
| `popup` | 팝업북 — 3D 종이공예 느낌 |
| `cartoon` | 카툰 — 밝고 귀여운 만화 스타일 |
| `magazine` | 매거진 — 에디토리얼 잡지 레이아웃 |
| `modern` | 모던 — 깔끔한 현대적 디자인 |
| `report` | 리포트 — 데이터 중심 비즈니스 |
| `minimal` | 미니멀 — 여백 중심 심플 디자인 |
| `sketch` | 스케치 — 연필/크레파스 느낌 |
| `fairytale-illust` | 동화 일러스트 — 풀블리드 그림책 |
| `presentation` | 강의 슬라이드형 (기본) |
| `documentary` | 인포그래픽형 (텍스트 없음) |

## 필수 환경변수
- `ANTHROPIC_API_KEY`
