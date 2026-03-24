import fs from 'fs/promises';
import path from 'path';
import { toBlobURL } from '@ffmpeg/util';

const DEFAULT_CORE_VERSION = '0.11.6';
const DEFAULT_CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${DEFAULT_CORE_VERSION}/dist/esm`;

/**
 * Convert a buffer into a data URL.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {string}
 */
function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
}

/**
 * Resolve ffmpeg core URLs from local files.
 * @param {string} coreDir
 * @returns {Promise<{coreURL: string, wasmURL: string}>}
 */
async function resolveLocalCoreUrls(coreDir) {
  const jsPath = path.resolve(coreDir, 'ffmpeg-core.js');
  const wasmPath = path.resolve(coreDir, 'ffmpeg-core.wasm');

  try {
    const [jsData, wasmData] = await Promise.all([
      fs.readFile(jsPath),
      fs.readFile(wasmPath)
    ]);

    return {
      coreURL: bufferToDataUrl(jsData, 'text/javascript'),
      wasmURL: bufferToDataUrl(wasmData, 'application/wasm')
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load local ffmpeg core from ${coreDir}: ${message}`);
  }
}

/**
 * Resolve ffmpeg core URLs (local dir via FFMPEG_CORE_DIR or remote URL).
 * @param {{coreDir?: string, baseURL?: string}} options
 * @returns {Promise<{coreURL: string, wasmURL: string}>}
 */
export async function resolveFfmpegCoreUrls(options = {}) {
  const coreDir = options.coreDir || process.env.FFMPEG_CORE_DIR;
  if (coreDir) {
    return resolveLocalCoreUrls(coreDir);
  }

  const baseURL = options.baseURL || process.env.FFMPEG_CORE_URL || DEFAULT_CORE_BASE_URL;
  return {
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
  };
}
