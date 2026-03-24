import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { runWithConcurrency } from './concurrency.js';

const KIE_CREATE_TASK_URL = 'https://api.kie.ai/api/v1/jobs/createTask';
const KIE_RECORD_INFO_URL = 'https://api.kie.ai/api/v1/jobs/recordInfo';
const KIE_FILE_STREAM_UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';
const KIE_MODEL = 'kling/ai-avatar-pro';

const DEFAULT_MAX_POINTS = 4;
const DEFAULT_MIN_SEC = 5;
const DEFAULT_MAX_SEC = 14;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TASK_TIMEOUT_MS = 900000;
const FIVE_MINUTES_MS = 300000;

const CIRCLE_AVATAR_SIZE = 200;
const CIRCLE_BORDER_WIDTH = 4;
const FACE_PADDING_RATIO = 1.8;
const ULTRAFACE_W = 320;
const ULTRAFACE_H = 240;
const ULTRAFACE_SCORE_THRESHOLD = 0.7;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ULTRAFACE_MODEL_PATH = path.resolve(__dirname, '..', 'model', 'ultra_face_slim_320.onnx');

const DEFAULT_LAYOUT = {
  position: 'bottom-right',
  widthRatio: 0.224,
  marginRatio: 0.01
};

const DEFAULT_CHROMA = {
  color: '#29761f',
  engine: 'v2',
  profile: 'clean-bg',
  similarity: 0.14,
  blend: 0.05,
  despill: 0.65,
  edgeShrinkPx: 1,
  edgeFeatherPx: 1,
  temporal: 0,
  fallbackFilter: 'colorkey'
};

/* ------------------------------------------------------------------ */
/*  Circular avatar generation (face detection + sharp)               */
/* ------------------------------------------------------------------ */

/** @type {import('onnxruntime-node').InferenceSession | null} */
let ultraFaceSession = null;

/**
 * Lazy-load UltraFace ONNX model once.
 * @returns {Promise<import('onnxruntime-node').InferenceSession | null>}
 */
async function ensureUltraFace() {
  if (ultraFaceSession) return ultraFaceSession;
  try {
    ultraFaceSession = await ort.InferenceSession.create(ULTRAFACE_MODEL_PATH, {
      logSeverityLevel: 3
    });
    return ultraFaceSession;
  } catch {
    return null;
  }
}

/**
 * Detect the largest face in the image using UltraFace ONNX + sharp.
 * Returns bounding box in original image coordinates or null.
 * @param {string} inputPath
 * @returns {Promise<{x:number,y:number,width:number,height:number}|null>}
 */
async function detectFaceBounds(inputPath) {
  const session = await ensureUltraFace();
  if (!session) return null;

  const metadata = await sharp(inputPath).metadata();
  const origW = metadata.width;
  const origH = metadata.height;
  if (!origW || !origH) return null;

  // UltraFace expects 320x240 RGB normalized to [0,1]
  const { data } = await sharp(inputPath)
    .resize(ULTRAFACE_W, ULTRAFACE_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert HWC RGB uint8 → NCHW float32 [1, 3, 240, 320]
  const pixelCount = ULTRAFACE_H * ULTRAFACE_W;
  const floatData = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    floatData[i] = data[i * 3] / 255.0;                     // R
    floatData[pixelCount + i] = data[i * 3 + 1] / 255.0;    // G
    floatData[2 * pixelCount + i] = data[i * 3 + 2] / 255.0; // B
  }

  const inputTensor = new ort.Tensor('float32', floatData, [1, 3, ULTRAFACE_H, ULTRAFACE_W]);
  const results = await session.run({ input: inputTensor });

  const scores = results.scores.data;   // [1, N, 2] flattened
  const boxes = results.boxes.data;     // [1, N, 4] flattened
  const numDetections = scores.length / 2;

  // Find highest-confidence face above threshold
  let bestIdx = -1;
  let bestScore = ULTRAFACE_SCORE_THRESHOLD;
  for (let i = 0; i < numDetections; i++) {
    const faceScore = scores[i * 2 + 1]; // index 1 = face class
    if (faceScore > bestScore) {
      bestScore = faceScore;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) return null;

  // Boxes are normalized [x1, y1, x2, y2] in 0..1 range
  const x1 = boxes[bestIdx * 4];
  const y1 = boxes[bestIdx * 4 + 1];
  const x2 = boxes[bestIdx * 4 + 2];
  const y2 = boxes[bestIdx * 4 + 3];

  return {
    x: Math.round(x1 * origW),
    y: Math.round(y1 * origH),
    width: Math.round((x2 - x1) * origW),
    height: Math.round((y2 - y1) * origH)
  };
}

/**
 * Compute a square crop region centered on the face with padding.
 * @param {{x:number,y:number,width:number,height:number}} face
 * @param {number} imgW
 * @param {number} imgH
 * @returns {{left:number,top:number,width:number,height:number}}
 */
function computeFaceCrop(face, imgW, imgH) {
  const centerX = face.x + face.width / 2;
  const centerY = face.y + face.height / 2;
  const faceSize = Math.max(face.width, face.height);
  let cropSize = Math.round(faceSize * FACE_PADDING_RATIO);
  cropSize = Math.min(cropSize, Math.min(imgW, imgH));

  let left = Math.round(centerX - cropSize / 2);
  let top = Math.round(centerY - cropSize / 2);
  left = Math.max(0, Math.min(left, imgW - cropSize));
  top = Math.max(0, Math.min(top, imgH - cropSize));

  return { left, top, width: cropSize, height: cropSize };
}

/**
 * Generate a circular avatar image with face detection and semi-transparent border.
 * Falls back to center-crop when face detection fails.
 * @param {string} inputPath  source image
 * @param {string} outputPath destination PNG
 * @param {(msg:string)=>void} [logFn]
 * @returns {Promise<string>} outputPath
 */
export async function generateCircularAvatar(inputPath, outputPath, logFn = () => {}) {
  const SIZE = CIRCLE_AVATAR_SIZE;
  const BORDER = CIRCLE_BORDER_WIDTH;
  const innerRadius = (SIZE / 2) - BORDER;

  const metadata = await sharp(inputPath).metadata();
  const imgW = metadata.width || 0;
  const imgH = metadata.height || 0;
  if (!imgW || !imgH) throw new Error('Cannot read image dimensions');

  let cropRegion = null;
  try {
    const face = await detectFaceBounds(inputPath);
    if (face) {
      cropRegion = computeFaceCrop(face, imgW, imgH);
      logFn(`얼굴 감지 성공: (${face.x}, ${face.y}) ${face.width}x${face.height} → 크롭 ${cropRegion.width}x${cropRegion.height}`);
    } else {
      logFn('얼굴 미감지, 중앙 크롭으로 대체합니다.');
    }
  } catch (err) {
    logFn(`얼굴 감지 오류: ${err.message}. 중앙 크롭으로 대체합니다.`);
  }

  if (!cropRegion) {
    const side = Math.min(imgW, imgH);
    const left = Math.round((imgW - side) / 2);
    const top = Math.round((imgH - side) / 2);
    cropRegion = { left, top, width: side, height: side };
  }

  const croppedBuffer = await sharp(inputPath)
    .extract(cropRegion)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .removeAlpha()
    .toBuffer();

  const circleMask = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}">
      <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${innerRadius}" fill="white"/>
    </svg>`
  );

  const circularImage = await sharp(croppedBuffer)
    .ensureAlpha()
    .composite([{ input: circleMask, blend: 'dest-in' }])
    .toBuffer();

  const borderRing = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}">
      <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${(SIZE / 2) - (BORDER / 2) - 1}"
              fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="${BORDER}"/>
    </svg>`
  );

  await sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 3,
      background: { r: 41, g: 118, b: 31 }
    }
  })
    .jpeg({ quality: 95 })
    .toBuffer()
    .then((bg) =>
      sharp(bg)
        .ensureAlpha()
        .composite([
          { input: circularImage, blend: 'over' },
          { input: borderRing, blend: 'over' }
        ])
        .png()
        .toFile(outputPath)
    );

  logFn(`원형 아바타 생성 완료: ${path.basename(outputPath)} (${SIZE}x${SIZE})`);
  return outputPath;
}

/**
 * Error type for KIE API calls.
 */
class AvatarApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: number|string}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'AvatarApiError';
    this.status = meta.status;
    this.code = meta.code;
  }
}

/**
 * Parse a numeric environment variable with fallback.
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function parseEnvNumber(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

/**
 * Parse an integer env var with clamped range.
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseEnvInt(raw, fallback, min, max) {
  const value = Math.floor(parseEnvNumber(raw, fallback));
  return Math.max(min, Math.min(max, value));
}

/**
 * Parse a number env var with clamped range.
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseEnvClamped(raw, fallback, min, max) {
  const value = parseEnvNumber(raw, fallback);
  return Math.max(min, Math.min(max, value));
}

/**
 * Parse string enum env var.
 * @param {string | undefined} raw
 * @param {string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
function parseEnvEnum(raw, allowed, fallback) {
  const value = String(raw || '').trim().toLowerCase();
  if (allowed.includes(value)) return value;
  return fallback;
}

/**
 * Normalize chroma color text to ffmpeg-friendly hex format.
 * Accepts "#RRGGBB" or "0xRRGGBB", returns "0xRRGGBB".
 * @param {string | undefined} raw
 * @param {string} fallback
 * @returns {string}
 */
function normalizeChromaColor(raw, fallback) {
  const value = String(raw || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    return `0x${value.slice(1).toUpperCase()}`;
  }
  if (/^0x[0-9a-fA-F]{6}$/.test(value)) {
    return `0x${value.slice(2).toUpperCase()}`;
  }
  const fallbackValue = String(fallback || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(fallbackValue)) {
    return `0x${fallbackValue.slice(1).toUpperCase()}`;
  }
  if (/^0x[0-9a-fA-F]{6}$/.test(fallbackValue)) {
    return `0x${fallbackValue.slice(2).toUpperCase()}`;
  }
  return '0x29761F';
}

/**
 * Get avatar runtime configuration from environment.
 * @returns {{
 *   kieApiKey: string,
 *   publicBaseUrl: string,
 *   kieFileUploadUrl: string,
 *   clipConcurrency: number,
 *   maxPoints: number,
 *   minSec: number,
 *   maxSec: number,
 *   pollIntervalMs: number,
 *   taskTimeoutMs: number,
 *   layout: {position: string, widthRatio: number, marginRatio: number},
 *   chroma: {
 *     color: string,
 *     engine: string,
 *     profile: string,
 *     similarity: number,
 *     blend: number,
 *     despill: number,
 *     edgeShrinkPx: number,
 *     edgeFeatherPx: number,
 *     temporal: number,
 *     fallbackFilter: string
 *   }
 * }}
 */
export function getAvatarRuntimeConfig() {
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const kieFileUploadUrl = String(process.env.KIE_FILE_UPLOAD_URL || KIE_FILE_STREAM_UPLOAD_URL).trim();
  return {
    kieApiKey: String(process.env.KIE_API_KEY || '').trim(),
    publicBaseUrl,
    kieFileUploadUrl,
    clipConcurrency: Math.max(1, Math.min(3, Math.floor(parseEnvNumber(process.env.AVATAR_CLIP_CONCURRENCY, 3)))),
    maxPoints: Math.max(1, Math.floor(parseEnvNumber(process.env.AVATAR_MAX_POINTS, DEFAULT_MAX_POINTS))),
    minSec: Math.max(1, parseEnvNumber(process.env.AVATAR_MIN_SEC, DEFAULT_MIN_SEC)),
    maxSec: Math.max(1, parseEnvNumber(process.env.AVATAR_MAX_SEC, DEFAULT_MAX_SEC)),
    pollIntervalMs: Math.max(1000, Math.floor(parseEnvNumber(process.env.AVATAR_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS))),
    taskTimeoutMs: Math.max(10000, Math.floor(parseEnvNumber(process.env.AVATAR_TASK_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS))),
    layout: { ...DEFAULT_LAYOUT },
    chroma: {
      color: normalizeChromaColor(process.env.AVATAR_CHROMA_COLOR, DEFAULT_CHROMA.color),
      engine: parseEnvEnum(process.env.AVATAR_CHROMA_ENGINE, ['v1', 'v2'], DEFAULT_CHROMA.engine),
      profile: parseEnvEnum(process.env.AVATAR_CHROMA_PROFILE, ['balanced', 'clean-bg', 'subject'], DEFAULT_CHROMA.profile),
      similarity: parseEnvClamped(process.env.AVATAR_CHROMA_SIMILARITY, DEFAULT_CHROMA.similarity, 0, 1),
      blend: parseEnvClamped(process.env.AVATAR_CHROMA_BLEND, DEFAULT_CHROMA.blend, 0.0001, 1),
      despill: parseEnvClamped(process.env.AVATAR_CHROMA_DESPILL, DEFAULT_CHROMA.despill, 0, 1),
      edgeShrinkPx: parseEnvInt(process.env.AVATAR_CHROMA_EDGE_SHRINK_PX, DEFAULT_CHROMA.edgeShrinkPx, 0, 3),
      edgeFeatherPx: parseEnvInt(process.env.AVATAR_CHROMA_EDGE_FEATHER_PX, DEFAULT_CHROMA.edgeFeatherPx, 0, 3),
      temporal: parseEnvClamped(process.env.AVATAR_CHROMA_TEMPORAL, DEFAULT_CHROMA.temporal, 0, 0.5),
      fallbackFilter: DEFAULT_CHROMA.fallbackFilter
    }
  };
}

/**
 * Sleep utility.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure a directory exists.
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Check whether a path exists.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a child process and reject on non-zero exit.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function runCommand(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-4).join(' | ');
      reject(new Error(`${cmd} exited with code ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}

/**
 * Build a public URL from base and output-relative path.
 * @param {string} base
 * @param {string} relativePath
 * @returns {string}
 */
function toPublicUrl(base, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return `${base}/${normalized}`;
}

/**
 * Resolve a file MIME type from extension.
 * @param {string} filePath
 * @returns {string}
 */
function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

/**
 * Pick URL field from KIE upload response payload.
 * @param {any} payload
 * @returns {string}
 */
function pickUploadUrl(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : null;
  const url = data?.downloadUrl || data?.fileUrl || data?.url || null;
  return typeof url === 'string' ? url : '';
}

/**
 * Upload local file to KIE to obtain an externally accessible URL.
 * @param {{apiKey: string, uploadUrl: string, localPath: string, uploadPath: string}} options
 * @returns {Promise<string>}
 */
export async function uploadFileToKie(options) {
  const { apiKey, uploadUrl, localPath, uploadPath } = options;
  const buffer = await fs.readFile(localPath);
  const form = new FormData();
  form.append('uploadPath', uploadPath);
  form.append('file', new Blob([buffer], { type: detectMimeType(localPath) }), path.basename(localPath));

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  const payload = await response.json().catch(() => ({}));
  const apiCode = payload?.code;
  if (!response.ok || apiCode !== 200) {
    throw new AvatarApiError(
      payload?.msg || `file upload failed (status ${response.status})`,
      { status: response.status, code: apiCode }
    );
  }
  const uploadedUrl = pickUploadUrl(payload);
  if (!uploadedUrl) {
    throw new AvatarApiError('file upload response missing file URL.', { status: response.status, code: apiCode });
  }
  return uploadedUrl;
}

/**
 * Resolve source URL for KIE input from either PUBLIC_BASE_URL or direct KIE upload.
 * @param {{
 *   apiKey: string,
 *   publicBaseUrl: string,
 *   kieFileUploadUrl: string,
 *   localPath: string,
 *   relativePath: string,
 *   uploadPath: string
 * }} options
 * @returns {Promise<string>}
 */
async function resolveKieInputUrl(options) {
  const {
    apiKey,
    publicBaseUrl,
    kieFileUploadUrl,
    localPath,
    relativePath,
    uploadPath
  } = options;

  if (publicBaseUrl) {
    return toPublicUrl(publicBaseUrl, relativePath);
  }
  return uploadFileToKie({
    apiKey,
    uploadUrl: kieFileUploadUrl,
    localPath,
    uploadPath
  });
}

/**
 * Read JSON file if exists.
 * @param {string} filePath
 * @returns {Promise<any | null>}
 */
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write JSON with pretty formatting.
 * @param {string} filePath
 * @param {any} payload
 * @returns {Promise<void>}
 */
async function writeJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

/**
 * Extract an MP3 clip using ffmpeg.
 * @param {{sourcePath: string, outputPath: string, startSec: number, durationSec: number}} options
 * @returns {Promise<void>}
 */
export async function extractAudioClip(options) {
  const { sourcePath, outputPath, startSec, durationSec } = options;
  await ensureDir(path.dirname(outputPath));
  await runCommand('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    sourcePath,
    '-vn',
    '-acodec',
    'libmp3lame',
    '-b:a',
    '192k',
    outputPath
  ]);
}

/**
 * Download a remote file to local path.
 * @param {string} url
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
export async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new AvatarApiError(`Download failed (status ${response.status})`, { status: response.status });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, buffer);
}

/**
 * Strip audio from avatar clip output.
 * @param {{inputPath: string, outputPath: string}} options
 * @returns {Promise<void>}
 */
export async function stripAvatarAudio(options) {
  const { inputPath, outputPath } = options;
  await ensureDir(path.dirname(outputPath));
  await runCommand('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    '-an',
    outputPath
  ]);
}

/**
 * Create KIE avatar task.
 * @param {{apiKey: string, imageUrl: string, audioUrl: string, prompt: string}} options
 * @returns {Promise<string>}
 */
export async function createAvatarTask(options) {
  const { apiKey, imageUrl, audioUrl, prompt } = options;
  const response = await fetch(KIE_CREATE_TASK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: KIE_MODEL,
      input: {
        image_url: imageUrl,
        audio_url: audioUrl,
        prompt
      }
    })
  });
  const payload = await response.json().catch(() => ({}));
  const apiCode = payload?.code;
  if (!response.ok || apiCode !== 200) {
    throw new AvatarApiError(
      payload?.msg || `createTask failed (status ${response.status})`,
      { status: response.status, code: apiCode }
    );
  }
  const taskId = payload?.data?.taskId;
  if (!taskId) {
    throw new AvatarApiError('createTask response missing taskId.', { status: response.status, code: apiCode });
  }
  return taskId;
}

/**
 * Poll KIE task status until success/fail/timeout.
 * @param {{
 *   apiKey: string,
 *   taskId: string,
 *   pollIntervalMs: number,
 *   timeoutMs: number,
 *   onLongWait?: () => void
 * }} options
 * @returns {Promise<{resultUrl: string, raw: any}>}
 */
export async function pollAvatarTask(options) {
  const {
    apiKey,
    taskId,
    pollIntervalMs,
    timeoutMs,
    onLongWait
  } = options;
  const startedAt = Date.now();
  let longWaitNotified = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (!longWaitNotified && Date.now() - startedAt >= FIVE_MINUTES_MS) {
      longWaitNotified = true;
      if (typeof onLongWait === 'function') onLongWait();
    }

    const url = `${KIE_RECORD_INFO_URL}?taskId=${encodeURIComponent(taskId)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const payload = await response.json().catch(() => ({}));
    const apiCode = payload?.code;
    if (!response.ok || apiCode !== 200) {
      throw new AvatarApiError(
        payload?.msg || `recordInfo failed (status ${response.status})`,
        { status: response.status, code: apiCode }
      );
    }

    const state = payload?.data?.state;
    if (state === 'waiting') {
      await sleep(pollIntervalMs);
      continue;
    }
    if (state === 'fail') {
      const failCode = payload?.data?.failCode;
      const failMsg = payload?.data?.failMsg || 'unknown';
      throw new AvatarApiError(`KIE task failed (${failCode || 'unknown'}): ${failMsg}`, {
        status: response.status,
        code: failCode || apiCode
      });
    }
    if (state === 'success') {
      const rawResult = payload?.data?.resultJson;
      let parsedResult = null;
      if (typeof rawResult === 'string') {
        parsedResult = JSON.parse(rawResult);
      } else if (rawResult && typeof rawResult === 'object') {
        parsedResult = rawResult;
      }
      const resultUrl = parsedResult?.resultUrls?.[0];
      if (!resultUrl) {
        throw new AvatarApiError('KIE success response missing resultUrls[0].', { status: response.status, code: apiCode });
      }
      return { resultUrl, raw: payload };
    }

    await sleep(pollIntervalMs);
  }

  throw new AvatarApiError('Avatar task timeout.', { code: 'timeout' });
}

/**
 * Load avatar manifest if present.
 * @param {string} manifestPath
 * @returns {Promise<any | null>}
 */
export async function loadAvatarManifest(manifestPath) {
  return readJson(manifestPath);
}

/**
 * Save avatar manifest.
 * @param {string} manifestPath
 * @param {any} manifest
 * @returns {Promise<void>}
 */
export async function saveAvatarManifest(manifestPath, manifest) {
  await writeJson(manifestPath, manifest);
}

/**
 * Create a serialized manifest persistence function.
 * Multiple concurrent callers are queued to avoid file write races.
 * @param {string} manifestPath
 * @param {any} manifest
 * @returns {() => Promise<void>}
 */
function createManifestPersistor(manifestPath, manifest) {
  let tail = Promise.resolve();
  return async () => {
    tail = tail
      .catch(() => {})
      .then(() => saveAvatarManifest(manifestPath, manifest));
    return tail;
  };
}

/**
 * Normalize avatar points from scenes payload.
 * @param {any} scenesPayload
 * @param {number} maxPoints
 * @param {number} minSec
 * @param {number} maxSec
 * @returns {Array<any>}
 */
function getAvatarPoints(scenesPayload, maxPoints, minSec, maxSec) {
  const points = Array.isArray(scenesPayload?.avatarPlan?.points) ? scenesPayload.avatarPlan.points : [];
  return points
    .filter((point) => Number.isFinite(Number(point?.startSec)) && Number.isFinite(Number(point?.endSec)))
    .map((point) => {
      const startSec = Number(point.startSec);
      let endSec = Number(point.endSec);
      let durationSec = Number.isFinite(Number(point.durationSec))
        ? Number(point.durationSec)
        : Number((endSec - startSec).toFixed(3));
      if (durationSec > maxSec) {
        durationSec = maxSec;
        endSec = Number((startSec + maxSec).toFixed(3));
      }
      return {
        ...point,
        startSec,
        endSec,
        durationSec
      };
    })
    .filter((point) => point.durationSec >= minSec && point.durationSec <= maxSec)
    .sort((a, b) => a.startSec - b.startSec)
    .slice(0, Math.max(1, maxPoints));
}

/**
 * Determine whether createTask errors are retryable.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableCreateError(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && [400, 401, 402, 404, 422].includes(status)) {
    return false;
  }
  return true;
}

/**
 * Build avatar prompt from point context.
 * @param {any} point
 * @returns {string}
 */
function buildAvatarPrompt(point) {
  return 'Natural talking-head';
}

/**
 * Run avatar stage for MP3 job.
 * @param {object} job
 * @param {(message: string) => void} logFn
 * @returns {Promise<{attempted: number, success: number, failed: number, skipped: number, manifestPath: string}>}
 */
export async function runAvatarStage(job, logFn = () => {}) {
  const cfg = getAvatarRuntimeConfig();
  const avatarEnabled = Boolean(job?.options?.avatarEnabled);

  await ensureDir(job.outputs.avatarRoot);
  await ensureDir(job.outputs.avatarClipsAudioDir);
  await ensureDir(job.outputs.avatarClipsVideoDir);
  await ensureDir(job.outputs.avatarInputDir);

  const scenesPayload = await readJson(job.outputs.scenes);
  const rawPoints = getAvatarPoints(scenesPayload, cfg.maxPoints, cfg.minSec, cfg.maxSec);

  const manifest = (await loadAvatarManifest(job.outputs.avatarManifest)) || {
    version: 1,
    enabled: avatarEnabled,
    createdAt: new Date().toISOString(),
    layout: cfg.layout,
    chroma: cfg.chroma,
    clips: []
  };
  manifest.enabled = avatarEnabled;
  manifest.layout = cfg.layout;
  manifest.chroma = cfg.chroma;
  manifest.updatedAt = new Date().toISOString();
  const persistManifest = createManifestPersistor(job.outputs.avatarManifest, manifest);

  await writeJson(job.outputs.avatarPlan, {
    version: 1,
    maxPoints: cfg.maxPoints,
    points: rawPoints
  });

  const buildClipSkeleton = () => rawPoints.map((point, index) => {
    const nn = String(index + 1).padStart(2, '0');
    return {
      id: point.id || `A${index + 1}`,
      sceneId: Number(point.sceneId) || null,
      startSec: Number(point.startSec),
      endSec: Number(point.endSec),
      durationSec: Number(point.durationSec),
      reason: point.reason || '',
      score: Number.isFinite(Number(point.score)) ? Number(point.score) : null,
      state: 'planned',
      audioRelative: `${job.outputsRelative.avatarClipsAudioDir.replace(/\\/g, '/')}/avatar_clip_${nn}.mp3`,
      videoRelative: `${job.outputsRelative.avatarClipsVideoDir.replace(/\\/g, '/')}/avatar_clip_${nn}.mp4`,
      taskId: null,
      resultUrl: null,
      hasAudio: false,
      chromaApplied: false,
      error: null
    };
  });

  if (!avatarEnabled) {
    manifest.clips = [];
    await persistManifest();
    return {
      attempted: 0,
      success: 0,
      failed: 0,
      skipped: rawPoints.length,
      manifestPath: job.outputs.avatarManifest
    };
  }

  const setupError = !cfg.kieApiKey
    ? 'KIE_API_KEY is missing.'
    : !job.options.avatarImagePath
      ? 'avatarImage is missing.'
      : null;

  if (setupError) {
    const failedClips = buildClipSkeleton().map((clip) => ({
      ...clip,
      state: 'failed',
      error: setupError
    }));
    manifest.clips = failedClips;
    await persistManifest();
    if (scenesPayload && typeof scenesPayload === 'object') {
      const currentPoints = Array.isArray(scenesPayload?.avatarPlan?.points) ? scenesPayload.avatarPlan.points : [];
      scenesPayload.avatarPlan = {
        version: 1,
        maxPoints: cfg.maxPoints,
        points: currentPoints.map((point, idx) => {
          const clip = failedClips[idx];
          if (!clip) return point;
          return {
            ...point,
            audioClipRelative: clip.audioRelative,
            avatarVideoRelative: clip.videoRelative,
            state: 'failed'
          };
        })
      };
      await writeJson(job.outputs.scenes, scenesPayload);
      await writeJson(job.outputs.avatarPlan, scenesPayload.avatarPlan);
    }
    logFn(`avatar setup skipped: ${setupError}`);
    return {
      attempted: failedClips.length,
      success: 0,
      failed: failedClips.length,
      skipped: 0,
      manifestPath: job.outputs.avatarManifest
    };
  }
  const sourceAudioPath = job.outputs?.audio || job.outputs?.ttsAudio;
  if (!sourceAudioPath) {
    throw new Error('Avatar stage requires source audio path.');
  }

  const imageExt = path.extname(job.options.avatarImagePath || '.png').toLowerCase() || '.png';
  const avatarImageName = `avatar${imageExt}`;
  const avatarImagePath = path.join(job.outputs.avatarInputDir, avatarImageName);
  await fs.copyFile(job.options.avatarImagePath, avatarImagePath);

  const avatarInputRel = `${job.outputsRelative.avatarInputDir.replace(/\\/g, '/')}/${avatarImageName}`;
  job.outputs.avatarInput = avatarImagePath;
  job.outputsRelative.avatarInput = avatarInputRel;

  // Generate circular avatar (face-centered, 200px with semi-transparent border)
  const circleAvatarPath = path.join(job.outputs.avatarInputDir, 'avatar_circle.png');
  try {
    await generateCircularAvatar(avatarImagePath, circleAvatarPath, logFn);
    job.outputs.avatarCircle = circleAvatarPath;
    job.outputsRelative.avatarCircle = `${job.outputsRelative.avatarInputDir.replace(/\\/g, '/')}/avatar_circle.png`;
  } catch (err) {
    logFn(`Warning: 원형 아바타 생성 실패: ${err.message}. 파이프라인은 계속 진행합니다.`);
  }

  const clips = buildClipSkeleton();

  const existingById = new Map((manifest.clips || []).map((clip) => [String(clip.id), clip]));
  manifest.clips = clips.map((clip) => {
    const existing = existingById.get(String(clip.id));
    if (!existing) return clip;
    return { ...clip, ...existing };
  });
  await persistManifest();

  // circle 모드일 때 avatar_circle.png 를 KIE 입력으로 사용
  const useCircle = job.options?.avatarStyle === 'circle'
    && job.outputs.avatarCircle
    && await pathExists(job.outputs.avatarCircle);
  const kieInputPath = useCircle ? job.outputs.avatarCircle : avatarImagePath;
  const kieInputRel = useCircle ? job.outputsRelative.avatarCircle : avatarInputRel;
  if (useCircle) {
    logFn('원형 아바타 모드: avatar_circle.png 를 KIE 입력으로 사용');
  }

  const uploadBase = `avatar/${job.id}`;
  let imagePublicUrl = '';
  try {
    imagePublicUrl = await resolveKieInputUrl({
      apiKey: cfg.kieApiKey,
      publicBaseUrl: cfg.publicBaseUrl,
      kieFileUploadUrl: cfg.kieFileUploadUrl,
      localPath: kieInputPath,
      relativePath: kieInputRel,
      uploadPath: `${uploadBase}/input`
    });
  } catch (error) {
    const message = error?.message || String(error);
    const failedClips = buildClipSkeleton().map((clip) => ({
      ...clip,
      state: 'failed',
      error: `avatar image upload failed: ${message}`
    }));
    manifest.clips = failedClips;
    await persistManifest();
    logFn(`avatar setup skipped: avatar image upload failed (${message})`);
    return {
      attempted: failedClips.length,
      success: 0,
      failed: failedClips.length,
      skipped: 0,
      manifestPath: job.outputs.avatarManifest
    };
  }

  let attempted = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;
  const MAX_CLIP_RETRIES = 2;

  async function processClip(clip) {
    const videoAbs = path.join(job.outputs.avatarClipsVideoDir, path.basename(clip.videoRelative));
    const audioAbs = path.join(job.outputs.avatarClipsAudioDir, path.basename(clip.audioRelative));
    const successExists = clip.state === 'success' && await pathExists(videoAbs);
    if (successExists) {
      skipped += 1;
      return;
    }

    attempted += 1;
    clip.state = 'running';
    clip.error = null;
    clip.hasAudio = false;
    clip.chromaApplied = false;
    await persistManifest();

    try {
      await extractAudioClip({
        sourcePath: sourceAudioPath,
        outputPath: audioAbs,
        startSec: clip.startSec,
        durationSec: clip.durationSec
      });

      const audioPublicUrl = await resolveKieInputUrl({
        apiKey: cfg.kieApiKey,
        publicBaseUrl: cfg.publicBaseUrl,
        kieFileUploadUrl: cfg.kieFileUploadUrl,
        localPath: audioAbs,
        relativePath: clip.audioRelative,
        uploadPath: `${uploadBase}/clips/audio`
      });

      let taskId = null;
      for (let i = 0; i < 3; i += 1) {
        try {
          taskId = await createAvatarTask({
            apiKey: cfg.kieApiKey,
            imageUrl: imagePublicUrl,
            audioUrl: audioPublicUrl,
            prompt: buildAvatarPrompt(clip)
          });
          break;
        } catch (error) {
          if (i >= 2 || !isRetryableCreateError(error)) {
            throw error;
          }
          await sleep(1000 * (2 ** i));
        }
      }

      if (!taskId) {
        throw new Error('createTask failed without taskId.');
      }

      clip.taskId = taskId;
      await persistManifest();

      const pollResult = await pollAvatarTask({
        apiKey: cfg.kieApiKey,
        taskId,
        pollIntervalMs: cfg.pollIntervalMs,
        timeoutMs: cfg.taskTimeoutMs,
        onLongWait: () => logFn(`avatar ${clip.id}: still waiting after 5 minutes (task ${taskId})`)
      });

      const tempVideoPath = `${videoAbs}.download.mp4`;
      await downloadFile(pollResult.resultUrl, tempVideoPath);
      await stripAvatarAudio({ inputPath: tempVideoPath, outputPath: videoAbs });
      await fs.unlink(tempVideoPath).catch(() => {});

      clip.state = 'success';
      clip.resultUrl = pollResult.resultUrl;
      clip.error = null;
      clip.hasAudio = false;
      success += 1;
    } catch (error) {
      clip.state = error?.code === 'timeout' ? 'timeout' : 'failed';
      clip.error = error?.message || String(error);
      logFn(`avatar ${clip.id} failed: ${clip.error}`);
    }

    await persistManifest();
  }

  const BATCH_SIZE = 4;
  const BATCH_DELAY_MS = 3000;

  const pendingClips = manifest.clips.filter((c) => c.state !== 'success');
  const batches = [];
  for (let i = 0; i < pendingClips.length; i += BATCH_SIZE) {
    batches.push(pendingClips.slice(i, i + BATCH_SIZE));
  }

  logFn(`avatar: processing ${pendingClips.length} clips in ${batches.length} batch(es) (max ${BATCH_SIZE} concurrent)`);
  for (let b = 0; b < batches.length; b += 1) {
    if (b > 0) {
      logFn(`avatar: waiting ${BATCH_DELAY_MS / 1000}s before next batch...`);
      await sleep(BATCH_DELAY_MS);
    }
    await runWithConcurrency(batches[b], BATCH_SIZE, processClip);
  }

  // Retry failed clips
  for (let retry = 1; retry <= MAX_CLIP_RETRIES; retry += 1) {
    const failedClips = manifest.clips.filter((c) => c.state === 'failed' || c.state === 'timeout');
    if (failedClips.length === 0) break;
    logFn(`avatar: retry ${retry}/${MAX_CLIP_RETRIES} for ${failedClips.length} failed clip(s)`);
    await sleep(BATCH_DELAY_MS * retry);
    const retryBatches = [];
    for (let i = 0; i < failedClips.length; i += BATCH_SIZE) {
      retryBatches.push(failedClips.slice(i, i + BATCH_SIZE));
    }
    for (let b = 0; b < retryBatches.length; b += 1) {
      if (b > 0) await sleep(BATCH_DELAY_MS);
      await runWithConcurrency(retryBatches[b], BATCH_SIZE, processClip);
    }
  }

  // Count final results
  for (const clip of manifest.clips) {
    if (clip.state === 'failed' || clip.state === 'timeout') {
      failed += 1;
    }
  }

  if (scenesPayload && typeof scenesPayload === 'object') {
    const pointsById = new Map(manifest.clips.map((clip) => [String(clip.id), clip]));
    const currentPlan = scenesPayload.avatarPlan && typeof scenesPayload.avatarPlan === 'object'
      ? scenesPayload.avatarPlan
      : { version: 1, maxPoints: cfg.maxPoints, points: [] };
    const currentPoints = Array.isArray(currentPlan.points) ? currentPlan.points : [];
    const nextPoints = currentPoints.map((point, idx) => {
      const fallbackId = point?.id ? String(point.id) : `A${idx + 1}`;
      const clip = pointsById.get(fallbackId);
      if (!clip) return point;
      return {
        ...point,
        id: clip.id,
        startSec: clip.startSec,
        endSec: clip.endSec,
        durationSec: clip.durationSec,
        audioClipRelative: clip.audioRelative,
        avatarVideoRelative: clip.videoRelative,
        state: clip.state
      };
    });

    scenesPayload.avatarPlan = {
      version: 1,
      maxPoints: cfg.maxPoints,
      points: nextPoints
    };

    await writeJson(job.outputs.scenes, scenesPayload);
    await writeJson(job.outputs.avatarPlan, scenesPayload.avatarPlan);
  }

  return {
    attempted,
    success,
    failed,
    skipped,
    manifestPath: job.outputs.avatarManifest
  };
}
