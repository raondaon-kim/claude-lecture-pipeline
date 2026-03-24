import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { getRequiredEnv } from './config.js';
import { runWithConcurrency } from './concurrency.js';

const DEFAULT_OUTPUT = './output/tts/chunks.json';
const DEFAULT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_BATCH_SIZE = 6;
const DEFAULT_SPEECH_RATE = 4.0;
const DEFAULT_PAUSE = 0.8;

const SYSTEM_PROMPT = `당신은 TTS용 강의 스크립트를 의미 흐름 기준으로 청크 분할하는 전문가입니다.
글자 수/시간 기준으로 자르지 말고, 설명의 완결 지점을 기준으로 분할하세요.
원문을 임의로 요약하거나 새로운 내용을 추가하지 마세요.`;

const CHUNK_PROMPT = `다음 강의 스크립트 세그먼트를 청크로 분할하세요.

분할 규칙:
- 의미 흐름이 완결되는 지점에서만 분할
- 정의/나열/원인-결과/비교의 중간은 절대 분할 금지
- 청크는 단독으로 이해 가능해야 함
- 괄호로 부연 설명을 넣지 않음
- 약어/영문은 가능한 한 풀어쓰기(필요하면 다음 문장으로 설명)

출력 규칙:
- 반드시 JSON만 출력
- 입력 세그먼트 순서를 유지
- 분할이 필요 없으면 chunks는 1개, splitReason은 "분할 불필요"

출력 형식:
{
  "segments": [
    {
      "id": "sec_001_001",
      "chunks": [
        {
          "text": "청크 텍스트",
          "flowPosition": "start|middle|end|complete",
          "contentType": "definition|explanation|example|transition|summary",
          "splitReason": "분할 이유"
        }
      ]
    }
  ]
}

입력 세그먼트:
`;

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
 * Extract JSON content from a model response.
 * @param {string} content
 * @returns {object | null}
 */
function safeParseJson(content) {
  if (typeof content !== 'string') {
    return null;
  }

  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : content;

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    return null;
  }

  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (error) {
    return null;
  }
}

/**
 * Count characters for duration estimate.
 * @param {string} text
 * @returns {number}
 */
function countChars(text) {
  return text.replace(/\s+/g, '').length;
}

/**
 * Estimate duration by character count.
 * @param {string} text
 * @param {number} speechRate
 * @returns {number}
 */
function estimateDuration(text, speechRate) {
  const chars = countChars(text);
  if (!speechRate || speechRate <= 0) {
    return Math.max(1, Math.round(chars / DEFAULT_SPEECH_RATE));
  }
  return Math.max(1, Math.round(chars / speechRate));
}

/**
 * Extract text output from Gemini response.
 * @param {any} response
 * @returns {string}
 */
function getResponseText(response) {
  if (typeof response?.text === 'string') {
    return response.text;
  }
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const textParts = parts
    .filter((part) => typeof part.text === 'string')
    .map((part) => part.text);
  return textParts.join('\n').trim();
}

/**
 * Call Gemini to split a batch into chunks.
 * @param {GoogleGenAI} client
 * @param {string} model
 * @param {Array<object>} batch
 * @returns {Promise<object>}
 */
async function chunkBatch(client, model, batch) {
  const prompt = `${CHUNK_PROMPT}${JSON.stringify({ segments: batch }, null, 2)}`;

  const response = await client.models.generateContent({
    model,
    contents: [
      { text: SYSTEM_PROMPT },
      { text: prompt }
    ]
  });

  const content = getResponseText(response);
  const parsed = safeParseJson(content);
  if (!parsed) {
    const preview = content.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Failed to parse chunk JSON response: ${preview}...`);
  }

  return parsed;
}

/**
 * Build chunk id.
 * @param {string} segmentId
 * @param {number} index
 * @returns {string}
 */
function buildChunkId(segmentId, index) {
  return `${segmentId}_chunk_${String(index).padStart(3, '0')}`;
}

/**
 * Normalize chunks and compute derived fields.
 * @param {Array<object>} segments
 * @param {Array<object>} chunkedSegments
 * @param {object} options
 * @returns {Array<object>}
 */
function normalizeChunks(segments, chunkedSegments, options) {
  const segmentMap = new Map(segments.map((segment) => [segment.id, segment]));
  const output = [];
  let globalIndex = 0;

  for (const item of chunkedSegments) {
    const original = segmentMap.get(item.id);
    if (!original || !Array.isArray(item.chunks)) {
      continue;
    }

    const chunkCharCounts = item.chunks.map((chunk) =>
      countChars(typeof chunk.text === 'string' ? chunk.text : '')
    );
    const totalCharCount = chunkCharCounts.reduce((sum, value) => sum + value, 0) || 1;

    item.chunks.forEach((chunk, idx) => {
      const text = typeof chunk.text === 'string' ? chunk.text.trim() : '';
      const charCount = countChars(text);
      const estimatedDuration = typeof original.estimatedDuration === 'number'
        ? Math.max(
            1,
            Math.round((original.estimatedDuration * charCount) / totalCharCount)
          )
        : estimateDuration(text, options.speechRate);
      const emphasis = Array.isArray(original.emphasis)
        ? original.emphasis.filter((term) => text.includes(term))
        : [];

      output.push({
        id: buildChunkId(original.id, idx + 1),
        originalSegmentId: original.id,
        segmentType: original.type || 'concept',
        text,
        splitReason: chunk.splitReason || '분할 불필요',
        flowPosition: chunk.flowPosition || (item.chunks.length === 1 ? 'complete' : 'middle'),
        contentType: chunk.contentType || 'explanation',
        index: globalIndex,
        charCount,
        estimatedDuration,
        tts: {
          speed: typeof original.speed === 'number' ? original.speed : 1.0,
          pitch: typeof original.pitch === 'number' ? original.pitch : 1.0,
          pauseAfter: typeof original.pauseAfter === 'number' ? original.pauseAfter : options.defaultPause,
          emphasis
        }
      });
      globalIndex += 1;
    });
  }

  return output;
}

/**
 * Split lecture script into TTS chunks.
 * @param {{input: string, output?: string, model?: string, batchSize?: number, speechRate?: number, defaultPause?: number}} options
 * @returns {Promise<{outputPath: string, totalChunks: number}>}
 */
export async function splitTtsChunks(options) {
  const {
    input,
    output = DEFAULT_OUTPUT,
    model = DEFAULT_MODEL,
    batchSize = DEFAULT_BATCH_SIZE,
    speechRate = DEFAULT_SPEECH_RATE,
    defaultPause = DEFAULT_PAUSE,
    concurrency = 3
  } = options;

  if (!input) {
    throw new Error('Missing required option: input');
  }

  await assertFileExists(input);
  await ensureDir(path.dirname(output));

  const googleApiKey = getRequiredEnv('GOOGLE_API_KEY');
  const client = new GoogleGenAI({ apiKey: googleApiKey });

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

  const segments = payload.segments.map((segment) => ({
    id: segment.id,
    type: segment.type,
    text: segment.text,
    keyPoint: segment.keyPoint,
    emphasis: segment.emphasis
  }));

  const resolvedConcurrency = Math.max(1, Number(concurrency) || 3);
  const allBatches = [];
  for (let i = 0; i < segments.length; i += batchSize) {
    allBatches.push(segments.slice(i, i + batchSize));
  }

  const batchResults = await runWithConcurrency(allBatches, resolvedConcurrency, async (batch) => {
    const result = await chunkBatch(client, model, batch);
    if (!Array.isArray(result?.segments)) {
      throw new Error('Chunking response missing segments array.');
    }
    return result.segments;
  });

  const chunked = batchResults.flat();

  const chunks = normalizeChunks(payload.segments, chunked, { speechRate, defaultPause });
  const totalDuration = chunks.reduce((sum, chunk) => sum + (chunk.estimatedDuration || 0), 0);
  const minutes = Math.floor(totalDuration / 60);
  const seconds = totalDuration % 60;

  const outputPayload = {
    metadata: {
      title: payload?.metadata?.title || '강의',
      originalSegments: payload.segments.length,
      totalChunks: chunks.length,
      estimatedTotalDuration: {
        minutes,
        seconds,
        total: totalDuration
      }
    },
    chunks
  };

  await fs.promises.writeFile(output, JSON.stringify(outputPayload, null, 2));
  console.log(`Saved TTS chunks to ${output}`);

  return { outputPath: output, totalChunks: chunks.length };
}

/**
 * Parse CLI arguments for tts-chunk command.
 * @param {string[]} argv
 * @returns {{input?: string, output?: string, model?: string, batchSize?: number, speechRate?: number, defaultPause?: number, help?: boolean}}
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
    } else if (token === '--model') {
      args.model = argv[i + 1];
      i += 1;
    } else if (token === '--batch-size') {
      args.batchSize = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--speech-rate') {
      args.speechRate = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--default-pause') {
      args.defaultPause = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

/**
 * Print usage for tts-chunk command.
 * @returns {void}
 */
function printUsage() {
  console.log('Usage: node src/tts-chunk.js --input ./output/scripts/lecture-script.json');
  console.log('Options:');
  console.log('  --output ./output/tts/chunks.json');
  console.log('  --model gemini-3-flash-preview');
  console.log('  --batch-size 6');
  console.log('  --speech-rate 4.0');
  console.log('  --default-pause 0.8');
}

if (process.argv[1] && process.argv[1].endsWith('tts-chunk.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  splitTtsChunks(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
