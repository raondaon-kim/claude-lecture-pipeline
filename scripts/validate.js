import fs from 'fs';
import path from 'path';
import { createClaudeClient, claudeToolCall } from './claude-client.js';
import { runWithConcurrency, delay } from './concurrency.js';
import { loadConfig } from './config.js';

const DEFAULT_OUTPUT = './output/subtitles/validated.json';
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MODEL = 'claude-sonnet-4-5';

const SYSTEM_PROMPT = `당신은 한국어 자막 교정 전문가입니다.

역할:
- 음성 인식으로 생성된 자막의 오류를 찾아 수정합니다.
- 원본 의미를 변경하지 않고 최소한의 수정만 합니다.
- 타임스탬프는 절대 수정하지 않습니다.

수정 대상:
1. 맞춤법 오류 (띄어쓰기 포함)
2. 문법 오류 (조사, 어미)
3. 구두점 (자연스러운 위치에 추가)
4. 명백한 오인식 (문맥상 틀린 단어)

수정하지 않는 것:
- 구어체 표현 (자연스러운 말투 유지)
- 반복 표현 (강조 의도일 수 있음)
- 감탄사, 추임새

각 세그먼트의 id, 수정된 text, corrections 배열을 반환하세요.
수정이 없으면 corrections는 빈 배열로 합니다.`;

const VALIDATE_BATCH_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          text: { type: 'string' },
          corrections: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['id', 'text', 'corrections']
      }
    }
  },
  required: ['segments']
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
 * Categorize corrections by keyword.
 * @param {string[]} corrections
 * @returns {{spelling: number, punctuation: number, context: number, terminology: number, other: number}}
 */
function categorizeCorrections(corrections) {
  const counts = {
    spelling: 0,
    punctuation: 0,
    context: 0,
    terminology: 0,
    other: 0
  };

  for (const item of corrections) {
    if (/맞춤법|철자|띄어쓰기/i.test(item)) {
      counts.spelling += 1;
    } else if (/구두점|쉼표|마침표/i.test(item)) {
      counts.punctuation += 1;
    } else if (/문맥|의미|맥락/i.test(item)) {
      counts.context += 1;
    } else if (/전문\s*용어|용어|terminology/i.test(item)) {
      counts.terminology += 1;
    } else {
      counts.other += 1;
    }
  }

  return counts;
}

/**
 * Summarize validation results.
 * @param {Array<{corrections: string[]}>} segments
 * @returns {{totalSegments: number, correctedSegments: number, correctionRate: string, correctionTypes: Record<string, number>}}
 */
function buildSummary(segments) {
  const totalSegments = segments.length;
  const correctedSegments = segments.filter((segment) => segment.corrections.length > 0).length;
  const allCorrections = segments.flatMap((segment) => segment.corrections);
  const correctionTypes = categorizeCorrections(allCorrections);
  const correctionRate = totalSegments > 0
    ? ((correctedSegments / totalSegments) * 100).toFixed(1) + '%'
    : '0.0%';

  return { totalSegments, correctedSegments, correctionRate, correctionTypes };
}

/**
 * Call Claude to validate a batch of segments.
 * @param {Anthropic} client
 * @param {Array<{id: number, text: string}>} batch
 * @returns {Promise<Array<{id: number, text: string, corrections: string[]}>>}
 */
async function validateBatch(client, batch) {
  const parsed = await claudeToolCall({
    client,
    model: DEFAULT_MODEL,
    system: SYSTEM_PROMPT,
    userMessage: JSON.stringify({ segments: batch }),
    toolName: 'validate_segments',
    inputSchema: VALIDATE_BATCH_SCHEMA,
    maxTokens: 4096
  });

  const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  return segments.map((segment) => ({
    id: segment.id,
    text: typeof segment.text === 'string' ? segment.text : '',
    corrections: Array.isArray(segment.corrections) ? segment.corrections : []
  }));
}

/**
 * Validate subtitles with retry on rate limit errors.
 * @param {Anthropic} client
 * @param {Array<{id: number, text: string}>} batch
 * @param {{maxRetries?: number, delayMs?: number}} options
 * @returns {Promise<Array<{id: number, text: string, corrections: string[]}>>}
 */
async function validateBatchWithRetry(client, batch, options = {}) {
  const { maxRetries = 3, delayMs = 1000 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await validateBatch(client, batch);
    } catch (error) {
      const isRateLimit = error?.status === 429;

      if (!isRateLimit) {
        throw error;
      }

      if (attempt === maxRetries) {
        throw error;
      }

      await delay(delayMs * attempt);
    }
  }

  throw new Error('Unexpected validation retry failure.');
}

/**
 * Merge validated text into original segments while preserving timestamps.
 * @param {Array<{id: number, start: number, end: number, text: string}>} original
 * @param {Array<{id: number, text: string, corrections: string[]}>} validated
 * @returns {Array<{id: number, start: number, end: number, text: string, original: string, corrections: string[]}>}
 */
function mergeSegments(original, validated) {
  const validatedMap = new Map(validated.map((segment) => [segment.id, segment]));

  return original.map((segment) => {
    const match = validatedMap.get(segment.id);
    const correctedText = match?.text?.trim() || segment.text;
    return {
      id: segment.id,
      start: segment.start,
      end: segment.end,
      text: correctedText,
      original: segment.text,
      corrections: match?.corrections || []
    };
  });
}

/**
 * Validate and correct subtitles JSON.
 * @param {{input: string, output?: string, batchSize?: number, concurrency?: number}} options
 * @returns {Promise<{outputPath: string, correctedSegments: number}>}
 */
export async function validateSubtitles(options) {
  const { input, output = DEFAULT_OUTPUT, batchSize = DEFAULT_BATCH_SIZE, concurrency = 2 } = options;
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
  const resolvedBatchSize = Number.isFinite(batchSize) ? batchSize : DEFAULT_BATCH_SIZE;
  const resolvedConcurrency = Math.max(1, Number(concurrency) || 2);

  const batches = [];
  for (let i = 0; i < segments.length; i += resolvedBatchSize) {
    batches.push(
      segments.slice(i, i + resolvedBatchSize).map((segment) => ({
        id: segment.id,
        text: segment.text
      }))
    );
  }

  const batchResults = await runWithConcurrency(batches, resolvedConcurrency, async (batch) => {
    return await validateBatchWithRetry(client, batch);
  });

  const results = batchResults.flat();

  const merged = mergeSegments(segments, results);
  const summary = buildSummary(merged);

  const outputPayload = {
    segments: merged,
    language: payload.language || 'ko',
    duration: payload.duration ?? 0,
    validationSummary: summary
  };

  await fs.promises.writeFile(output, JSON.stringify(outputPayload, null, 2));
  console.log(`Saved validated subtitles to ${output}`);

  return { outputPath: output, correctedSegments: summary.correctedSegments };
}

/**
 * Parse CLI arguments for validate command.
 * @param {string[]} argv
 * @returns {{input?: string, output?: string, batchSize?: number, help?: boolean}}
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
    } else if (token === '--batch-size') {
      args.batchSize = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

/**
 * Print usage for the validate command.
 * @returns {void}
 */
function printUsage() {
  console.log('Usage: node src/validate.js --input ./output/subtitles/raw.json');
  console.log('Options:');
  console.log('  --output ./output/subtitles/validated.json');
  console.log('  --batch-size 10');
}

if (process.argv[1] && process.argv[1].endsWith('validate.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  validateSubtitles(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
