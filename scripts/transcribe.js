import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import ffmpegPkg from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { resolveFfmpegCoreUrls } from './ffmpeg-core.js';
import { runWithConcurrency } from './concurrency.js';

const { FFmpeg } = ffmpegPkg;
import { loadConfig } from './config.js';

const MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_OUTPUT = './output/subtitles/raw.json';
const DEFAULT_CHUNK_SEC = 600;


/**
 * Pause for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
 * Remove temporary files from ffmpeg virtual filesystem.
 * @param {FFmpeg} ffmpeg
 * @returns {Promise<void>}
 */
async function resetFfmpegWorkspace(ffmpeg) {
  try {
    const entries = await ffmpeg.listDir('/');
    for (const entry of entries) {
      if (!entry.isFile) continue;
      if (entry.name === 'input.mp3' || entry.name.startsWith('chunk_')) {
        try {
          await ffmpeg.deleteFile(entry.name);
        } catch (error) {
          // Ignore stale file cleanup errors.
        }
      }
    }
  } catch (error) {
    // Ignore cleanup errors.
  }
}

/**
 * Split an audio file into chunks with ffmpeg.wasm.
 * @param {string} inputPath
 * @param {number} chunkDurationSec
 * @returns {Promise<string[]>}
 */
async function splitAudio(inputPath, chunkDurationSec) {
  const runId = Date.now().toString();
  const tempDir = path.join('./temp', `transcribe_${runId}`);
  await ensureDir(tempDir);

  const ffmpeg = await createFfmpegInstance();
  await resetFfmpegWorkspace(ffmpeg);

  const inputData = await fetchFile(inputPath);
  await ffmpeg.writeFile('input.mp3', inputData);

  await ffmpeg.exec([
    '-i',
    'input.mp3',
    '-f',
    'segment',
    '-segment_time',
    String(chunkDurationSec),
    '-c',
    'copy',
    'chunk_%03d.mp3'
  ]);

  const entries = await ffmpeg.listDir('/');
  const chunkNames = entries
    .filter((entry) => entry.isFile && /^chunk_\d{3}\.mp3$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const chunks = [];
  for (const name of chunkNames) {
    const data = await ffmpeg.readFile(name);
    const outputPath = path.join(tempDir, name);
    await fs.promises.writeFile(outputPath, data);
    chunks.push(outputPath);
  }

  if (chunks.length === 0) {
    throw new Error('No chunks were created. Ensure ffmpeg.wasm core is available.');
  }

  return chunks;
}

/**
 * Transcribe a single audio chunk.
 * @param {OpenAI} openai
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function transcribeChunk(openai, filePath) {
  const audioFile = fs.createReadStream(filePath);
  return openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'ko',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment']
  });
}

/**
 * Transcribe with retry on rate limits.
 * @param {OpenAI} openai
 * @param {string} filePath
 * @param {{maxRetries?: number, baseDelayMs?: number}} options
 * @returns {Promise<any>}
 */
async function transcribeWithRetry(openai, filePath, options = {}) {
  const { maxRetries = 3, baseDelayMs = 60000 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await transcribeChunk(openai, filePath);
    } catch (error) {
      const isRateLimit = error?.status === 429 || error?.code === 'rate_limit_exceeded';
      const isTooLong = error?.code === 'audio_too_long';

      if (isTooLong) {
        throw new Error('Audio file is too long. Try a smaller chunk size.');
      }

      if (!isRateLimit || attempt === maxRetries) {
        throw error;
      }

      await delay(baseDelayMs);
    }
  }

  throw new Error('Unexpected transcription retry failure.');
}

/**
 * Normalize segments with an offset and sequential IDs.
 * @param {Array<{start: number, end: number, text: string}>} segments
 * @param {number} offsetSec
 * @param {number} startId
 * @returns {{segments: Array<{id: number, start: number, end: number, text: string}>, nextId: number}}
 */
function normalizeSegments(segments, offsetSec, startId) {
  let currentId = startId;
  const normalized = segments.map((segment) => {
    const start = segment.start + offsetSec;
    const end = segment.end + offsetSec;
    const text = segment.text?.trim() ?? '';
    const entry = { id: currentId, start, end, text };
    currentId += 1;
    return entry;
  });

  return { segments: normalized, nextId: currentId };
}

/**
 * Transcribe an MP3 file into subtitle JSON.
 * @param {{input: string, output?: string, chunkDurationSec?: number}} options
 * @returns {Promise<{outputPath: string, segments: number}>}
 */
export async function transcribeAudio(options) {
  const { input, output = DEFAULT_OUTPUT, chunkDurationSec = DEFAULT_CHUNK_SEC, concurrency = 2 } = options;
  if (!input) {
    throw new Error('Missing required option: input');
  }

  await assertFileExists(input);
  const { openaiApiKey } = loadConfig();
  const openai = new OpenAI({ apiKey: openaiApiKey });

  await ensureDir(path.dirname(output));

  const stats = await fs.promises.stat(input);
  const resolvedChunkDurationSec = Number.isFinite(chunkDurationSec)
    ? chunkDurationSec
    : DEFAULT_CHUNK_SEC;
  const chunkPaths = stats.size > MAX_BYTES
    ? await splitAudio(input, resolvedChunkDurationSec)
    : [input];

  const resolvedConcurrency = Math.max(1, Number(concurrency) || 2);

  const responses = await runWithConcurrency(chunkPaths, resolvedConcurrency, async (chunkPath, index) => {
    console.log(`Transcribing chunk ${index + 1}/${chunkPaths.length}: ${chunkPath}`);
    return await transcribeWithRetry(openai, chunkPath);
  });

  let language = 'ko';
  let offsetSec = 0;
  let nextId = 0;
  const allSegments = [];

  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    if (!response?.segments) {
      throw new Error('Unexpected Whisper response: missing segments.');
    }

    language = response.language || language;
    const normalized = normalizeSegments(response.segments, offsetSec, nextId);
    allSegments.push(...normalized.segments);
    nextId = normalized.nextId;

    const chunkDuration = typeof response.duration === 'number'
      ? response.duration
      : (response.segments.length > 0
        ? response.segments[response.segments.length - 1].end
        : 0);
    offsetSec += chunkDuration;
  }

  const totalDuration = allSegments.length > 0
    ? Math.max(offsetSec, allSegments[allSegments.length - 1].end)
    : 0;

  const outputPayload = {
    segments: allSegments,
    language,
    duration: totalDuration
  };

  await fs.promises.writeFile(output, JSON.stringify(outputPayload, null, 2));
  console.log(`Saved transcription to ${output}`);

  return { outputPath: output, segments: allSegments.length };
}

/**
 * Parse CLI arguments for transcribe command.
 * @param {string[]} argv
 * @returns {{input?: string, output?: string, chunkDurationSec?: number, help?: boolean}}
 */
function parseArgs(argv) {
  const args = { };

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
    } else if (token === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

/**
 * Print usage for the transcribe command.
 * @returns {void}
 */
function printUsage() {
  console.log('Usage: node src/transcribe.js --input ./input/lecture.mp3');
  console.log('Options:');
  console.log('  --output ./output/subtitles/raw.json');
  console.log('  --chunk-duration 600');
}

if (process.argv[1] && process.argv[1].endsWith('transcribe.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  transcribeAudio(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
