import fs from 'fs';
import path from 'path';
import { createClaudeClient, claudeToolCall } from './claude-client.js';
import { runWithConcurrency, delay } from './concurrency.js';
import { loadConfig } from './config.js';
import { getStyleProfile, buildStyleGuidePrompt, isNoTextStyle } from './styles.js';

const DEFAULT_OUTPUT = './output/scenes/scenes.json';
const DEFAULT_CHUNK_SEC = 200;
const DEFAULT_STYLE = 'presentation';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_AVATAR_MAX_POINTS = 4;
const DEFAULT_AVATAR_MIN_SEC = 5;
const DEFAULT_AVATAR_MAX_SEC = 14;
const DEFAULT_AVATAR_MIN_GAP_SEC = 20;

const BASE_SYSTEM_PROMPT = `You are an expert educational content scene analyst.

Role:
Analyze subtitle content and split it into scenes based on topic and meaning, then write image prompts for each scene.

Rules:
1) Split by content shifts and topic transitions. Do NOT split by time length alone.
2) Use concrete content cues (examples, definitions, comparisons, steps, summaries) to define boundaries.
3) Each scene must include a content summary that reflects the segment text.
4) Each scene must include segmentRange(startId/endId) and ONLY use ids from input segments.

Return scenes with startTime, endTime, duration, topic, summary, content, keywords, segmentRange, and prompts.`;

/**
 * Build full system prompt with style profile injected.
 * @param {string} styleName
 * @returns {string}
 */
function buildSystemPrompt(styleName) {
  const profile = getStyleProfile(styleName);
  const styleGuide = buildStyleGuidePrompt(profile);
  const noText = isNoTextStyle(styleName);

  const promptRules = noText
    ? `Prompt rules:
- Cinematic / documentary photo style
- No text visible (no letters, no words)
- 16:9 aspect ratio
- Style guide: ${styleGuide}`
    : `Prompt rules:
- Educational slide/presentation style
- Korean title text is required
- Clean, professional layout
- Minimal background, high readability
- 16:9 aspect ratio
- Style guide: ${styleGuide}`;

  return `${BASE_SYSTEM_PROMPT}\n\n${promptRules}`;
}

// 하위 호환용: style 인자 없이 호출되는 곳을 위한 기본값
const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_STYLE);

const ANALYZE_CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startTime: { type: 'string' },
          endTime: { type: 'string' },
          duration: { type: 'number' },
          topic: { type: 'string' },
          summary: { type: 'string' },
          content: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          segmentRange: {
            type: 'object',
            properties: {
              startId: { type: 'integer' },
              endId: { type: 'integer' }
            },
            required: ['startId', 'endId']
          },
          prompts: {
            type: 'object',
            properties: {
              presentation: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' },
                  displayText: { type: 'string' },
                  subText: { type: 'string' }
                },
                required: ['prompt']
              },
              documentary: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' }
                },
                required: ['prompt']
              }
            }
          }
        },
        required: ['startTime', 'endTime', 'duration', 'topic', 'summary', 'content', 'keywords', 'segmentRange', 'prompts']
      }
    },
    avatarCandidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startId: { type: 'integer' },
          endId: { type: 'integer' },
          sceneId: { type: 'integer' },
          reason: { type: 'string' },
          score: { type: 'number' }
        },
        required: ['startId', 'endId']
      }
    }
  },
  required: ['scenes']
};

const ALIGN_SCENES_SCHEMA = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          segmentRange: {
            type: 'object',
            properties: {
              startId: { type: 'integer' },
              endId: { type: 'integer' }
            },
            required: ['startId', 'endId']
          }
        },
        required: ['id', 'segmentRange']
      }
    }
  },
  required: ['scenes']
};

/**
 * Ensure a directory exists.
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * Validate input file exists.
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function assertFileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (error) {
    throw new Error(`Input file not found: ${filePath}`);
  }
}

/**
 * Left-pad a number with zeros.
 * @param {number} num
 * @param {number} length
 * @returns {string}
 */
function pad(num, length = 2) {
  return num.toString().padStart(length, '0');
}

/**
 * Format seconds to timecode (HH:MM:SS.mmm).
 * @param {number} seconds
 * @returns {string}
 */
function formatTimecode(seconds) {
  const safeSeconds = Math.max(0, seconds);
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = Math.floor(safeSeconds % 60);
  const ms = Math.round((safeSeconds % 1) * 1000);

  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * Parse timecode (HH:MM:SS.mmm) into seconds.
 * @param {string} timecode
 * @returns {number|null}
 */
function parseTimecode(timecode) {
  if (typeof timecode !== 'string') {
    return null;
  }

  const match = timecode.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = match[4] ? Number(match[4].padEnd(3, '0')) : 0;

  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * Normalize prompt fields into prompts object.
 * @param {Record<string, any>} scene
 * @param {string} defaultStyle
 * @returns {Record<string, any>}
 */
function normalizeScenePrompts(scene, defaultStyle) {
  const prompts = (scene.prompts && typeof scene.prompts === 'object') ? { ...scene.prompts } : {};
  const styleHint = typeof scene.style === 'string' ? scene.style.toLowerCase() : '';
  const guessedStyle = styleHint.includes('doc')
    ? 'documentary'
    : styleHint.includes('present')
      ? 'presentation'
      : defaultStyle;

  const fallbackPrompt = typeof scene.prompt === 'string' ? scene.prompt : null;
  const presentationPrompt = typeof scene.presentationPrompt === 'string' ? scene.presentationPrompt : null;
  const documentaryPrompt = typeof scene.documentaryPrompt === 'string' ? scene.documentaryPrompt : null;

  if (presentationPrompt && !prompts.presentation?.prompt) {
    prompts.presentation = {
      prompt: presentationPrompt,
      displayText: scene.title || scene.topic || '',
      subText: scene.summary || ''
    };
  }

  if (documentaryPrompt && !prompts.documentary?.prompt) {
    prompts.documentary = { prompt: documentaryPrompt };
  }

  if (fallbackPrompt && !prompts[guessedStyle]?.prompt) {
    prompts[guessedStyle] = {
      prompt: fallbackPrompt,
      displayText: scene.title || scene.topic || '',
      subText: scene.summary || ''
    };
  }

  return { ...scene, prompts };
}

/**
 * Build a lookup map from subtitle segment id to segment.
 * @param {Array<{id: number, start: number, end: number, text: string}>} segments
 * @returns {Map<number, {id: number, start: number, end: number, text: string}>}
 */
function buildSegmentMap(segments) {
  const map = new Map();
  for (const segment of segments || []) {
    if (Number.isFinite(segment?.id)) {
      map.set(segment.id, segment);
    }
  }
  return map;
}

/**
 * Apply segmentRange to compute start/end/duration for a scene.
 * @param {Record<string, any>} scene
 * @param {Map<number, {id: number, start: number, end: number, text: string}>} segmentMap
 * @returns {Record<string, any> | null}
 */
function applySegmentRange(scene, segmentMap) {
  const range = scene?.segmentRange;
  if (!range) return null;
  const startId = Number(range.startId);
  const endId = Number(range.endId);
  if (!Number.isFinite(startId) || !Number.isFinite(endId)) return null;
  const startSeg = segmentMap.get(startId);
  const endSeg = segmentMap.get(endId);
  if (!startSeg || !endSeg) return null;
  const aligned = { ...scene };
  aligned.startTime = formatTimecode(startSeg.start);
  aligned.endTime = formatTimecode(endSeg.end);
  aligned.duration = Number((endSeg.end - startSeg.start).toFixed(3));
  return aligned;
}

/**
 * Split subtitle segments into time-based chunks.
 * @param {Array<{id: number, start: number, end: number, text: string}>} segments
 * @param {number} maxDurationSec
 * @returns {Array<{start: number, end: number, text: string, segments: Array}>}
 */
function splitIntoChunks(segments, maxDurationSec) {
  if (!segments || segments.length === 0) {
    return [];
  }

  const chunks = [];
  let current = [];
  let chunkStart = segments[0].start;
  let chunkEnd = segments[0].end;

  for (const segment of segments) {
    const nextEnd = segment.end;
    const duration = nextEnd - chunkStart;

    if (current.length > 0 && duration > maxDurationSec) {
      const text = current.map((item) => item.text).join(' ');
      chunks.push({
        start: chunkStart,
        end: chunkEnd,
        text,
        segments: current
      });
      current = [];
      chunkStart = segment.start;
    }

    current.push(segment);
    chunkEnd = segment.end;
  }

  if (current.length > 0) {
    const text = current.map((item) => item.text).join(' ');
    chunks.push({
      start: chunkStart,
      end: chunkEnd,
      text,
      segments: current
    });
  }

  return chunks;
}

/**
 * Normalize scenes with IDs and computed time fields.
 * @param {Array<Record<string, any>>} scenes
 * @param {number} startId
 * @returns {{scenes: Array<Record<string, any>>, nextId: number}}
 */
function normalizeScenes(scenes, startId) {
  let currentId = startId;
  const normalized = scenes.map((scene) => {
    const startSec = typeof scene.startTime === 'number'
      ? scene.startTime
      : (parseTimecode(scene.startTime) ?? (typeof scene.start === 'number' ? scene.start : null));
    const endSec = typeof scene.endTime === 'number'
      ? scene.endTime
      : (parseTimecode(scene.endTime) ?? (typeof scene.end === 'number' ? scene.end : null));

    const normalizedScene = { ...scene };
    normalizedScene.id = currentId;

    if (startSec !== null) {
      normalizedScene.startTime = formatTimecode(startSec);
    }
    if (endSec !== null) {
      normalizedScene.endTime = formatTimecode(endSec);
    }
    if (normalizedScene.duration == null && startSec !== null && endSec !== null) {
      const duration = Math.max(0, endSec - startSec);
      normalizedScene.duration = Number(duration.toFixed(3));
    }

    currentId += 1;
    return normalizedScene;
  });

  return { scenes: normalized, nextId: currentId };
}

/**
 * content 텍스트와 매칭되는 자막 찾기
 * @param {string} content - 장면의 content 텍스트
 * @param {Array} subtitles - 자막 배열
 * @param {'first'|'last'} position - 첫 번째 또는 마지막 매칭
 * @returns {object|null} 매칭된 자막 세그먼트
 */
function findMatchingSubtitle(content, subtitles, position) {
  const matches = subtitles.filter((sub) => {
    const subText = (sub.text || '').trim();
    return subText && content.includes(subText);
  });

  if (matches.length === 0) return null;

  matches.sort((a, b) => a.start - b.start);
  return position === 'first' ? matches[0] : matches[matches.length - 1];
}

/**
 * 장면 시간값을 자막 기준으로 보정
 * @param {Array} scenes - 장면 배열
 * @param {Array} subtitles - 자막 세그먼트 배열
 * @returns {Array} 보정된 장면 배열
 */
function alignSceneTimesToSubtitles(scenes, subtitles) {
  const segmentMap = buildSegmentMap(subtitles);
  return scenes.map((scene) => {
    const fromRange = applySegmentRange(scene, segmentMap);
    if (fromRange) {
      return fromRange;
    }
    const content = scene.content || '';

    const firstMatch = findMatchingSubtitle(content, subtitles, 'first');
    const lastMatch = findMatchingSubtitle(content, subtitles, 'last');

    const aligned = { ...scene };
    if (firstMatch) {
      aligned.startTime = formatTimecode(firstMatch.start);
    }
    if (lastMatch) {
      aligned.endTime = formatTimecode(lastMatch.end);
    }

    if (firstMatch && lastMatch) {
      aligned.duration = Number((lastMatch.end - firstMatch.start).toFixed(3));
    }

    return aligned;
  });
}

/**
 * Clamp avatar segment range to satisfy min/max duration while keeping subtitle boundaries.
 * @param {{startId: number, endId: number, sceneId?: number, reason?: string, score?: number}} candidate
 * @param {Array<{id:number,start:number,end:number,text:string}>} segments
 * @param {Map<number, number>} indexById
 * @param {{minSec:number,maxSec:number}} limits
 * @returns {null | {
 *   sceneId: number | null,
 *   startId: number,
 *   endId: number,
 *   startSec: number,
 *   endSec: number,
 *   durationSec: number,
 *   reason: string,
 *   score: number
 * }}
 */
function normalizeAvatarCandidate(candidate, segments, indexById, limits) {
  const rawStartId = Number(candidate?.startId);
  const rawEndId = Number(candidate?.endId);
  if (!Number.isFinite(rawStartId) || !Number.isFinite(rawEndId)) return null;
  if (!indexById.has(rawStartId) || !indexById.has(rawEndId)) return null;

  let startIdx = indexById.get(rawStartId);
  let endIdx = indexById.get(rawEndId);
  if (startIdx > endIdx) {
    [startIdx, endIdx] = [endIdx, startIdx];
  }

  const getDuration = () => Math.max(0, segments[endIdx].end - segments[startIdx].start);

  while (startIdx < endIdx && getDuration() > limits.maxSec) {
    endIdx -= 1;
  }

  while (endIdx < segments.length - 1 && getDuration() < limits.minSec) {
    endIdx += 1;
  }

  const durationSec = Number(getDuration().toFixed(3));
  if (durationSec < limits.minSec || durationSec > limits.maxSec) {
    return null;
  }

  const sceneId = Number.isFinite(Number(candidate?.sceneId)) ? Number(candidate.sceneId) : null;
  const score = Number.isFinite(Number(candidate?.score))
    ? Number(candidate.score)
    : 0.5;
  const reason = typeof candidate?.reason === 'string' && candidate.reason.trim()
    ? candidate.reason.trim()
    : '핵심 설명 구간';

  return {
    sceneId,
    startId: Number(segments[startIdx].id),
    endId: Number(segments[endIdx].id),
    startSec: Number(segments[startIdx].start.toFixed(3)),
    endSec: Number(segments[endIdx].end.toFixed(3)),
    durationSec,
    reason,
    score
  };
}

/**
 * Check whether two avatar points violate minimum spacing.
 * @param {{startSec:number,endSec:number}} a
 * @param {{startSec:number,endSec:number}} b
 * @param {number} minGapSec
 * @returns {boolean}
 */
function isAvatarPointTooClose(a, b, minGapSec) {
  const aAfterB = a.startSec >= b.endSec + minGapSec;
  const bAfterA = b.startSec >= a.endSec + minGapSec;
  return !(aAfterB || bAfterA);
}

/**
 * Build avatar overlay plan from scene/candidate data.
 * @param {{
 *  scenes: Array<Record<string, any>>,
 *  segments: Array<{id:number,start:number,end:number,text:string}>,
 *  candidates?: Array<Record<string, any>>,
 *  avatarEnabled?: boolean,
 *  maxPoints?: number,
 *  minSec?: number,
 *  maxSec?: number,
 *  minGapSec?: number
 * }} options
 * @returns {{version:number,maxPoints:number,points:Array<Record<string, any>>}}
 */
function buildAvatarPlan(options) {
  const {
    scenes,
    segments,
    candidates = [],
    avatarEnabled = false,
    maxPoints = DEFAULT_AVATAR_MAX_POINTS,
    minSec = DEFAULT_AVATAR_MIN_SEC,
    maxSec = DEFAULT_AVATAR_MAX_SEC,
    minGapSec = DEFAULT_AVATAR_MIN_GAP_SEC
  } = options;

  const safeMaxPoints = Math.max(1, Math.floor(maxPoints));
  const plan = {
    version: 1,
    maxPoints: safeMaxPoints,
    points: []
  };
  if (!avatarEnabled || !Array.isArray(segments) || segments.length === 0) {
    return plan;
  }

  const indexById = new Map();
  segments.forEach((segment, idx) => {
    if (Number.isFinite(Number(segment?.id))) {
      indexById.set(Number(segment.id), idx);
    }
  });

  const sceneFallbackCandidates = Array.isArray(scenes)
    ? scenes
      .filter((scene) => scene?.segmentRange?.startId != null && scene?.segmentRange?.endId != null)
      .map((scene) => ({
        startId: scene.segmentRange.startId,
        endId: scene.segmentRange.endId,
        sceneId: scene.id,
        reason: scene.topic || '핵심 설명 구간',
        score: 0.5
      }))
    : [];

  const merged = [...candidates, ...sceneFallbackCandidates];
  const normalized = merged
    .map((candidate) => normalizeAvatarCandidate(candidate, segments, indexById, { minSec, maxSec }))
    .filter(Boolean);

  normalized.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.startSec - b.startSec;
  });

  // 영상 시작 부분에 고정 아바타 포인트 삽입
  const firstSeg = segments[0];
  const openingStartSec = typeof firstSeg?.start === 'number' ? firstSeg.start : 0;
  const firstSceneDur = Array.isArray(scenes) && scenes.length > 0 && Number.isFinite(scenes[0].duration)
    ? scenes[0].duration
    : maxSec;
  const openingDurationSec = Math.min(maxSec, Math.max(minSec, firstSceneDur));
  const openingPoint = {
    startSec: openingStartSec,
    endSec: openingStartSec + openingDurationSec,
    durationSec: openingDurationSec,
    sceneId: Array.isArray(scenes) && scenes.length > 0 ? scenes[0].id : null,
    reason: '영상 시작 인사',
    score: 1.0
  };

  const selected = [openingPoint];
  const remainingSlots = safeMaxPoints - 1;
  for (const candidate of normalized) {
    if (selected.length >= safeMaxPoints) break;
    const conflict = selected.some((existing) => isAvatarPointTooClose(candidate, existing, minGapSec));
    if (conflict) continue;
    selected.push(candidate);
  }

  selected.sort((a, b) => a.startSec - b.startSec);
  plan.points = selected.map((point, index) => ({
    id: `A${index + 1}`,
    sceneId: Number.isFinite(point.sceneId) ? point.sceneId : null,
    startSec: point.startSec,
    endSec: point.endSec,
    durationSec: point.durationSec,
    reason: point.reason,
    score: Number(point.score.toFixed(3)),
    audioClipRelative: `output/jobs/{id}/avatar/clips/audio/avatar_clip_${String(index + 1).padStart(2, '0')}.mp3`,
    avatarVideoRelative: `output/jobs/{id}/avatar/clips/video/avatar_clip_${String(index + 1).padStart(2, '0')}.mp4`,
    state: 'planned'
  }));

  return plan;
}

/**
 * Ask Claude to align scenes to subtitle segment ranges.
 * @param {Anthropic} client
 * @param {string} model
 * @param {Array<Record<string, any>>} scenes
 * @param {Array<{id: number, start: number, end: number, text: string}>} segments
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function alignScenesWithSegments(client, model, scenes, segments) {
  const payload = {
    scenes: scenes.map((scene) => ({
      id: scene.id,
      topic: scene.topic || '',
      summary: scene.summary || '',
      content: scene.content || ''
    })),
    segments: segments.map((segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      text: segment.text
    }))
  };

  const prompt = `Re-assign segment ranges for each scene using the segments below.
Use ONLY the provided segment ids. Each scene must have segmentRange { startId, endId }.
Match by content/meaning, not by time length. Keep the same scene ids.

${JSON.stringify(payload)}`;

  const parsed = await claudeToolCall({
    client,
    model,
    system: SYSTEM_PROMPT,
    userMessage: prompt,
    toolName: 'align_scenes',
    inputSchema: ALIGN_SCENES_SCHEMA,
    maxTokens: 4096
  });

  const alignedScenes = Array.isArray(parsed?.scenes) ? parsed.scenes : null;
  if (!alignedScenes) {
    throw new Error('Model response does not contain scenes.');
  }

  const rangeById = new Map();
  alignedScenes.forEach((scene) => {
    if (scene?.id != null && scene?.segmentRange) {
      rangeById.set(scene.id, scene.segmentRange);
    }
  });

  return scenes.map((scene) => {
    const segmentRange = rangeById.get(scene.id);
    if (!segmentRange) return scene;
    return { ...scene, segmentRange };
  });
}

/**
 * Re-time existing scenes against updated subtitle segments.
 * Keeps scene structure/content as-is and updates only segmentRange + time fields.
 * @param {{scenes: Array<Record<string, any>>, subtitles: {segments: Array<{id: number, start: number, end: number, text: string}>}, model?: string}} options
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function retimeScenesWithSegments(options) {
  const {
    scenes,
    subtitles,
    model = DEFAULT_MODEL
  } = options || {};

  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('retimeScenesWithSegments requires a non-empty scenes array.');
  }
  const segments = Array.isArray(subtitles?.segments) ? subtitles.segments : [];
  if (segments.length === 0) {
    throw new Error('retimeScenesWithSegments requires subtitles.segments.');
  }

  const { anthropicApiKey } = loadConfig();
  const client = createClaudeClient(anthropicApiKey);
  const payload = {
    scenes: scenes.map((scene) => ({
      id: scene.id,
      topic: scene.topic || '',
      summary: scene.summary || '',
      content: scene.content || '',
      keywords: Array.isArray(scene.keywords) ? scene.keywords : []
    })),
    segments: segments.map((segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      text: segment.text
    }))
  };

  const systemPrompt = `You map existing scenes to subtitle segments.
Strict rules:
1) Do NOT create/delete scenes. Keep the same scene ids only.
2) Do NOT rewrite topic/summary/content/prompts/keywords.
3) Return only segmentRange for each scene id.
4) Use ONLY input segment ids.
5) Match by meaning, not by duration.`;

  const parsed = await claudeToolCall({
    client,
    model,
    system: systemPrompt,
    userMessage: JSON.stringify(payload),
    toolName: 'align_scenes',
    inputSchema: ALIGN_SCENES_SCHEMA,
    maxTokens: 4096
  });

  const returnedScenes = Array.isArray(parsed?.scenes) ? parsed.scenes : [];
  const rangeById = new Map();
  returnedScenes.forEach((scene) => {
    if (scene?.id == null || !scene?.segmentRange) return;
    const startId = Number(scene.segmentRange.startId);
    const endId = Number(scene.segmentRange.endId);
    if (!Number.isFinite(startId) || !Number.isFinite(endId)) return;
    rangeById.set(Number(scene.id), { startId, endId });
  });

  const withRanges = scenes.map((scene) => {
    const range = rangeById.get(Number(scene.id));
    if (!range) return scene;
    return { ...scene, segmentRange: range };
  });

  const segmentMap = buildSegmentMap(segments);
  const fallbackTimed = alignSceneTimesToSubtitles(withRanges, segments);
  return withRanges.map((scene, index) => {
    const ranged = applySegmentRange(scene, segmentMap);
    if (ranged) return ranged;
    return fallbackTimed[index] || scene;
  });
}

/**
 * Call Claude to analyze a subtitle chunk.
 * @param {Anthropic} client
 * @param {string} model
 * @param {object} chunk
 * @param {number} maxTokens
 * @returns {Promise<{scenes: Array<Record<string, any>>, avatarCandidates: Array<Record<string, any>>}>}
 */
async function analyzeChunk(client, model, chunk, maxTokens = 16384, style = DEFAULT_STYLE) {
  const payload = {
    startTime: formatTimecode(chunk.start),
    endTime: formatTimecode(chunk.end),
    duration: Number((chunk.end - chunk.start).toFixed(3)),
    text: chunk.text,
    segments: chunk.segments.map((segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      text: segment.text
    }))
  };

  const prompt = `Analyze the following subtitle chunk and split into scenes by content.
For each scene, generate image prompts and include segmentRange(startId/endId) using the provided segments.
Also return optional avatarCandidates for talking-head overlay windows.
avatarCandidates rules:
- Use only segment ids from the input.
- Prefer semantically important speaking moments (definition, recap, key transition).
- Keep candidate duration naturally between 5 and 14 seconds when possible.

${JSON.stringify(payload)}`;

  const parsed = await claudeToolCall({
    client,
    model,
    system: buildSystemPrompt(style),
    userMessage: prompt,
    toolName: 'analyze_chunk',
    inputSchema: ANALYZE_CHUNK_SCHEMA,
    maxTokens
  });

  if (Array.isArray(parsed?.scenes)) {
    return {
      scenes: parsed.scenes,
      avatarCandidates: Array.isArray(parsed?.avatarCandidates) ? parsed.avatarCandidates : []
    };
  }

  throw new Error('Model response does not contain scenes.');
}


/**
 * Analyze validated subtitles to produce scene prompts.
 * @param {{input: string, output?: string, chunkDurationSec?: number, style?: string, model?: string, concurrency?: number, avatarEnabled?: boolean, avatarMaxPoints?: number, avatarMinSec?: number, avatarMaxSec?: number, avatarMinGapSec?: number}} options
 * @returns {Promise<{outputPath: string, scenes: number}>}
 */
export async function analyzeScenes(options) {
  const {
    input,
    output = DEFAULT_OUTPUT,
    chunkDurationSec = DEFAULT_CHUNK_SEC,
    style = DEFAULT_STYLE,
    model = DEFAULT_MODEL,
    concurrency = 2,
    avatarEnabled = false,
    avatarMaxPoints = DEFAULT_AVATAR_MAX_POINTS,
    avatarMinSec = DEFAULT_AVATAR_MIN_SEC,
    avatarMaxSec = DEFAULT_AVATAR_MAX_SEC,
    avatarMinGapSec = DEFAULT_AVATAR_MIN_GAP_SEC
  } = options;
  if (!input) {
    throw new Error('Missing required option: input');
  }

  await assertFileExists(input);
  const { anthropicApiKey } = loadConfig();
  const client = createClaudeClient(anthropicApiKey);

  await ensureDir(path.dirname(output));

  const raw = await fs.promises.readFile(input, 'utf-8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error('Input file is not valid JSON.');
  }

  if (!Array.isArray(payload?.segments)) {
    throw new Error('Input JSON must contain a segments array.');
  }

  const segments = payload.segments;
  const resolvedChunkSec = Number.isFinite(chunkDurationSec)
    ? chunkDurationSec
    : DEFAULT_CHUNK_SEC;
  const chunks = splitIntoChunks(segments, resolvedChunkSec);

  const resolvedConcurrency = Math.max(1, Number(concurrency) || 2);

  const maxRetries = 3;
  const chunkResults = await runWithConcurrency(chunks, resolvedConcurrency, async (chunk, index) => {
    console.log(`Analyzing chunk ${index + 1}/${chunks.length}`);
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        return await analyzeChunk(client, model, chunk, attempt > 2 ? 24576 : undefined, style);
      } catch (error) {
        if (attempt === maxRetries) throw error;
        console.warn(`Chunk ${index + 1} attempt ${attempt} failed: ${error.message}. Retrying...`);
        await delay(2000 * attempt);
      }
    }
  });

  const allScenes = [];
  const allAvatarCandidates = [];
  let nextId = 1;
  for (const chunkResult of chunkResults) {
    const chunkScenes = Array.isArray(chunkResult?.scenes) ? chunkResult.scenes : [];
    const chunkCandidates = Array.isArray(chunkResult?.avatarCandidates) ? chunkResult.avatarCandidates : [];
    const normalized = normalizeScenes(chunkScenes, nextId);
    allScenes.push(...normalized.scenes);
    allAvatarCandidates.push(...chunkCandidates);
    nextId = normalized.nextId;
  }

  const totalDurationSec = typeof payload.duration === 'number'
    ? payload.duration
    : (segments.length > 0 ? segments[segments.length - 1].end : 0);

  let rematchedScenes = allScenes;
  try {
    rematchedScenes = await alignScenesWithSegments(client, model, allScenes, segments);
    console.log('Aligned scenes with subtitle segments');
  } catch (error) {
    console.warn(`Scene/segment alignment failed; using original scenes. (${error.message})`);
  }

  const promptedScenes = rematchedScenes.map((scene) => normalizeScenePrompts(scene, style));
  const normalizedScenes = alignSceneTimesToSubtitles(promptedScenes, segments);
  console.log('Aligned scene times to subtitle timestamps');
  const avatarPlan = buildAvatarPlan({
    scenes: normalizedScenes,
    segments,
    candidates: allAvatarCandidates,
    avatarEnabled,
    maxPoints: avatarMaxPoints,
    minSec: avatarMinSec,
    maxSec: avatarMaxSec,
    minGapSec: avatarMinGapSec
  });

  const outputPayload = {
    metadata: {
      totalDuration: formatTimecode(totalDurationSec),
      totalScenes: normalizedScenes.length,
      imageStyle: style
    },
    scenes: normalizedScenes,
    avatarPlan
  };

  await fs.promises.writeFile(output, JSON.stringify(outputPayload, null, 2));
  console.log(`Saved scenes to ${output}`);

  return { outputPath: output, scenes: normalizedScenes.length };
}

/**
 * Parse CLI arguments for analyze command.
 * @param {string[]} argv
 * @returns {{input?: string, output?: string, chunkDurationSec?: number, style?: string, help?: boolean}}
 */
function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help') {
      args.help = true;
    } else if (token === '--input') {
      args.input = argv[i + 1];
      i += 1;
    } else if (token === '--output') {
      args.output = argv[i + 1];
      i += 1;
    } else if (token === '--chunk-duration') {
      args.chunkDurationSec = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--style') {
      args.style = argv[i + 1];
      i += 1;
    } else if (token === '--model') {
      args.model = argv[i + 1];
      i += 1;
    } else if (token === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--avatar-enabled') {
      args.avatarEnabled = argv[i + 1] === 'true';
      i += 1;
    } else if (token === '--avatar-max-points') {
      args.avatarMaxPoints = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--avatar-min-sec') {
      args.avatarMinSec = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--avatar-max-sec') {
      args.avatarMaxSec = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--avatar-min-gap-sec') {
      args.avatarMinGapSec = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

/**
 * Print usage for the analyze command.
 * @returns {void}
 */
function printUsage() {
  console.log('Usage: node src/analyze.js --input ./output/subtitles/validated.json');
  console.log('Options:');
  console.log('  --output ./output/scenes/scenes.json');
  console.log('  --chunk-duration 600');
  console.log('  --style retro|whiteboard|fairytale|watercolor|atelier|popup|cartoon|magazine|modern|report|minimal|sketch|fairytale-illust|presentation|documentary');
  console.log(`  --model ${DEFAULT_MODEL}`);
  console.log('  --avatar-enabled true|false');
  console.log('  --avatar-max-points 3');
  console.log('  --avatar-min-sec 5');
  console.log('  --avatar-max-sec 14');
  console.log('  --avatar-min-gap-sec 20');
}

if (process.argv[1] && process.argv[1].endsWith('analyze.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  analyzeScenes(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
