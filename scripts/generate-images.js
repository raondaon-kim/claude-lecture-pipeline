import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import { loadConfig } from './config.js';
import { runWithConcurrency, delay } from './concurrency.js';
import { getStyleProfile, buildStyleGuidePrompt, isNoTextStyle } from './styles.js';

const DEFAULT_STYLE = 'presentation';
const DEFAULT_OUTPUT_DIR = './output/images';
const DEFAULT_MANIFEST = './output/images/manifest.json';

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
 * Build filename for a scene image.
 * @param {number} sceneId
 * @param {string} style
 * @returns {string}
 */
function buildFilename(sceneId, style) {
  return `scene_${String(sceneId).padStart(3, '0')}_${style}.png`;
}

/**
 * Enhance prompt for the given style.
 * @param {string} prompt
 * @param {string} style
 * @returns {string}
 */
function buildGuidePrefix(guides) {
  const parts = [];
  if (guides.styleGuide) {
    parts.push(`Apply this style guide consistently: ${guides.styleGuide}`);
  }
  if (guides.characterGuide) {
    parts.push(`Use this character reference consistently across all scenes: ${guides.characterGuide}`);
  }
  parts.push('Typography: use one consistent Korean font family across all slides, matching the style guide.');
  parts.push('Font names and style-guide text are for instruction only; never render font names or guide text as visible text.');
  return parts.join(' ');
}

function enhancePrompt(prompt, style, guides = {}, hasAvatar = false) {
  const base = 'high quality, professional, 16:9 aspect ratio, 1920x1080 resolution';

  // 스타일 프로필에서 가이드 생성
  const profile = getStyleProfile(style);
  const profileGuide = buildStyleGuidePrompt(profile);
  const mergedGuides = {
    ...guides,
    styleGuide: [profileGuide, guides.styleGuide].filter(Boolean).join('. ')
  };

  const guidePrefix = buildGuidePrefix(mergedGuides);
  const promptBody = guidePrefix ? `${guidePrefix} ${prompt}` : prompt;
  const avatarHint = hasAvatar
    ? 'IMPORTANT: Keep the bottom-right area (roughly 30% width, 40% height from the bottom-right corner) empty or use only simple background. Do not place any important text, key visuals, diagrams, or main subjects in that region. '
    : '';

  const noText = isNoTextStyle(style);
  if (noText) {
    return `${avatarHint}${promptBody}, ${base}, cinematic quality, photorealistic, no text, no typography, no captions, no subtitles, avoid any written language, no watermark, no credits, no author names, no logos`;
  }
  return `${avatarHint}${promptBody}, ${base}, clean design, suitable for educational presentation, large and legible Korean title with rich supporting text, if supporting text is small use English, keep all text readable, avoid tiny unreadable text, do not display font names or typography labels, Korean text must render like print-quality fonts with no jamo separation, no distortion, no meaning changes, no watermark, no credits, no author names, no logos`;
}

/**
 * Extract image inline data from Gemini response.
 * @param {any} response
 * @returns {{data: string, mimeType: string} | null}
 */
function extractImageData(response) {
  const candidates = response?.candidates || response?.response?.candidates;
  const parts = candidates?.[0]?.content?.parts || [];
  const match = parts.find((part) => part.inlineData?.mimeType?.startsWith('image/'));
  if (!match) {
    return null;
  }

  return {
    data: match.inlineData.data,
    mimeType: match.inlineData.mimeType
  };
}

/**
 * Generate a single image for a scene.
 * @param {any} model
 * @param {string} prompt
 * @param {number} sceneId
 * @param {string} style
 * @param {string} outputDir
 * @returns {Promise<{sceneId: number, filename: string, path: string, prompt: string, resolution: string, status: string, error?: string}>}
 */
async function generateImage(client, prompt, sceneId, style, outputDir, guides, hasAvatar) {
  const enhancedPrompt = enhancePrompt(prompt, style, guides, hasAvatar);
  const filename = buildFilename(sceneId, style);
  const filepath = path.join(outputDir, filename);

  try {
    const response = await client.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: enhancedPrompt,
      config: {
        imageConfig: {
          aspectRatio: '16:9',
          imageSize: '2K'
        }
      }
    });
    const imageData = extractImageData(response);
    if (!imageData?.data) {
      throw new Error('No image generated');
    }

    // 2K → 1920x1080 resize with sharp
    const rawBuffer = Buffer.from(imageData.data, 'base64');
    const resizedBuffer = await sharp(rawBuffer)
      .resize(1920, 1080, { fit: 'cover' })
      .png()
      .toBuffer();
    await fs.promises.writeFile(filepath, resizedBuffer);

    return {
      sceneId,
      filename,
      path: filepath,
      prompt: enhancedPrompt,
      resolution: '1920x1080',
      status: 'success'
    };
  } catch (error) {
    console.error(`Scene ${sceneId} generation failed: ${error.message}`);
    return {
      sceneId,
      filename,
      path: filepath,
      prompt: enhancedPrompt,
      resolution: '1920x1080',
      status: 'failed',
      error: error.message
    };
  }
}

/**
 * Generate a single image with a provided prompt.
 * @param {{prompt: string, sceneId: number, style: string, outputDir: string, styleGuide?: string, characterGuide?: string}} options
 * @returns {Promise<{sceneId: number, filename: string, path: string, prompt: string, resolution: string, status: string, error?: string}>}
 */
export async function generateSingleImage(options) {
  const {
    prompt,
    sceneId,
    style,
    outputDir,
    styleGuide,
    characterGuide
  } = options;

  if (!prompt) {
    throw new Error('Prompt is required.');
  }
  if (!Number.isFinite(sceneId)) {
    throw new Error('sceneId is required.');
  }
  if (!style || !outputDir) {
    throw new Error('style and outputDir are required.');
  }

  await ensureDir(outputDir);
  const { googleApiKey } = loadConfig();
  const client = new GoogleGenAI({ apiKey: googleApiKey });
  const guides = { styleGuide, characterGuide };
  return generateImage(client, prompt, sceneId, style, outputDir, guides);
}

/**
 * Generate an image with retries.
 * @param {any} model
 * @param {object} scene
 * @param {string} style
 * @param {string} outputDir
 * @param {number} maxRetries
 * @returns {Promise<object>}
 */
async function generateWithRetry(client, scene, style, outputDir, maxRetries, guides, hasAvatar) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      let prompt = scene.prompts?.[style]?.prompt;
      if (!prompt && typeof scene.prompt === 'string') {
        prompt = scene.prompt;
      }
      if (!prompt) {
        const fallbackStyle = style === 'presentation' ? 'documentary' : 'presentation';
        prompt = scene.prompts?.[fallbackStyle]?.prompt;
        if (prompt) {
          console.warn(`Scene ${scene.id} missing ${style} prompt. Using ${fallbackStyle} prompt.`);
        }
      }
      if (!prompt) {
        throw new Error(`Missing prompt for style ${style}`);
      }

      const result = await generateImage(client, prompt, scene.id, style, outputDir, guides, hasAvatar);
      if (result.status === 'failed') {
        throw new Error(result.error || 'Image generation failed');
      }
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`Scene ${scene.id} attempt ${attempt} failed, retrying...`);
      await delay(5000 * attempt);
    }
  }

  return {
    sceneId: scene.id,
    status: 'failed',
    error: lastError?.message || 'Unknown error'
  };
}

/**
 * Generate images for all scenes in batches.
 * @param {any} model
 * @param {Array<object>} scenes
 * @param {string} style
 * @param {object} options
 * @returns {Promise<Array<object>>}
 */
async function generateAllImages(client, scenes, style, options = {}) {
  const {
    concurrency = 5,
    retryCount = 3,
    outputDir,
    styleGuide,
    characterGuide,
    avatarSceneIds
  } = options;
  const guides = { styleGuide, characterGuide };

  const results = await runWithConcurrency(scenes, concurrency, async (scene, index) => {
    const hasAvatar = avatarSceneIds?.has(scene.id) || false;
    const result = await generateWithRetry(client, scene, style, outputDir, retryCount, guides, hasAvatar);
    console.log(`Progress: ${index + 1}/${scenes.length}`);
    return result;
  });

  return results;
}

/**
 * Generate images for scenes.
 * @param {{input: string, outputDir?: string, style?: string, concurrency?: number, delayMs?: number, retryCount?: number, manifestPath?: string, styleGuide?: string, characterGuide?: string}} options
 * @returns {Promise<{manifestPath: string, total: number}>}
 */
export async function generateImages(options) {
  const {
    input,
    outputDir = DEFAULT_OUTPUT_DIR,
    style = DEFAULT_STYLE,
    concurrency,
    retryCount,
    manifestPath = DEFAULT_MANIFEST,
    styleGuide,
    characterGuide
  } = options;

  if (!input) {
    throw new Error('Missing required option: input');
  }

  await assertFileExists(input);
  await ensureDir(outputDir);
  await ensureDir(path.dirname(manifestPath));

  const { googleApiKey } = loadConfig();
  const client = new GoogleGenAI({ apiKey: googleApiKey });

  const raw = await fs.promises.readFile(input, 'utf-8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error('Input file is not valid JSON.');
  }

  if (!Array.isArray(payload?.scenes)) {
    throw new Error('Input JSON must contain a scenes array.');
  }

  const avatarSceneIds = new Set(
    (payload.avatarPlan?.points || [])
      .filter((p) => p.sceneId != null)
      .map((p) => p.sceneId)
  );

  const images = await generateAllImages(client, payload.scenes, style, {
    concurrency,
    retryCount,
    outputDir,
    styleGuide,
    characterGuide,
    avatarSceneIds
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    style,
    images
  };

  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Saved image manifest to ${manifestPath}`);

  return { manifestPath, total: images.length };
}

/**
 * Parse CLI arguments for generate-images command.
 * @param {string[]} argv
 * @returns {{input?: string, outputDir?: string, style?: string, concurrency?: number, delayMs?: number, retryCount?: number, manifestPath?: string, help?: boolean}}
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
    } else if (token === '--output-dir') {
      args.outputDir = argv[i + 1];
      i += 1;
    } else if (token === '--style') {
      args.style = argv[i + 1];
      i += 1;
    } else if (token === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--delay-ms') {
      args.delayMs = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--retry-count') {
      args.retryCount = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--manifest') {
      args.manifestPath = argv[i + 1];
      i += 1;
    }
  }

  return args;
}

/**
 * Print usage for generate-images command.
 * @returns {void}
 */
function printUsage() {
  console.log('Usage: node src/generate-images.js --input ./output/scenes/scenes.json --style presentation');
  console.log('Options:');
  console.log('  --output-dir ./output/images');
  console.log('  --manifest ./output/images/manifest.json');
  console.log('  --concurrency 2');
  console.log('  --delay-ms 3000');
  console.log('  --retry-count 3');
}

if (process.argv[1] && process.argv[1].endsWith('generate-images.js')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  generateImages(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
