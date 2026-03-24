---
name: avatar
description: 아바타 이미지로 말하는 영상 클립 생성 및 크로마키 합성. 아바타, avatar 시 사용.
allowed-tools: Bash(node *, ffmpeg *)
---

# 아바타 처리

아바타 이미지를 입력받아 KIE API로 말하는 영상 클립을 생성하고, FFmpeg로 메인 영상에 크로마키 합성합니다.

## 주요 기능
1. ONNX UltraFace 모델로 얼굴 인식
2. 얼굴 기반 원형 아바타 생성
3. KIE API로 오디오 클립별 말하는 영상 생성
4. FFmpeg로 크로마키 제거 및 메인 영상에 오버레이

## 필수 환경변수
- `KIE_API_KEY`
- `PUBLIC_BASE_URL`

## 설정
- `AVATAR_CLIP_CONCURRENCY`: 동시 처리 수 (기본 3)
- `AVATAR_MAX_POINTS`: 최대 클립 수 (기본 4)
- `AVATAR_MIN_SEC` / `AVATAR_MAX_SEC`: 클립 길이 범위
