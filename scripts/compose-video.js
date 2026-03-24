import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPkg from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { resolveFfmpegCoreUrls } from './ffmpeg-core.js';

const { FFmpeg } = ffmpegPkg;

const DEFAULT_OUTPUT = './output/videos/output.mp4';
const DEFAULT_STYLE = 'presentation';
const DEFAULT_IMAGES_DIR = './output/images';
const DEFAULT_FFMPEG_MODE = 'auto';
const execFileAsync = promisify(execFile);

/**
 * Initialize a new ffmpeg.wasm instance.
 * @returns {Promise<FFmpeg>}
 */
async function createFfmpegInstance() {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    console.log('[FFmpeg]', message);
  });
  ffmpeg.on('progress', ({ progress, time }) => {
    console.log(`Progress: ${(progress * 100).toFixed(1)}% (${time}s)`);
  });

  const { coreURL, wasmURL } = await resolveFfmpegCoreUrls();
  await ffmpeg.load({
    coreURL,
    wasmURL
  });

  return ffmpeg;
}

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
 * Prepare scene images in ffmpeg virtual filesystem.
 * @param {Array<object>} scenes
 * @param {string} style
 * @param {FFmpeg} ffmpeg
 * @returns {Promise<void>}
 */
async function prepareImageSequence(scenes, style, imagesDir, ffmpeg) {
  for (const scene of scenes) {
    const imagePath = path.join(
      imagesDir,
      `scene_${String(scene.id).padStart(3, '0')}_${style}.png`
    );
    const imageData = await fetchFile(imagePath);
    await ffmpeg.writeFile(`scene_${scene.id}.png`, imageData);
  }
}

/**
 * Generate concat list for ffmpeg.
 * @param {Array<object>} scenes
 * @returns {string}
 */
function generateConcatList(scenes) {
  let concatContent = '';

  for (const scene of scenes) {
    const duration = scene.duration;
    concatContent += `file 'scene_${scene.id}.png'\n`;
    concatContent += `duration ${duration}\n`;
  }

  const lastScene = scenes[scenes.length - 1];
  concatContent += `file 'scene_${lastScene.id}.png'\n`;
  concatContent += `duration 1\n`;

  return concatContent;
}

/**
 * Generate concat list for ffmpeg CLI with absolute image paths.
 * @param {Array<object>} scenes
 * @param {string} imagesDir
 * @returns {string}
 */
function generateConcatListForCli(scenes, imagesDir, style) {
  let concatContent = '';

  for (const scene of scenes) {
    const filename = `scene_${String(scene.id).padStart(3, '0')}_${style}.png`;
    const imagePath = path.resolve(imagesDir, filename).replace(/\\/g, '/');
    concatContent += `file '${imagePath}'\n`;
    concatContent += `duration ${scene.duration}\n`;
  }

  const lastScene = scenes[scenes.length - 1];
  const lastImage = path.resolve(
    imagesDir,
    `scene_${String(lastScene.id).padStart(3, '0')}_${style}.png`
  )
    .replace(/\\/g, '/');
  concatContent += `file '${lastImage}'\n`;
  concatContent += `duration 1\n`;

  return concatContent;
}

const DURATION_EPSILON_SEC = 0.05;
const DURATION_WARN_THRESHOLD_SEC = 0.5;
const FFMPEG_MODE_VALUES = new Set(['auto', 'cli', 'wasm']);

/**
 * Normalize ffmpeg mode input.
 * @param {string | undefined} value
 * @returns {'auto' | 'cli' | 'wasm'}
 */
function resolveFfmpegMode(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (FFMPEG_MODE_VALUES.has(normalized)) {
    return normalized;
  }
  return DEFAULT_FFMPEG_MODE;
}

/**
 * Probe audio duration using ffprobe (if available).
 * @param {string} audioPath
 * @returns {Promise<number | null>}
 */
async function getAudioDurationWithFfprobe(audioPath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        audioPath
      ],
      { windowsHide: true }
    );
    const duration = Number(String(stdout).trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (error) {
    return null;
  }
}

/**
 * Derive subtitle duration from payload or last segment end time.
 * @param {object} subtitles
 * @returns {number | null}
 */
function getSubtitlesDuration(subtitles) {
  if (typeof subtitles?.duration === 'number' && subtitles.duration > 0) {
    return subtitles.duration;
  }
  const segments = Array.isArray(subtitles?.segments) ? subtitles.segments : [];
  if (segments.length === 0) {
    return null;
  }
  const last = segments[segments.length - 1];
  return typeof last?.end === 'number' ? last.end : null;
}

/**
 * Ensure scene durations cover the audio duration to avoid early cut-off.
 * @param {Array<object>} scenes
 * @param {number | null} targetDurationSec
 * @returns {Array<object>}
 */
function normalizeSceneDurations(scenes, targetDurationSec) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return scenes;
  }
  if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
    return scenes;
  }

  const normalized = scenes.map((scene) => ({ ...scene }));
  const total = normalized.reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0);
  const gap = targetDurationSec - total;

  if (gap > DURATION_EPSILON_SEC) {
    const lastIndex = normalized.length - 1;
    const lastDuration = Number(normalized[lastIndex].duration) || 0;
    const adjusted = lastDuration + gap + DURATION_EPSILON_SEC;
    normalized[lastIndex].duration = Number(adjusted.toFixed(3));
  }

  return normalized;
}

/**
 * Escape a value for ffmpeg filter usage.
 * @param {string} value
 * @returns {string}
 */
function escapeFilterValue(value) {
  return value.replace(/'/g, "\\'");
}

/**
 * Parse ffmpeg Duration line to seconds.
 * @param {string} message
 * @returns {number | null}
 */
function parseDurationFromLog(message) {
  const match = message.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Probe audio duration using ffmpeg.wasm.
 * @param {FFmpeg} ffmpeg
 * @param {Uint8Array} audioData
 * @returns {Promise<number | null>}
 */
async function getAudioDurationWithWasm(ffmpeg, audioData) {
  let durationSec = null;
  const handler = ({ message }) => {
    if (durationSec !== null) return;
    const parsed = parseDurationFromLog(message);
    if (parsed !== null) {
      durationSec = parsed;
    }
  };

  ffmpeg.on('log', handler);
  try {
    await ffmpeg.writeFile('probe_audio.mp3', audioData);
    await ffmpeg.exec(['-i', 'probe_audio.mp3', '-f', 'null', '-']);
  } catch (error) {
    if (durationSec === null) {
      throw error;
    }
  } finally {
    if (typeof ffmpeg.off === 'function') {
      ffmpeg.off('log', handler);
    }
  }

  return durationSec;
}

/**
 * Pad a number with zeros.
 * @param {number} num
 * @param {number} length
 * @returns {string}
 */
function pad(num, length = 2) {
  return num.toString().padStart(length, '0');
}

/**
 * Format seconds to SRT time format.
 * @param {number} seconds
 * @returns {string}
 */
function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Generate SRT content from subtitle segments.
 * @param {Array<{start: number, end: number, text: string}>} segments
 * @returns {string}
 */
function generateSRT(segments) {
  let srt = '';

  segments.forEach((segment, index) => {
    srt += `${index + 1}\n`;
    srt += `${formatSRTTime(segment.start)} --> ${formatSRTTime(segment.end)}\n`;
    srt += `${segment.text}\n\n`;
  });

  return srt;
}

/**
 * Compose video using ffmpeg CLI (Node.js).
 * @param {object} params
 * @returns {Promise<void>}
 */
async function composeVideoWithCli(params) {
  const {
    audioPath,
    scenes,
    subtitles,
    outputPath,
    style,
    imagesDir,
    includeSubtitles,
    targetDurationSec
  } = params;

  const workDir = path.join(path.dirname(outputPath), 'ffmpeg_tmp');
  await ensureDir(workDir);

  const concatList = generateConcatListForCli(scenes, imagesDir, style);
  const concatPath = path.join(workDir, 'concat.txt');
  await fs.promises.writeFile(concatPath, concatList);

  let subtitlesPath = null;
  if (includeSubtitles) {
    const srtContent = generateSRT(subtitles.segments);
    subtitlesPath = path.join(workDir, 'subtitles.srt');
    await fs.promises.writeFile(subtitlesPath, srtContent);
  }

  const baseFilter = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
  const subtitleFilter = subtitlesPath
    ? `,subtitles=filename='${escapeFilterValue(subtitlesPath.replace(/\\/g, '/'))}':force_style='FontName=Noto Sans KR,FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2'`
    : '';
  const videoFilter = `${baseFilter}${subtitleFilter}`;

  const args = [
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-i', audioPath,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-vf', videoFilter,
    '-y',
    outputPath
  ];
  if (Number.isFinite(targetDurationSec)) {
    args.splice(args.length - 2, 0, '-t', String(targetDurationSec));
  }

  try {
    await execFileAsync('ffmpeg', args, { windowsHide: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('ffmpeg CLI not found. Install ffmpeg and ensure it is on PATH.');
    }
    throw new Error(`ffmpeg CLI failed: ${error.message}`);
  }
}

/**
 * Compose the final video with audio, images, and subtitles.
 * @param {{audioPath: string, scenesPath: string, subtitlesPath: string, outputPath?: string, style?: string, includeSubtitles?: boolean, ffmpegMode?: 'auto' | 'cli' | 'wasm'}} options
 * @returns {Promise<{outputPath: string, success: boolean}>}
 */
export async function composeVideo(options) {
  const {
    audioPath,
    scenesPath,
    subtitlesPath,
    outputPath = DEFAULT_OUTPUT,
    style = DEFAULT_STYLE,
    imagesDir = DEFAULT_IMAGES_DIR,
    includeSubtitles = true,
    ffmpegMode: requestedMode
  } = options;

  if (!audioPath || !scenesPath || !subtitlesPath) {
    throw new Error('Missing required options: audioPath, scenesPath, subtitlesPath');
  }

  await assertFileExists(audioPath);
  await assertFileExists(scenesPath);
  await assertFileExists(subtitlesPath);
  await ensureDir(path.dirname(outputPath));

  const scenesPayload = JSON.parse(await fs.promises.readFile(scenesPath, 'utf-8'));
  const subtitlesPayload = JSON.parse(await fs.promises.readFile(subtitlesPath, 'utf-8'));

  if (!Array.isArray(scenesPayload?.scenes)) {
    throw new Error('Scenes JSON must include a scenes array.');
  }
  if (!Array.isArray(subtitlesPayload?.segments)) {
    throw new Error('Subtitles JSON must include a segments array.');
  }

  const subtitlesDurationSec = getSubtitlesDuration(subtitlesPayload);
  const resolvedMode = resolveFfmpegMode(requestedMode || process.env.FFMPEG_MODE);
  const isNode = Boolean(process?.versions?.node);
  const shouldUseCli = resolvedMode === 'cli' || (resolvedMode === 'auto' && isNode);
  const shouldUseWasm = resolvedMode === 'wasm' || (resolvedMode === 'auto' && !isNode);
  let ffmpeg = null;
  let audioData = null;
  let audioDurationSec = null;

  if (shouldUseCli) {
    audioDurationSec = await getAudioDurationWithFfprobe(audioPath);
  } else if (shouldUseWasm) {
    ffmpeg = await createFfmpegInstance();
    audioData = await fetchFile(audioPath);
    audioDurationSec = await getAudioDurationWithWasm(ffmpeg, audioData);
  }

  const targetDurationSec = audioDurationSec ?? subtitlesDurationSec;
  const scenes = normalizeSceneDurations(scenesPayload.scenes, targetDurationSec);
  if (
    Number.isFinite(audioDurationSec)
    && Number.isFinite(subtitlesDurationSec)
    && Math.abs(audioDurationSec - subtitlesDurationSec) > DURATION_WARN_THRESHOLD_SEC
  ) {
    console.warn(
      `Duration mismatch: audio=${audioDurationSec.toFixed(3)}s, subtitles=${subtitlesDurationSec.toFixed(3)}s`
    );
  }
  if (scenes.length === 0) {
    throw new Error('No scenes to compose.');
  }

  if (shouldUseCli) {
    await composeVideoWithCli({
      audioPath,
      scenes,
      subtitles: subtitlesPayload,
      outputPath,
      style,
      imagesDir,
      includeSubtitles,
      targetDurationSec
    });
    console.log(`Video saved to: ${outputPath}`);
    return { outputPath, success: true };
  }

  if (!shouldUseWasm) {
    throw new Error(`Unsupported ffmpeg mode: ${resolvedMode}`);
  }

  if (!ffmpeg || !audioData) {
    ffmpeg = await createFfmpegInstance();
    audioData = await fetchFile(audioPath);
  }
  await ffmpeg.writeFile('audio.mp3', audioData);

  await prepareImageSequence(scenes, style, imagesDir, ffmpeg);
  const concatList = generateConcatList(scenes);
  await ffmpeg.writeFile('concat.txt', concatList);

  if (includeSubtitles) {
    const srtContent = generateSRT(subtitlesPayload.segments);
    await ffmpeg.writeFile('subtitles.srt', srtContent);
  }

  const ffmpegArgs = [
    '-f', 'concat',
    '-safe', '0',
    '-i', 'concat.txt',
    '-i', 'audio.mp3',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
    'output.mp4'
  ];
  if (Number.isFinite(targetDurationSec)) {
    ffmpegArgs.splice(ffmpegArgs.length - 1, 0, '-t', String(targetDurationSec));
  }

  if (includeSubtitles) {
    const vfIndex = ffmpegArgs.indexOf('-vf');
    ffmpegArgs[vfIndex + 1] += ",subtitles=subtitles.srt:force_style='FontName=Noto Sans KR,FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2'";
  }

  await ffmpeg.exec(ffmpegArgs);

  const outputData = await ffmpeg.readFile('output.mp4');
  await fs.promises.writeFile(outputPath, outputData);

  console.log(`Video saved to: ${outputPath}`);

  return { outputPath, success: true };
}

/**
 * Parse CLI arguments for compose-video command.
 * @param {string[]} argv
 * @returns {{audioPath?: string, scenesPath?: string, subtitlesPath?: string, outputPath?: string, style?: string, imagesDir?: string, includeSubtitles?: boolean, ffmpegMode?: string, help?: boolean}}
 */
function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help') {
      args.help = true;
    } else if (token === '--audio') {
      args.audioPath = argv[i + 1];
      i += 1;
    } else if (token === '--scenes') {
      args.scenesPath = argv[i + 1];
      i += 1;
    } else if (token === '--subtitles') {
      args.subtitlesPath = argv[i + 1];
      i += 1;
    } else if (token === '--output') {
      args.outputPath = argv[i + 1];
      i += 1;
    } else if (token === '--style') {
      args.style = argv[i + 1];
      i += 1;
    } else if (token === '--images-dir') {
      args.imagesDir = argv[i + 1];
      i += 1;
    } else if (token === '--ffmpeg') {
      args.ffmpegMode = argv[i + 1];
      i += 1;
    } else if (token === '--no-subtitles') {
      args.includeSubtitles = false;
    }
  }

  return args;
}

/**
 * Print usage for compose-video command.
 * @returns {void}
 */
function printUsage() {
  console.log('Usage: node src/compose-video.js --audio ./input/lecture.mp3 --scenes ./output/scenes/scenes.json --subtitles ./output/subtitles/validated.json');
  console.log('Options:');
  console.log('  --output ./output/videos/output.mp4');
  console.log('  --style presentation|documentary');
  console.log('  --images-dir ./output/images');
  console.log('  --ffmpeg auto|cli|wasm');
  console.log('  --no-subtitles');
}

/**
 * Build FFmpeg filter_complex for avatar overlay on a base video.
 * Each avatar clip is overlaid at the correct time range with chroma key removal.
 * @param {object} params
 * @returns {{filterComplex: string, inputs: string[]}}
 */
function buildAvatarFilterComplex({
  avatarClips,
  avatarStyle,
  circlePosition,
  circleSize,
  targetWidth,
  targetHeight,
  chromaColor
}) {
  if (!avatarClips || avatarClips.length === 0) {
    return { filterComplex: '', inputs: [] };
  }

  const inputs = avatarClips.map((clip) => clip.videoPath);
  const pos = circlePosition || 'bottom-right';
  const sizePct = Math.max(8, Math.min(30, Number(circleSize) || 12));
  const isCircle = avatarStyle === 'circle';

  // Parse chroma color (hex string like '0x29761F' or '29761F')
  const hexRaw = String(chromaColor || '0x29761F').replace(/^(0x|#)/i, '');
  const cr = parseInt(hexRaw.slice(0, 2), 16) / 255;
  const cg = parseInt(hexRaw.slice(2, 4), 16) / 255;
  const cb = parseInt(hexRaw.slice(4, 6), 16) / 255;
  const chromaKeyColor = `${cr.toFixed(4)}:${cg.toFixed(4)}:${cb.toFixed(4)}`;

  const avatarW = Math.round(targetWidth * sizePct / 100);
  const margin = Math.round(targetWidth * 0.04);

  let ox, oy;
  switch (pos) {
    case 'top-left':
      ox = margin; oy = margin; break;
    case 'top-right':
      ox = targetWidth - avatarW - margin; oy = margin; break;
    case 'bottom-left':
      ox = margin; oy = targetHeight - avatarW - margin; break;
    default: // bottom-right
      ox = targetWidth - avatarW - margin; oy = targetHeight - avatarW - margin; break;
  }

  // Build filter chain: base video is scaled first, then avatars overlaid sequentially
  const baseFilter = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2[base]`;
  let chain = baseFilter;
  let lastLabel = 'base';

  for (let i = 0; i < avatarClips.length; i++) {
    const clip = avatarClips[i];
    const inputIdx = i + 2; // 0=concat images, 1=audio, 2+=avatar clips
    const startSec = clip.startSec.toFixed(3);
    const endSec = clip.endSec.toFixed(3);
    const outLabel = `ov${i}`;

    // Scale avatar, apply chroma key, then overlay with time enable
    const avatarLabel = `av${i}`;
    chain += `;[${inputIdx}:v]scale=${avatarW}:${avatarW},colorkey=${chromaKeyColor}:0.3:0.15`;
    if (isCircle) {
      chain += `,format=yuva420p,geq='lum=lum(X,Y):cb=cb(X,Y):cr=cr(X,Y):a=if(gt(pow(X-${avatarW}/2\\,2)+pow(Y-${avatarW}/2\\,2)\\,pow(${avatarW}/2\\,2))\\,0\\,alpha(X\\,Y))'`;
    }
    chain += `[${avatarLabel}]`;

    chain += `;[${lastLabel}][${avatarLabel}]overlay=${ox}:${oy}:enable='between(t\\,${startSec}\\,${endSec})'[${outLabel}]`;
    lastLabel = outLabel;
  }

  return { filterComplex: chain, inputs, lastLabel };
}

/**
 * Compose video using FFmpeg CLI with avatar overlay support.
 * Called from server-side when client WebCodecs is unavailable.
 * @param {object} params
 * @returns {Promise<Buffer>}
 */
export async function composeVideoWithAvatar(params) {
  const {
    audioPath,
    scenes,
    style,
    imagesDir,
    outputPath,
    avatarClips = [],
    avatarStyle = 'normal',
    circlePosition = 'bottom-right',
    circleSize = 12,
    chromaColor = '0x29761F',
    targetWidth = 1920,
    targetHeight = 1080,
    targetDurationSec = null,
    onLog = () => {}
  } = params;

  const workDir = path.join(path.dirname(outputPath), 'ffmpeg_tmp');
  await ensureDir(workDir);

  const concatList = generateConcatListForCli(scenes, imagesDir, style);
  const concatPath = path.join(workDir, 'concat.txt');
  await fs.promises.writeFile(concatPath, concatList);

  const hasAvatar = avatarClips.length > 0;
  const validClips = hasAvatar
    ? avatarClips.filter((c) => c.videoPath && c.startSec != null && c.endSec != null)
    : [];

  // Verify avatar clip files exist
  const verifiedClips = [];
  for (const clip of validClips) {
    try {
      await fs.promises.access(clip.videoPath);
      verifiedClips.push(clip);
    } catch {
      onLog(`Avatar clip not found, skipping: ${clip.videoPath}`);
    }
  }

  const args = [];

  if (verifiedClips.length > 0) {
    // Build filter_complex with avatar overlays
    const { filterComplex, lastLabel } = buildAvatarFilterComplex({
      avatarClips: verifiedClips,
      avatarStyle,
      circlePosition,
      circleSize,
      targetWidth,
      targetHeight,
      chromaColor
    });

    // Inputs: concat images, audio, then avatar clips
    args.push('-f', 'concat', '-safe', '0', '-i', concatPath);
    args.push('-i', audioPath);
    for (const clip of verifiedClips) {
      args.push('-i', clip.videoPath);
    }

    args.push('-filter_complex', filterComplex);
    args.push('-map', `[${lastLabel}]`, '-map', '1:a');
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    // No avatar — simple filter
    const baseFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`;
    args.push('-f', 'concat', '-safe', '0', '-i', concatPath);
    args.push('-i', audioPath);
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-vf', baseFilter);
  }

  if (Number.isFinite(targetDurationSec)) {
    args.push('-t', String(targetDurationSec));
  }
  args.push('-y', outputPath);

  onLog(`FFmpeg compose: ${verifiedClips.length} avatar clips, ${targetWidth}x${targetHeight}`);

  try {
    await execFileAsync('ffmpeg', args, { windowsHide: true, timeout: 600000 });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('ffmpeg CLI not found. Install ffmpeg and ensure it is on PATH.');
    }
    throw new Error(`ffmpeg CLI failed: ${error.message}`);
  }

  const videoBuffer = await fs.promises.readFile(outputPath);
  onLog(`FFmpeg compose done: ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB`);
  return videoBuffer;
}

if (process.argv[1] && process.argv[1].endsWith('compose-video.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.audioPath || !args.scenesPath || !args.subtitlesPath) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  composeVideo(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
