---
name: compose-video
description: 이미지+오디오+자막을 FFmpeg로 MP4 영상 합성. 영상 합성, 비디오 생성, compose 시 사용.
allowed-tools: Bash(node *, ffmpeg *)
---

# 영상 합성

이미지 시퀀스 + 오디오 + 자막을 FFmpeg로 합성하여 MP4를 생성합니다.

## 실행

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/compose-video.js" \
  --audio ./input/lecture.mp3 \
  --scenes ./output/scenes/scenes.json \
  --subtitles ./output/subtitles/validated.json \
  --style presentation
```

## 옵션

| 플래그 | 설명 | 기본값 |
|--------|------|--------|
| `--audio` | MP3 오디오 경로 | (필수) |
| `--scenes` | 장면 JSON 경로 | (필수) |
| `--subtitles` | 자막 JSON 경로 | 선택 |
| `--output` | 출력 MP4 경로 | `./output/videos/output.mp4` |
| `--images-dir` | 이미지 디렉토리 | `./output/images` |
| `--style` | `presentation` / `documentary` | `presentation` |
| `--no-subtitles` | 자막 미포함 | false |

## 출력
- `./output/videos/output.mp4` (1920x1080, H.264, AAC)

## 주의
- 시스템에 FFmpeg CLI가 PATH에 있어야 합니다
- 미설치 시 FFmpeg WASM으로 폴백
