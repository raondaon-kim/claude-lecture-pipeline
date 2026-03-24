import fs from 'fs/promises';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

/**
 * Ensure a directory exists.
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Check if a file exists.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Build image filenames from a scenes.json payload.
 * @param {string} scenesPath
 * @param {string} style
 * @returns {Promise<string[]>}
 */
async function listImagesFromScenes(scenesPath, style) {
  try {
    const raw = await fs.readFile(scenesPath, 'utf-8');
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload?.scenes)) {
      return [];
    }
    return payload.scenes.map((scene) => {
      const id = String(scene.id || 0).padStart(3, '0');
      return `scene_${id}_${style}.png`;
    });
  } catch (error) {
    return [];
  }
}

/**
 * Build image filenames from a manifest.json payload.
 * @param {string} manifestPath
 * @returns {Promise<string[]>}
 */
async function listImagesFromManifest(manifestPath) {
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload?.images)) {
      return [];
    }
    return payload.images
      .map((item) => item?.filename)
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

/**
 * List PNG/JPG files in a directory.
 * @param {string} imagesDir
 * @returns {Promise<string[]>}
 */
async function listImagesFromDir(imagesDir) {
  try {
    const entries = await fs.readdir(imagesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    return [];
  }
}

/**
 * Detect image type from file header.
 * @param {Buffer} buffer
 * @returns {'png' | 'jpg' | 'webp' | 'unknown'}
 */
function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) {
    return 'unknown';
  }
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return 'png';
  }
  // JPEG signature: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg';
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }
  return 'unknown';
}

/**
 * Create a PDF from image files.
 * @param {object} options
 * @param {string} options.imagesDir
 * @param {string} options.manifestPath
 * @param {string} options.scenesPath
 * @param {string} options.style
 * @param {string} options.outputPath
 * @returns {Promise<{outputPath: string, pages: number}>}
 */
export async function imagesToPdf(options) {
  const {
    imagesDir,
    manifestPath,
    scenesPath,
    style = 'presentation',
    outputPath
  } = options;

  if (!imagesDir || !outputPath) {
    throw new Error('imagesDir and outputPath are required.');
  }

  const candidates = [];
  if (manifestPath && await pathExists(manifestPath)) {
    candidates.push(...await listImagesFromManifest(manifestPath));
  }
  if (candidates.length === 0 && scenesPath && await pathExists(scenesPath)) {
    candidates.push(...await listImagesFromScenes(scenesPath, style));
  }
  if (candidates.length === 0) {
    candidates.push(...await listImagesFromDir(imagesDir));
  }

  const files = [];
  for (const name of candidates) {
    const filePath = path.join(imagesDir, name);
    if (await pathExists(filePath)) {
      files.push(filePath);
    }
  }

  if (files.length === 0) {
    throw new Error('No images found to build PDF.');
  }

  const pdfDoc = await PDFDocument.create();
  for (const filePath of files) {
    const buffer = await fs.readFile(filePath);
    const detected = detectImageType(buffer);
    let image;
    if (detected === 'png') {
      image = await pdfDoc.embedPng(buffer);
    } else if (detected === 'jpg') {
      image = await pdfDoc.embedJpg(buffer);
    } else if (detected === 'webp') {
      throw new Error(`Unsupported image format (webp) for ${path.basename(filePath)}. Export PNG/JPG before building PDF.`);
    } else {
      throw new Error(`Unsupported image format for ${path.basename(filePath)}.`);
    }
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }

  await ensureDir(path.dirname(outputPath));
  const pdfBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, pdfBytes);

  return { outputPath, pages: files.length };
}
