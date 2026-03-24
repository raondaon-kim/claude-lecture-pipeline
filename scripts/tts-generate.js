import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import ffmpegPkg from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { resolveFfmpegCoreUrls } from './ffmpeg-core.js';
import { delay, runWithConcurrency } from './concurrency.js';

const { FFmpeg } = ffmpegPkg;
import { loadConfig } from './config.js';

const DEFAULT_INPUT = './output/tts/chunks.json';
const DEFAULT_OUTPUT_DIR = './output/tts/audio';
const DEFAULT_OUTPUT = './output/tts/audio/merged.mp3';
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_BITRATE = '192k';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const DEFAULT_VOICE = 'YHbcYz0gzSD8Aot9BMqR'; // Rachel
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_CONCAT_BATCH_SIZE = 10;
const DEFAULT_FFMPEG_PATH = 'ffmpeg';

let systemFfmpegChecked = false;
let systemFfmpegAvailable = false;
let systemFfmpegPath = DEFAULT_FFMPEG_PATH;

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

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

async function assertFileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (error) {
    throw new Error(`Input file not found: ${filePath}`);
  }
}

async function resetFfmpegWorkspace(ffmpeg) {
  try {
    const entries = await ffmpeg.listDir('/');
    for (const entry of entries) {
      if (!entry.isFile) continue;
      if (entry.name === 'concat.txt' || entry.name === 'merged.mp3' || entry.name.endsWith('.mp3')) {
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

function createLogger(level = DEFAULT_LOG_LEVEL) {
  const levels = ['debug', 'info', 'warn', 'error'];
  const current = levels.indexOf(level);
  const enabled = (lvl) => levels.indexOf(lvl) >= (current === -1 ? 1 : current);

  return {
    debug: (msg) => {
      if (enabled('debug')) console.log(`[TTS][DEBUG] ${msg}`);
    },
    info: (msg) => {
      if (enabled('info')) console.log(`[TTS][INFO] ${msg}`);
    },
    warn: (msg) => {
      if (enabled('warn')) console.warn(`[TTS][WARN] ${msg}`);
    },
    error: (msg) => {
      if (enabled('error')) console.error(`[TTS][ERROR] ${msg}`);
    }
  };
}

function isRateLimitError(error) {
  const code = error?.status || error?.statusCode || error?.code;
  if (code === 429) return true;
  const message = error?.message || '';
  return /rate limit|quota exceeded|too_many_concurrent_requests|system_busy/i.test(message);
}

function getRetryDelayMs(error, attempt) {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s
  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

function buildFilename(index) {
  return `chunk_${String(index).padStart(4, '0')}`;
}

function buildChunkFileList(chunks, outputDir) {
  return chunks
    .map((chunk, idx) => Number.isFinite(chunk?.index) ? chunk.index : idx)
    .map((index) => path.join(outputDir, `${buildFilename(index)}.mp3`));
}

/**
 * Collect a ReadableStream / AsyncIterable into a Buffer.
 */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Request TTS audio from ElevenLabs and return MP3 buffer.
 */
async function requestElevenLabsTts(client, text, voiceId, modelId, outputFormat, maxRetries, logger) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      logger?.debug?.(`TTS attempt ${attempt} (text chars: ${text.length})`);
      const audioStream = await client.textToSpeech.convert(voiceId, {
        text,
        modelId,
        outputFormat
      });
      const buffer = await streamToBuffer(audioStream);
      if (buffer.length === 0) {
        throw new Error('ElevenLabs returned empty audio buffer.');
      }
      logger?.debug?.(`TTS response bytes=${buffer.length}`);
      return buffer;
    } catch (error) {
      if (!isRateLimitError(error) || attempt === maxRetries) {
        throw error;
      }
      const retryDelay = getRetryDelayMs(error, attempt);
      logger?.warn?.(`TTS rate limit. Retry in ${retryDelay}ms (attempt ${attempt}/${maxRetries})`);
      await delay(retryDelay);
    }
  }

  throw new Error('Unexpected TTS retry failure.');
}

/**
 * Generate MP3 for a single chunk.
 */
async function generateChunkAudio(
  client,
  chunk,
  index,
  outputDir,
  voiceId,
  modelId,
  outputFormat,
  maxRetries,
  logger
) {
  const text = typeof chunk?.text === 'string' ? chunk.text.trim() : '';
  if (!text) {
    logger?.warn?.(`Chunk ${index}: empty text, skipping.`);
    return null;
  }
  const filename = buildFilename(index);
  const mp3Path = path.join(outputDir, `${filename}.mp3`);
  logger?.debug?.(`Chunk ${index}: start (text chars: ${text.length})`);
  const buffer = await requestElevenLabsTts(
    client,
    text,
    voiceId,
    modelId,
    outputFormat,
    maxRetries,
    logger
  );
  logger?.debug?.(`Chunk ${index}: audio bytes=${buffer.length}`);
  await fs.promises.writeFile(mp3Path, buffer);
  logger?.info?.(`Chunk ${index}: saved mp3 ${mp3Path}`);
  return { index, path: mp3Path };
}

function buildConcatList(files) {
  return files
    .map((file) => `file '${String(file).replace(/\\/g, '/')}'`)
    .join('\n');
}

function resolveSystemFfmpegPath() {
  return process.env.FFMPEG_PATH || DEFAULT_FFMPEG_PATH;
}

async function checkSystemFfmpeg(logger) {
  if (systemFfmpegChecked) {
    return systemFfmpegAvailable;
  }

  systemFfmpegChecked = true;
  systemFfmpegPath = resolveSystemFfmpegPath();

  systemFfmpegAvailable = await new Promise((resolve) => {
    const child = spawn(systemFfmpegPath, ['-version'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });

  if (!systemFfmpegAvailable) {
    logger?.warn?.(`System ffmpeg not available at "${systemFfmpegPath}".`);
  } else {
    logger?.debug?.(`Using system ffmpeg at "${systemFfmpegPath}".`);
  }

  return systemFfmpegAvailable;
}

async function runSystemFfmpeg(args, logger) {
  const ffmpegPath = systemFfmpegPath || resolveSystemFfmpegPath();
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
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
      const tail = stderr.trim().slice(-2000);
      reject(new Error(`ffmpeg exited with code ${code}: ${tail || 'unknown error'}`));
    });
  });
  logger?.debug?.(`ffmpeg args: ${args.join(' ')}`);
}

async function concatMp3(files, outputPath, bitrate, logger, options = {}) {
  if (files.length === 0) {
    throw new Error('No MP3 files to concatenate.');
  }

  const batchSize = Math.max(1, Number(options.batchSize) || DEFAULT_CONCAT_BATCH_SIZE);
  const useSystem = await checkSystemFfmpeg(logger);
  let ffmpeg = null;
  if (!useSystem) {
    try {
      ffmpeg = await createFfmpegInstance();
    } catch (error) {
      throw new Error('System ffmpeg not found and ffmpeg.wasm is not supported in Node.js. Install ffmpeg or set FFMPEG_PATH.');
    }
  }

  const concatOnceWasm = async (inputFiles, targetPath, label) => {
    if (!ffmpeg) {
      throw new Error('ffmpeg.wasm is not available in this environment.');
    }
    await resetFfmpegWorkspace(ffmpeg);
    const filenames = [];
    for (let i = 0; i < inputFiles.length; i += 1) {
      const name = `input_${String(i).padStart(4, '0')}.mp3`;
      const data = await fetchFile(inputFiles[i]);
      await ffmpeg.writeFile(name, data);
      filenames.push(name);
    }

    const concatContent = buildConcatList(filenames);
    await ffmpeg.writeFile('concat.txt', concatContent);

    const baseArgs = ['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-y'];
    const copyArgs = [...baseArgs, '-c', 'copy', 'merged.mp3'];
    const reencodeArgs = [...baseArgs, '-c:a', 'libmp3lame', '-b:a', bitrate, 'merged.mp3'];

    try {
      await ffmpeg.exec(copyArgs);
    } catch (error) {
      logger?.warn?.(`${label}: concat copy failed. Retrying with re-encode.`);
      await ffmpeg.exec(reencodeArgs);
    }

    const outputData = await ffmpeg.readFile('merged.mp3');
    await fs.promises.writeFile(targetPath, outputData);
    logger?.info?.(`${label}: saved ${targetPath}`);
  };

  const concatOnceSystem = async (inputFiles, targetPath, label, tempDir) => {
    const concatPath = path.join(
      tempDir,
      `concat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
    );
    const concatContent = buildConcatList(inputFiles);
    await fs.promises.writeFile(concatPath, concatContent);

    const baseArgs = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-y'];
    const copyArgs = [...baseArgs, '-c', 'copy', targetPath];
    const reencodeArgs = [...baseArgs, '-c:a', 'libmp3lame', '-b:a', bitrate, targetPath];

    try {
      await runSystemFfmpeg(copyArgs, logger);
    } catch (error) {
      logger?.warn?.(`${label}: concat copy failed. Retrying with re-encode.`);
      await runSystemFfmpeg(reencodeArgs, logger);
    }

    logger?.info?.(`${label}: saved ${targetPath}`);
  };

  if (files.length <= batchSize) {
    if (useSystem) {
      await concatOnceSystem(files, outputPath, 'concat', path.dirname(outputPath));
    } else {
      await concatOnceWasm(files, outputPath, 'concat');
    }
    return;
  }

  const tempDir = path.join(path.dirname(outputPath), '.concat-temp');
  await ensureDir(tempDir);
  let current = files.slice();
  let pass = 0;

  try {
    while (current.length > 1) {
      pass += 1;
      const next = [];
      const batches = Math.ceil(current.length / batchSize);
      logger?.info?.(`Concat pass ${pass}: ${current.length} files -> ${batches} batches`);

      for (let i = 0; i < current.length; i += batchSize) {
        const batch = current.slice(i, i + batchSize);
        const partName = `pass_${String(pass).padStart(2, '0')}_part_${String(next.length).padStart(3, '0')}.mp3`;
        const partPath = path.join(tempDir, partName);
        if (useSystem) {
          await concatOnceSystem(batch, partPath, `pass ${pass} batch ${next.length + 1}`, tempDir);
        } else {
          await concatOnceWasm(batch, partPath, `pass ${pass} batch ${next.length + 1}`);
        }
        next.push(partPath);
      }

      current = next;
    }

    if (current[0] !== outputPath) {
      await fs.promises.copyFile(current[0], outputPath);
    }
    logger?.info?.(`Merged audio saved to ${outputPath}`);
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      logger?.warn?.(`Failed to clean temp concat dir: ${tempDir}`);
    }
  }
}

/**
 * Generate MP3 audio for all chunks and merge them.
 */
export async function generateTtsAudio(options = {}) {
  const {
    input = DEFAULT_INPUT,
    outputDir = DEFAULT_OUTPUT_DIR,
    output = DEFAULT_OUTPUT,
    concurrency = DEFAULT_CONCURRENCY,
    bitrate = DEFAULT_BITRATE,
    model = DEFAULT_MODEL,
    voice = DEFAULT_VOICE,
    outputFormat = DEFAULT_OUTPUT_FORMAT,
    maxRetries = DEFAULT_MAX_RETRIES,
    logLevel = DEFAULT_LOG_LEVEL,
    concatBatchSize = DEFAULT_CONCAT_BATCH_SIZE,
    skipMerge = false
  } = options;

  const logger = createLogger(logLevel);
  await assertFileExists(input);
  await ensureDir(outputDir);
  await ensureDir(path.dirname(output));

  const raw = await fs.promises.readFile(input, 'utf-8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error('Input file is not valid JSON.');
  }

  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
  if (chunks.length === 0) {
    throw new Error('Input JSON must contain a chunks array.');
  }

  const ordered = [...chunks].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const { elevenlabsApiKey } = loadConfig();
  const client = new ElevenLabsClient({ apiKey: elevenlabsApiKey });
  logger.info(`Chunks: ${ordered.length}`);
  logger.info(`Model: ${model}, Voice: ${voice}, Format: ${outputFormat}`);
  logger.info(`Concurrency: ${concurrency}, maxRetries: ${maxRetries}`);

  const results = await runWithConcurrency(ordered, concurrency, async (chunk, index) => {
    const chunkIndex = Number.isFinite(chunk.index) ? chunk.index : index;
    return await generateChunkAudio(
      client,
      chunk,
      chunkIndex,
      outputDir,
      voice,
      model,
      outputFormat,
      maxRetries,
      logger
    );
  });

  const files = results
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.path);

  logger.info(`Generated MP3 files: ${files.length}`);
  if (skipMerge) {
    logger.info('Skip merge enabled. Chunk MP3 files are ready.');
    return { outputPath: null, files: files.length, skippedMerge: true };
  }

  await concatMp3(files, output, bitrate, logger, { batchSize: concatBatchSize });

  return { outputPath: output, files: files.length };
}

/**
 * Regenerate a single chunk MP3 and update file.
 */
export async function regenerateTtsChunk(options = {}) {
  const {
    text,
    index,
    outputDir,
    model = DEFAULT_MODEL,
    voice = DEFAULT_VOICE,
    outputFormat = DEFAULT_OUTPUT_FORMAT,
    maxRetries = DEFAULT_MAX_RETRIES,
    logLevel = DEFAULT_LOG_LEVEL
  } = options;

  if (!text || !String(text).trim()) {
    throw new Error('Text is required to regenerate TTS chunk.');
  }
  if (!Number.isFinite(index)) {
    throw new Error('Chunk index is required to regenerate TTS chunk.');
  }
  if (!outputDir) {
    throw new Error('outputDir is required to regenerate TTS chunk.');
  }

  const logger = createLogger(logLevel);
  await ensureDir(outputDir);
  const { elevenlabsApiKey } = loadConfig();
  const client = new ElevenLabsClient({ apiKey: elevenlabsApiKey });

  return generateChunkAudio(
    client,
    { text },
    index,
    outputDir,
    voice,
    model,
    outputFormat,
    maxRetries,
    logger
  );
}

/**
 * Merge existing chunk MP3 files into a single MP3.
 */
export async function mergeTtsChunks(options = {}) {
  const {
    input = DEFAULT_INPUT,
    outputDir = DEFAULT_OUTPUT_DIR,
    output = DEFAULT_OUTPUT,
    bitrate = DEFAULT_BITRATE,
    concatBatchSize = DEFAULT_CONCAT_BATCH_SIZE,
    logLevel = DEFAULT_LOG_LEVEL
  } = options;

  const logger = createLogger(logLevel);
  await assertFileExists(input);
  await ensureDir(outputDir);
  await ensureDir(path.dirname(output));

  const raw = await fs.promises.readFile(input, 'utf-8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error('Input file is not valid JSON.');
  }

  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
  if (chunks.length === 0) {
    throw new Error('Input JSON must contain a chunks array.');
  }

  const ordered = [...chunks].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const files = buildChunkFileList(ordered, outputDir);
  for (const file of files) {
    await assertFileExists(file);
  }

  await concatMp3(files, output, bitrate, logger, { batchSize: concatBatchSize });
  return { outputPath: output, files: files.length };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help') {
      args.help = true;
    } else if (token === '--input') {
      args.input = argv[i + 1];
      i += 1;
    } else if (token === '--output-dir') {
      args.outputDir = argv[i + 1];
      i += 1;
    } else if (token === '--output') {
      args.output = argv[i + 1];
      i += 1;
    } else if (token === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--bitrate') {
      args.bitrate = argv[i + 1];
      i += 1;
    } else if (token === '--model') {
      args.model = argv[i + 1];
      i += 1;
    } else if (token === '--voice') {
      args.voice = argv[i + 1];
      i += 1;
    } else if (token === '--format') {
      args.outputFormat = argv[i + 1];
      i += 1;
    } else if (token === '--max-retries') {
      args.maxRetries = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--log-level') {
      args.logLevel = argv[i + 1];
      i += 1;
    } else if (token === '--concat-batch-size') {
      args.concatBatchSize = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--skip-merge') {
      args.skipMerge = true;
    }
  }
  return args;
}

function printUsage() {
  console.log('Usage: node src/tts-generate.js --input ./output/tts/chunks.json');
  console.log('Options:');
  console.log('  --output-dir ./output/tts/audio');
  console.log('  --output ./output/tts/audio/merged.mp3');
  console.log('  --concurrency 3');
  console.log('  --bitrate 192k');
  console.log('  --model eleven_multilingual_v2');
  console.log('  --voice 21m00Tcm4TlvDq8ikWAM');
  console.log('  --format mp3_44100_128');
  console.log('  --max-retries 5');
  console.log('  --log-level debug|info|warn|error');
  console.log('  --concat-batch-size 10');
  console.log('  --skip-merge');
}

if (process.argv[1] && process.argv[1].endsWith('tts-generate.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  generateTtsAudio(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
