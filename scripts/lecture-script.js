import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getRequiredEnv } from './config.js';

const DEFAULT_OUTPUT = './output/scripts/lecture-script.json';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_USE_WEB = true;
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `당신은 TTS용 강의 스크립트 작성 전문가입니다.
입력된 Markdown을 자연스러운 강의 스크립트로 변환하고, 의미 단위로 세그먼트를 나누세요.

규칙:
- 시간은 목표가 아니라 결과입니다. 충분한 완결된 설명이 되면 세그먼트를 끝내세요.
- 전문 용어는 쉬운 설명을 먼저 제시한 뒤 용어를 소개하세요.
- 청자 참여 유도 표현은 사용하지 않습니다.
- 내용은 간략 요약이 아니라, 핵심을 빠짐없이 풍부하게 설명합니다.
- 강의하듯 자연스러운 구어체를 사용합니다.
- "문서", "원문", "텍스트", "자료"를 언급하지 마세요. 강의자가 직접 내용을 설명하는 것처럼 작성하세요.
- 반드시 JSON만 출력하세요. JSON 외의 텍스트는 포함하지 마세요.`;

const OUTLINE_SUMMARY_PROMPT = `다음 Markdown 문서를 분석하여 강의용 아웃라인과 주제 요약을 하나의 JSON으로 출력하세요.

출력 규칙:
- 반드시 JSON만 출력
- "outline"과 "summary" 두 키를 포함

outline 규칙:
- 의미 단위로 나눔 (intro, concept, example, transition, summary 중 선택)
- 각 항목은 다음을 반드시 포함:
  • keyPoints: 핵심 개념
  • details: 원문의 구체적 설명, 근거, 학술용어 (요약하지 말고 원문 수준으로 상세히)
  • examples: 원문에서 추출한 구체적 사례, 수치, 통계치, 연도 (필수, 없으면 빈 배열)
  • quotes: 원문의 인용문 (화자명과 직책 포함, 없으면 빈 배열)

중요: 원문의 구체적 정보(인명, 연도, 수치, 기관명, 기술 표준명)를 절대 생략하지 마세요.

summary 규칙:
- 글의 핵심 주제, 목적, 대상 독자, 톤/관점을 파악

출력 형식:
{
  "outline": {
    "metadata": {
      "title": "강의 제목",
      "sectionCount": 0
    },
    "sections": [
      {
        "id": "sec_001",
        "type": "concept",
        "topic": "주제 요약",
        "keyPoints": ["핵심 요점 1", "핵심 요점 2"],
        "details": ["원문의 구체적 설명과 근거"],
        "examples": ["구체적 사례, 수치, 통계치"],
        "quotes": [{"speaker": "화자명", "title": "직책/소속", "text": "인용문 내용"}]
      }
    ]
  },
  "summary": {
    "topic": "글의 핵심 주제 (1-2문장)",
    "purpose": "글의 목적 (교육, 설명, 설득 등)",
    "audience": "대상 독자",
    "tone": "글의 톤과 관점 (학술적, 실용적, 입문자용 등)",
    "keyThemes": ["핵심 테마 1", "핵심 테마 2", "핵심 테마 3"]
  }
}

입력 Markdown:
`;

const SCRIPT_PROMPT = `다음 주제 요약과 아웃라인 JSON을 기반으로 TTS 강의 스크립트 JSON을 작성하세요.

주제 요약을 참고하여 글의 주제와 목적에 맞는 톤과 관점으로 스크립트를 작성하세요.

출력 규칙:
- 반드시 JSON만 출력
- segments는 아웃라인 섹션을 기반으로 생성
- 설명은 충분히 풍부하게 작성
- 청자 참여 유도 표현은 사용하지 않음
- 강의하듯 자연스러운 구어체를 사용
- 절대 괄호를 사용하지 않음. "한글(영문)" 형태 금지
- "문서", "원문", "텍스트", "자료"를 절대 언급하지 않음. 강의자가 직접 가르치는 것처럼 작성
- 약어/영문 표기 규칙:
  • 첫 등장: 풀어쓴 설명 후 약어 소개 (예: "공유 가능한 콘텐츠 객체 참조 모델, 줄여서 스콤이라고 합니다")
  • 이후 등장: 한글 발음만 사용 (예: "스콤은...")
  • "ADL(에이디엘)", "SCORM(스콤)" 같은 괄호 표기 절대 금지
- 웹 검색 결과는 내부 참고용이며, 출력 JSON에는 출처/링크/각주를 포함하지 않음

구체적 내용 포함 규칙 (필수):
- 아웃라인의 examples 필드에 있는 구체적 사례, 수치, 연도를 반드시 스크립트에 포함
- quotes 필드의 인용문을 자연스럽게 포함 (예: "~라고 말했습니다", "~라고 강조했습니다")
- details의 구체적 내용을 요약하지 말고 충분히 전개

출력 형식:
{
  "metadata": {
    "title": "강의 제목",
    "segmentCount": 0
  },
  "segments": [
    {
      "id": "sec_001_001",
      "type": "intro",
      "text": "강의 스크립트 문장",
      "keyPoint": "핵심 요약"
    }
  ]
}

주제 요약:
`;

const SCRIPT_PROMPT_OUTLINE = `

아웃라인 JSON:
`;

const FINAL_PROMPT = `다음 Markdown 원문을 기준으로 최종 강의 스크립트 JSON을 작성하세요. 강의 스크립트 초안은 원문의 예시나 근거를 보강하는 보조 참고 자료로만 사용하며, 원문을 우선합니다.

출력 규칙:
- 반드시 JSON만 출력
- 원문(Markdown)의 핵심 내용을 빠짐없이 반영
- 원문에 없는 내용은 초안에 있더라도 삭제하거나 재작성
- 초안은 원문의 예시/근거를 보강하거나 설명을 자연스럽게 연결하는 데만 사용
- 원문 대비 누락된 내용이 있으면 반드시 보완하여 추가
- 표/그림/목록 등 구조적 정보가 누락되지 않도록 설명에 포함
- 첫 번째 세그먼트는 자연스럽게 시작하며 "강의를 시작하겠습니다."로 시작
- 제목을 말하지 말 것
- 마지막 세그먼트에 "수고하셨습니다" 문장을 포함
- 청자 참여 유도 표현은 사용하지 않음
- 강의하듯 자연스러운 구어체를 사용
- 절대 괄호를 사용하지 않음. "한글(영문)", "영문(한글)" 형태 모두 금지
- "문서", "원문", "텍스트", "자료", "이 책"을 절대 언급하지 않음
- 강의자가 직접 내용을 설명하고 가르치는 관점으로 작성
- "문서에서는...", "원문에 따르면..." 같은 메타 표현 금지
- TTS가 읽을 텍스트이므로 중복 발음이 되는 표현 금지:
  • 금지: "에이디엘(ADL)", "스콤(SCORM)", "ADL(에이디엘)"
  • 허용: "에이디엘", "스콤", 또는 풀어쓴 설명 후 별도 문장으로 소개

누락 검증 체크리스트 (반드시 확인 후 누락 시 추가):
- 원문의 구체적 예시와 사례가 초안에 포함되었는가? (없으면 추가)
- 원문의 수치, 통계치, 연도, 인명이 초안에 포함되었는가? (없으면 추가)
- 원문의 인용문이 초안에 자연스럽게 포함되었는가? (없으면 "~라고 말했습니다" 형태로 추가)
- 원문의 기술 용어(SCORM, xAPI, ADL 등)가 설명과 함께 언급되었는가? (없으면 추가)
- 원문의 기관명, 프로젝트명, 이니셔티브명이 포함되었는가? (없으면 추가)

구체화 규칙:
- '여러 가지', '다양한', '많은' 같은 추상적 표현 → 원문의 구체적 목록으로 대체
- 초안의 요약적 설명 → 원문의 세부 내용으로 확장
- 원문에 있는 비교, 대조, 예시는 반드시 포함

출력 형식:
{
  "metadata": {
    "title": "강의 제목",
    "segmentCount": 0
  },
  "segments": [
    {
      "id": "sec_001_001",
      "type": "intro",
      "text": "강의 스크립트 문장",
      "keyPoint": "핵심 요약"
    }
  ]
}

입력 Markdown:
`;

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function assertFileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (error) {
    throw new Error(`Input file not found: ${filePath}`);
  }
}

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
 * Extract text from Anthropic Messages API response.
 */
function getResponseText(response) {
  if (!response || !Array.isArray(response.content)) {
    return '';
  }
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function buildSiblingPath(filePath, suffix) {
  const parsed = path.parse(filePath);
  const ext = parsed.ext || '.json';
  return path.join(parsed.dir, `${parsed.name}${suffix}${ext}`);
}

/**
 * Call Anthropic Messages API to get JSON output.
 */
async function generateJson(client, model, prompt) {
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  });

  const content = getResponseText(response);
  if (!content) {
    throw new Error('Claude returned empty content.');
  }

  const parsed = safeParseJson(content);
  if (!parsed) {
    const preview = content.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Failed to parse JSON response: ${preview}...`);
  }

  return parsed;
}

/**
 * Call Anthropic Messages API with web_search tool to get JSON output.
 */
async function generateJsonWithWebSearch(client, model, prompt) {
  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
    });
  } catch (error) {
    console.warn(`Web search call failed. Falling back to plain generation. ${error?.message || ''}`.trim());
    return generateJson(client, model, prompt);
  }

  const content = getResponseText(response);
  if (!content) {
    throw new Error('Claude returned empty content.');
  }

  const parsed = safeParseJson(content);
  if (!parsed) {
    const preview = content.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Failed to parse JSON response: ${preview}...`);
  }

  return parsed;
}

function wrapStepError(step, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`[lecture-script:${step}] ${message}`);
}

function enforceOpeningClosing(script, title) {
  if (!script || !Array.isArray(script.segments) || script.segments.length === 0) {
    return script;
  }

  const first = script.segments[0];
  const openingPrefix = '강의를 시작하겠습니다.';
  const originalText = typeof first.text === 'string' ? first.text.trim() : '';
  if (!originalText) {
    first.text = openingPrefix;
  } else {
    const sentences = originalText.split(/(?<=[.!?])\s+/);
    const dropPatterns = [title, '제목은', '이번 강의', '강의 제목', '강의를 시작'];
    let startIndex = 0;
    while (startIndex < sentences.length) {
      const sentence = sentences[startIndex];
      if (dropPatterns.some((pattern) => sentence.includes(pattern))) {
        startIndex += 1;
      } else {
        break;
      }
    }
    const rest = sentences.slice(startIndex).join(' ').trim();
    first.text = rest ? `${openingPrefix} ${rest}` : openingPrefix;
  }

  const last = script.segments[script.segments.length - 1];
  const closingPhrase = '수고하셨습니다.';
  if (typeof last.text === 'string') {
    if (!last.text.includes('수고하셨습니다')) {
      const trimmed = last.text.trim();
      const spacer = trimmed.length === 0 ? '' : ' ';
      last.text = `${trimmed}${spacer}${closingPhrase}`.trim();
    }
  } else {
    last.text = closingPhrase;
  }

  return script;
}

function sanitizeForTts(script) {
  if (!script || !Array.isArray(script.segments)) {
    return script;
  }

  const replaceMap = [
    [/\bAPI\b/g, '애플리케이션 프로그래밍 인터페이스'],
    [/\bICT\b/gi, '정보통신기술'],
    [/\bAI\b/g, '인공지능'],
    [/\bML\b/g, '머신러닝'],
    [/user-friendly/gi, '사용자 친화적']
  ];

  script.segments = script.segments.map((segment) => {
    if (typeof segment.text !== 'string') {
      return segment;
    }
    let text = segment.text;
    text = text.replace(/\([^)]*\)/g, '');
    replaceMap.forEach(([pattern, replacement]) => {
      text = text.replace(pattern, replacement);
    });
    text = text.replace(/\s{2,}/g, ' ').trim();
    return { ...segment, text };
  });

  return script;
}

function stripTimingFields(script) {
  if (!script || !Array.isArray(script.segments)) {
    return script;
  }

  script.segments = script.segments.map((segment) => {
    if (!segment || typeof segment !== 'object') {
      return segment;
    }
    const cleaned = { ...segment };
    delete cleaned.emphasis;
    delete cleaned.estimatedDuration;
    delete cleaned.pauseAfter;
    delete cleaned.speed;
    delete cleaned.pitch;
    return cleaned;
  });

  return script;
}

/**
 * Convert Markdown to lecture script JSON.
 */
export async function convertMarkdownToLectureScript(options) {
  const {
    input,
    output = DEFAULT_OUTPUT,
    title = 'PDF 강의',
    model = DEFAULT_MODEL,
    useWebSearch = DEFAULT_USE_WEB
  } = options;

  if (!input) {
    throw new Error('Missing required option: input');
  }

  await assertFileExists(input);
  const anthropicApiKey = getRequiredEnv('ANTHROPIC_API_KEY');
  const client = new Anthropic({ apiKey: anthropicApiKey });
  await ensureDir(path.dirname(output));

  const markdown = await fs.promises.readFile(input, 'utf-8');

  // Step 1: outline + summary (통합, 1회 호출)
  const outlineSummaryPrompt = `${OUTLINE_SUMMARY_PROMPT}${markdown}\n\n강의 제목: ${title}`;
  let outlineSummary;
  try {
    outlineSummary = await generateJson(client, model, outlineSummaryPrompt);
  } catch (error) {
    throw wrapStepError('outline-summary', error);
  }
  const outline = outlineSummary.outline || outlineSummary;
  const summary = outlineSummary.summary || {};

  // Step 2: draft (web_search 사용)
  const scriptPrompt = `${SCRIPT_PROMPT}${JSON.stringify(summary)}${SCRIPT_PROMPT_OUTLINE}${JSON.stringify(outline)}\n\n강의 제목: ${title}`;
  let draftRaw;
  try {
    draftRaw = useWebSearch
      ? await generateJsonWithWebSearch(client, model, scriptPrompt)
      : await generateJson(client, model, scriptPrompt);
  } catch (error) {
    throw wrapStepError(useWebSearch ? 'draft:web' : 'draft', error);
  }
  const draftScript = stripTimingFields(draftRaw);
  const draftOutput = buildSiblingPath(output, '.draft');
  await fs.promises.writeFile(draftOutput, JSON.stringify(draftScript, null, 2));
  console.log(`Saved draft script to ${draftOutput}`);

  // Step 3: final
  const finalPrompt = `${FINAL_PROMPT}${markdown}\n\n강의 스크립트 초안(JSON):\n${JSON.stringify(draftScript)}\n\n강의 제목: ${title}`;
  let finalRaw;
  try {
    finalRaw = await generateJson(client, model, finalPrompt);
  } catch (error) {
    throw wrapStepError('final', error);
  }
  const finalScript = stripTimingFields(sanitizeForTts(enforceOpeningClosing(finalRaw, title)));

  finalScript.metadata = finalScript.metadata || {};
  finalScript.metadata.title = finalScript.metadata.title || title;
  finalScript.metadata.segmentCount = Array.isArray(finalScript.segments)
    ? finalScript.segments.length
    : 0;

  await fs.promises.writeFile(output, JSON.stringify(finalScript, null, 2));
  console.log(`Saved lecture script to ${output}`);

  return {
    outputPath: output,
    draftPath: draftOutput,
    segments: finalScript.metadata.segmentCount
  };
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
    } else if (token === '--output') {
      args.output = argv[i + 1];
      i += 1;
    } else if (token === '--title') {
      args.title = argv[i + 1];
      i += 1;
    } else if (token === '--no-web') {
      args.useWebSearch = false;
    }
  }

  return args;
}

function printUsage() {
  console.log('Usage: node scripts/lecture-script.js --input ./output/ocr/document.md');
  console.log('Options:');
  console.log('  --output ./output/scripts/lecture-script.json');
  console.log('  --title "강의 제목"');
  console.log('  --no-web (disable web search augmentation)');
}

if (process.argv[1] && process.argv[1].endsWith('lecture-script.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  convertMarkdownToLectureScript(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
