# lecture-pipeline

> Claude Code Plugin: 강의 MP3/PDF를 자막, 이미지, 영상으로 자동 변환하는 파이프라인

## 설치

### 1. 마켓플레이스 등록

Claude Code 에서 `/plugin` → **Marketplaces** 탭 → URL 입력:

```
https://github.com/raondaon-kim/claude-lecture-pipeline.git
```

### 2. 플러그인 설치

`/plugin` → **Plugins** 탭 → `lecture-pipeline` 설치 (Enable)

### 3. 환경변수 설정

작업 디렉토리에 `.env` 파일을 생성합니다:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Claude API (자막 검증, 강의 스크립트)
GOOGLE_API_KEY=AIza...             # Gemini API (PDF OCR, 이미지 생성)
OPENAI_API_KEY=sk-...              # Whisper API (음성인식)
ELEVENLABS_API_KEY=...             # ElevenLabs (TTS 음성 합성)
```

### 4. 외부 도구

- **FFmpeg**: 영상 합성에 필요. [다운로드](https://ffmpeg.org/download.html) 후 PATH에 추가
- **Node.js**: v18 이상

---

## 사용법

### 빠른 시작

Claude Code를 실행하면 `@pipeline-orchestrator`가 자동 활성화됩니다.

```
"chapter 1.pdf"를 카툰 스타일로 영상 만들어줘
```

오케스트레이터가 자동으로 전체 파이프라인을 순서대로 실행합니다.
스타일을 지정하지 않으면 사용 가능한 스타일 목록을 보여주고 선택을 요청합니다.

### 개별 스킬 호출

각 단계를 수동으로 실행할 수도 있습니다:

```
/lecture-pipeline:pdf-ocr "chapter 1.pdf"
/lecture-pipeline:lecture-script ./output/ocr/chapter1.md
/lecture-pipeline:tts ./output/script.json
/lecture-pipeline:analyze ./output/script.json --style cartoon
/lecture-pipeline:generate-images ./output/scenes.json
/lecture-pipeline:compose-video
```

---

## 파이프라인 흐름

### PDF 입력 (7단계)

```
PDF
 ├─ 1. pdf-ocr         → Markdown (Gemini OCR)
 ├─ 2. lecture-script   → 강의 스크립트 JSON (Claude Haiku 4.5)
 ├─ 3. tts              → MP3 음성 (ElevenLabs)
 ├─ 4. analyze          → 장면 분리 + 이미지 프롬프트 (Claude)
 ├─ 5. generate-images  → 장면별 이미지 (Gemini)
 ├─ 6. compose-video    → MP4 영상 합성 (FFmpeg)
 └─ 7. avatar           → (선택) 아바타 오버레이
```

### MP3 입력 (5단계)

```
MP3
 ├─ 1. transcribe       → 자막 JSON (Whisper)
 ├─ 2. validate         → 문법 교정 (Claude)
 ├─ 3. analyze          → 장면 분리 + 이미지 프롬프트
 ├─ 4. generate-images  → 장면별 이미지
 └─ 5. compose-video    → MP4 영상 합성
```

---

## 스타일 템플릿

14종의 시각 스타일을 지원합니다. `analyze` 단계에서 `--style` 옵션으로 지정합니다.

| 스타일 | 설명 | 시각 밀도 |
|--------|------|-----------|
| `retro` | 레트로 구성주의, 빈티지 질감 | high |
| `whiteboard` | 화이트보드 스케치, 손그림 느낌 | medium |
| `fairytale` | 동화풍, 수채화 파스텔톤 | high |
| `watercolor` | 수채화, 디지털 과슈 텍스처 | high |
| `atelier` | 아틀리에, 따뜻한 수채화 일러스트 | high |
| `popup` | 팝업북, 3D 페이퍼컷 느낌 | high |
| `cartoon` | 카툰, 굵은 아웃라인 벡터 아트 | high |
| `magazine` | 매거진, 미니멀 에디토리얼 | medium |
| `modern` | 모던, 플랫 미니멀 디자인 | medium |
| `report` | 리포트, 데이터 중심 비즈니스 | low |
| `minimal` | 미니멀, 여백과 타이포 중심 | low |
| `sketch` | 스케치, 연필/흑연 드로잉 | high |
| `presentation` | 강의 슬라이드형 | medium |
| `documentary` | 인포그래픽형 | medium |

---

## 출력 구조

```
output/
├── ocr/
│   └── chapter1.md          # PDF OCR 결과
├── script.json              # 강의 스크립트
├── tts/
│   ├── chunk_001.mp3        # TTS 청크 파일들
│   └── final_merged.mp3     # 병합된 음성
├── scenes.json              # 장면 분석 결과
├── images/
│   ├── scene_001.png        # 장면별 이미지
│   └── scene_002.png
└── final_lecture_video.mp4  # 최종 영상
```

---

## 플러그인 구조

```
lecture-pipeline/
├── .claude-plugin/
│   ├── plugin.json          # 플러그인 매니페스트
│   └── marketplace.json     # 마켓플레이스 설정
├── agents/
│   └── pipeline-orchestrator.md  # 오케스트레이터 에이전트
├── skills/
│   ├── pdf-ocr/SKILL.md
│   ├── lecture-script/SKILL.md
│   ├── tts/SKILL.md
│   ├── transcribe/SKILL.md
│   ├── validate/SKILL.md
│   ├── analyze/SKILL.md
│   ├── generate-images/SKILL.md
│   ├── compose-video/SKILL.md
│   ├── avatar/SKILL.md
│   └── full-pipeline/SKILL.md
├── hooks/
│   └── hooks.json           # SessionStart 자동 npm install
├── scripts/                 # Node.js 실행 스크립트
│   ├── pdf-ocr.js
│   ├── lecture-script.js
│   ├── tts-generate.js
│   ├── tts-chunk.js
│   ├── transcribe.js
│   ├── validate.js
│   ├── analyze.js
│   ├── generate-images.js
│   ├── compose-video.js
│   ├── avatar.js
│   ├── styles.js            # 14종 스타일 프로필
│   ├── claude-client.js     # Anthropic API 클라이언트
│   ├── config.js
│   └── concurrency.js
├── settings.json            # 기본 에이전트 설정
├── model/                   # 얼굴 인식 모델 (아바타용)
└── package.json
```

---

## 필요 API 키

| 서비스 | 용도 | 필수 |
|--------|------|------|
| Anthropic (Claude) | 자막 검증, 강의 스크립트, 장면 분석 | O |
| Google (Gemini) | PDF OCR, 이미지 생성 | O |
| OpenAI (Whisper) | 음성인식 (MP3 입력 시) | MP3 모드만 |
| ElevenLabs | TTS 음성 합성 (PDF 입력 시) | PDF 모드만 |

---

## 라이선스

Private
