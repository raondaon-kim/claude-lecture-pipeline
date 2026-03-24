import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { getRequiredEnv } from './config.js';

const DEFAULT_OUTPUT = './output/ocr/document.md';
const DEFAULT_MODEL = 'gemini-2.0-flash';
const MAX_BYTES = 20 * 1024 * 1024;

const DEFAULT_PROMPT = `다음 PDF 문서를 OCR로 추출해 Markdown(.md)으로 정리하세요.

필수 요구사항:
- 모든 페이지를 순서대로 처리
- 제목/소제목/본문 구조를 Markdown 헤딩과 문단으로 반영
- 표는 Markdown 테이블로 변환
- 삽화/그림/도식은 텍스트로 설명하고, 다음 형식을 사용:
  ![삽화 설명](image)
- 이미지 캡션이나 설명 텍스트가 있으면 포함
- 목록은 원본 번호/기호 유지
- 한글/영문 모두 정확하게 인식
- 확실하지 않은 부분은 [인식불가]로 표시

출력은 Markdown 텍스트만 반환하세요.`;

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
 * OCR a PDF file into Markdown.
 * @param {{input: string, output?: string, prompt?: string, model?: string}} options
 * @returns {Promise<{outputPath: string, chars: number}>}
 */
export async function ocrPdfToMarkdown(options) {
  const { input, output = DEFAULT_OUTPUT, prompt = DEFAULT_PROMPT, model = DEFAULT_MODEL } = options;
  if (!input) {
    throw new Error('Missing required option: input');
  }

  await assertFileExists(input);
  const stats = await fs.promises.stat(input);
  if (stats.size > MAX_BYTES) {
    throw new Error('PDF file is too large for inline OCR. Try a smaller file or split it.');
  }

  const googleApiKey = getRequiredEnv('GOOGLE_API_KEY');
  const client = new GoogleGenAI({ apiKey: googleApiKey });
  await ensureDir(path.dirname(output));

  const buffer = await fs.promises.readFile(input);
  const base64 = buffer.toString('base64');

  const response = await client.models.generateContent({
    model,
    contents: [
      { inlineData: { data: base64, mimeType: 'application/pdf' } },
      { text: prompt }
    ]
  });

  const text = getResponseText(response);
  if (!text) {
    throw new Error('Gemini OCR returned empty content.');
  }

  await fs.promises.writeFile(output, text);
  console.log(`Saved OCR markdown to ${output}`);

  return { outputPath: output, chars: text.length };
}

/**
 * Parse CLI arguments for pdf-ocr command.
 * @param {string[]} argv
 * @returns {{input?: string, output?: string, help?: boolean}}
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
    }
  }

  return args;
}

/**
 * Print usage for pdf-ocr command.
 * @returns {void}
 */
function printUsage() {
  console.log('Usage: node src/pdf-ocr.js --input ./input/document.pdf');
  console.log('Options:');
  console.log('  --output ./output/ocr/document.md');
}

if (process.argv[1] && process.argv[1].endsWith('pdf-ocr.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  ocrPdfToMarkdown(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
