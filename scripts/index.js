import fs from 'fs';
import { transcribeAudio } from './transcribe.js';
import { validateSubtitles } from './validate.js';
import { analyzeScenes } from './analyze.js';
import { generateImages } from './generate-images.js';
import { composeVideo } from './compose-video.js';
import { imagesToPdf } from './images-to-pdf.js';

const DEFAULT_STYLE = 'presentation';
const RAW_SUBTITLES = './output/subtitles/raw.json';
const VALIDATED_SUBTITLES = './output/subtitles/validated.json';
const SCENES_PATH = './output/scenes/scenes.json';
const IMAGES_DIR = './output/images';
const MANIFEST_PATH = './output/images/manifest.json';
const IMAGES_PDF = './output/images/scenes.pdf';
const OUTPUT_VIDEO = './output/videos/output.mp4';

/**
 * Print basic usage for the pipeline.
 * @returns {void}
 */
function printUsage() {
  console.log('Usage: node src/index.js --input ./input/lecture.mp3 --style presentation');
  console.log('Options:');
  console.log('  --output ./output/videos/output.mp4');
  console.log('  --no-subtitles');
  console.log('  --chunk-duration 600');
  console.log('  --batch-size 10');
  console.log('  --style presentation|documentary');
  console.log('  --validate');
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {{input?: string, output?: string, style?: string, includeSubtitles?: boolean, chunkDurationSec?: number, batchSize?: number, validate?: boolean, help?: boolean}}
 */
function parseArgs(argv) {
  const args = { includeSubtitles: true, validate: false };

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
    } else if (token === '--style') {
      args.style = argv[i + 1];
      i += 1;
    } else if (token === '--no-subtitles') {
      args.includeSubtitles = false;
    } else if (token === '--chunk-duration') {
      args.chunkDurationSec = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--batch-size') {
      args.batchSize = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--validate') {
      args.validate = true;
    }
  }

  return args;
}

/**
 * Run the full pipeline.
 * @param {{input: string, output?: string, style?: string, includeSubtitles?: boolean, chunkDurationSec?: number, batchSize?: number}} options
 * @returns {Promise<void>}
 */
async function runPipeline(options) {
  const {
    input,
    output = OUTPUT_VIDEO,
    style = DEFAULT_STYLE,
    includeSubtitles = true,
    chunkDurationSec,
    batchSize,
    validate = false
  } = options;

  console.log('Step 1/5: Transcribing audio...');
  await transcribeAudio({
    input,
    output: RAW_SUBTITLES,
    chunkDurationSec
  });

  if (validate) {
    console.log('Step 2/5: Validating subtitles...');
    await validateSubtitles({
      input: RAW_SUBTITLES,
      output: VALIDATED_SUBTITLES,
      batchSize
    });
  } else {
    console.log('Step 2/5: Skipping subtitle validation...');
    await fs.promises.copyFile(RAW_SUBTITLES, VALIDATED_SUBTITLES);
  }

  console.log('Step 3/5: Analyzing scenes...');
  await analyzeScenes({
    input: VALIDATED_SUBTITLES,
    output: SCENES_PATH,
    style,
    chunkDurationSec
  });

  console.log('Step 4/5: Generating images...');
  await generateImages({
    input: SCENES_PATH,
    outputDir: IMAGES_DIR,
    manifestPath: MANIFEST_PATH,
    style
  });
  await imagesToPdf({
    imagesDir: IMAGES_DIR,
    manifestPath: MANIFEST_PATH,
    scenesPath: SCENES_PATH,
    style,
    outputPath: IMAGES_PDF
  });

  console.log('Step 5/5: Composing video...');
  await composeVideo({
    audioPath: input,
    scenesPath: SCENES_PATH,
    subtitlesPath: VALIDATED_SUBTITLES,
    outputPath: output,
    imagesDir: IMAGES_DIR,
    style,
    includeSubtitles
  });
}

/**
 * Entry point.
 * @returns {void}
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  runPipeline(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

main();
