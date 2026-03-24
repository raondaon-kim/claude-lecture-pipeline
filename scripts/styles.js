/**
 * Style profile registry for image generation.
 *
 * Each profile defines visual rules (colors, layout, typography, icons,
 * background) that are injected into both the scene-analysis prompts and the
 * image-generation prompts so every slide in a lecture video has a consistent
 * look-and-feel.
 */

const STYLE_PROFILES = {
  retro: {
    label: '레트로',
    colorPalette: ['#8C181B', '#D1A139', '#2E4154', '#F2E8CF', '#000000'],
    koreanFont: 'Black Han Sans (Title), Pretendard SemiBold (Body)',
    visualDensity: 'high',
    layout: 'Asymmetric dynamic layering with strong diagonal movement and overlapping geometric blocks',
    iconStyle: 'Retro-constructivist vector art with sharp jagged edges and high-contrast silhouettes',
    typography: 'Heavyweight blocky sans-serif for titles; condensed geometric sans-serif for subtitles',
    backgroundStyle: 'Aged parchment base with warm cream tone, heavy weathered textures'
  },
  whiteboard: {
    label: '화이트보드',
    colorPalette: ['#0056b3', '#d62828', '#f9c74f', '#2b2d42', '#f8f9fa'],
    koreanFont: 'Nanum Pen Script (Title), Pretendard (Body)',
    visualDensity: 'medium',
    layout: 'Asymmetric dynamic flow with organic focal points and directional paths',
    iconStyle: 'Analog-stroke sketch style with varying line weights and hand-drawn imperfections',
    typography: 'Expressive humanist script for titles; casual monolinear sans-serif for body',
    backgroundStyle: 'Neutral high-brightness matte surface with fine grain texture'
  },
  fairytale: {
    label: '동화',
    colorPalette: ['#FDF5E6', '#D9C5B2', '#B8D8BA', '#E2B4BD', '#FFF4AF'],
    koreanFont: 'Kyobo Handwriting (Title), Pretendard (Body)',
    visualDensity: 'high',
    layout: 'Asymmetric framing with center-focused negative space and vignette effect',
    iconStyle: 'Soft-edged storybook aesthetic with watercolor-inspired fills and ethereal glow',
    typography: 'Whimsical decorative serif for titles; clean condensed sans-serif for subtitles',
    backgroundStyle: 'Warm cream base with parchment grain and watercolor washes'
  },
  watercolor: {
    label: '수채화',
    colorPalette: ['#F2EFE6', '#4A5D4E', '#C58F4E', '#7D4C44', '#4F5D6B'],
    koreanFont: 'Nanum Pen Script (Title), Pretendard (Body)',
    visualDensity: 'high',
    layout: 'Vertical-stack symmetry with central focal anchor',
    iconStyle: 'Textured digital gouache with visible brush-stroke shading and soft organic edges',
    typography: 'Expressive organic brush-script for titles; clean geometric sans-serif for body',
    backgroundStyle: 'Warm parchment base with canvas grain and watercolor-style washes'
  },
  atelier: {
    label: '아뜰리에',
    colorPalette: ['#A66348', '#E8D5B7', '#7A8464', '#D27C4E', '#4A3728'],
    koreanFont: 'Nanum Square Round (Title), Pretendard (Body)',
    visualDensity: 'high',
    layout: 'Immersive multi-layered depth with top-weighted horizontal focus and scene-based structure',
    iconStyle: 'Digital watercolor and painterly illustration with soft textured edges',
    typography: 'Friendly bold display sans-serif with rounded terminals for titles; light humanist sans-serif for body',
    backgroundStyle: 'Warm earthy matte gradients with watercolor paper grain texture'
  },
  popup: {
    label: '팝업북',
    colorPalette: ['#2A8D91', '#F9F7F2', '#FFB2A7', '#FCD86C', '#E55B4D'],
    koreanFont: 'Pretendard or NanumSquareRound',
    visualDensity: 'high',
    layout: 'Centered multi-layered stage with floating dimensional cards and tiered depth planes',
    iconStyle: '3D paper-cut aesthetic with flat vector shapes and soft drop shadows',
    typography: 'Modern rounded sans-serif with high weight contrast',
    backgroundStyle: 'Soft bi-tone gradients with fibrous paper grain texture'
  },
  cartoon: {
    label: '카툰',
    colorPalette: ['#FFF9E5', '#FF6B6B', '#4ECDC4', '#FFD93D', '#4A4A4A'],
    koreanFont: 'NanumSquare Round',
    visualDensity: 'high',
    layout: 'Dynamic storytelling layout using organic winding paths and floating nested containers',
    iconStyle: 'Playful vector-line art with thick dark outlines and soft internal gradients',
    typography: 'Bold rounded geometric sans-serif for headings; clean legible sans-serif for body',
    backgroundStyle: 'Warm matte cream base with fine-grained tactile texture'
  },
  magazine: {
    label: '매거진',
    colorPalette: ['#F7F3F0', '#333333', '#8C735B', '#D9D1C7', '#A6998A'],
    koreanFont: 'Nanum Myeongjo (Title), Pretendard (Body)',
    visualDensity: 'medium',
    layout: 'Asymmetric split-screen composition with modular grid sub-sections',
    iconStyle: 'Minimalist fine-line art or elegant serif-based glyphs',
    typography: 'Editorial high-contrast serif for headlines; clean geometric sans-serif for body',
    backgroundStyle: 'Solid warm matte cream with occasional ghosted typographic characters'
  },
  modern: {
    label: '모던',
    colorPalette: ['#F7F0E6', '#4A4A4A', '#D99E49', '#93B1C2', '#FFFFFF'],
    koreanFont: 'Pretendard or Spoqa Han Sans',
    visualDensity: 'medium',
    layout: 'Asymmetric split with horizontal header-body division and modular floating cards',
    iconStyle: 'Minimalist line art pictograms in solid circular containers',
    typography: 'Modern humanist sans-serif with bold high-weight headers',
    backgroundStyle: 'Flat solid warm cream, matte finish, zero-texture'
  },
  report: {
    label: '리포트',
    colorPalette: ['#3474B4', '#87B6ED', '#E6F0FF', '#333333', '#FFFFFF'],
    koreanFont: 'Nanum Myeongjo (Title), Pretendard (Body)',
    visualDensity: 'low',
    layout: 'Asymmetric vertical split with text-heavy left column and right-aligned visual data area',
    iconStyle: 'Functional data-centric clean vector charts and realistic photography',
    typography: 'Bold authoritative serif for headings; clean sans-serif for body and data labels',
    backgroundStyle: 'Clean minimalist solid white, no texture'
  },
  minimal: {
    label: '미니멀',
    colorPalette: ['#78A7D1', '#B9D4E7', '#F0F4F7', '#2C2C2C'],
    koreanFont: 'Nanum Myeongjo (Title), Pretendard (Body)',
    visualDensity: 'low',
    layout: 'Asymmetric split with generous negative space and centered focal points',
    iconStyle: 'Minimalist flat vector symbols with high-contrast dark fill',
    typography: 'Elegant high-contrast Serif for headings; refined Serif for body',
    backgroundStyle: 'Soft airy horizontal gradient (muted sky blue to off-white) with subtle linen grain'
  },
  sketch: {
    label: '스케치',
    colorPalette: ['#F1E6D2', '#D38B5D', '#4A413C', '#B8A591', '#F9F3E8'],
    koreanFont: 'Kyobo Handwriting (Title), Pretendard (Body)',
    visualDensity: 'high',
    layout: 'Narrative horizontal progression with central focal axis',
    iconStyle: 'Analog-sketch aesthetic with rough graphite-like outlines and grain fills',
    typography: 'Expressive organic handwritten titles; clean rounded sans-serif subtext',
    backgroundStyle: 'Warm aged parchment with paper grain and slightly distressed edges'
  },
  'fairytale-illust': {
    label: '동화 일러스트',
    colorPalette: ['#F5A623', '#F7D794', '#FFE8B0', '#E8845C', '#FFF5E6'],
    koreanFont: 'Cafe24 Ssurround (Title), Pretendard Regular (Body)',
    visualDensity: 'medium',
    layout: 'Full-bleed storybook illustration where the entire slide is a warm, painterly scene. Text is overlaid sparingly at the top or center.',
    iconStyle: 'MANDATORY children\'s picture-book illustration style: all visual elements MUST be drawn as soft, rounded, hand-painted illustrations with visible brush-stroke texture, warm color blending, and slightly imperfect organic edges. NO photorealistic rendering, NO 3D rendering, NO flat vector art.',
    typography: 'Soft, rounded sans-serif in warm amber or brown tones with a subtle hand-lettered quality',
    backgroundStyle: 'Warm golden-hour gradient sky transitioning from pale cream at the top to soft peach-amber at the horizon. Nature environments with softly rendered wildflowers and tall grass.',
    decorativeElements: 'Gently curving decorative swirl lines in warm gold/amber tones; scattered falling leaves; tiny floating light particles and soft circular bokeh dots',
    slideComposition: 'Immersive storybook scene with atmospheric perspective. Focal subject placed in lower-center or along rule-of-thirds.'
  },
  // 하위 호환: 기존 presentation/documentary를 modern/minimal에 매핑
  presentation: {
    label: '강의 슬라이드형',
    colorPalette: ['#F7F0E6', '#4A4A4A', '#D99E49', '#93B1C2', '#FFFFFF'],
    koreanFont: 'Pretendard or Spoqa Han Sans',
    visualDensity: 'medium',
    layout: 'Asymmetric split with horizontal header-body division and modular floating cards',
    iconStyle: 'Minimalist line art pictograms in solid circular containers',
    typography: 'Modern humanist sans-serif with bold high-weight headers',
    backgroundStyle: 'Flat solid warm cream, matte finish, zero-texture'
  },
  documentary: {
    label: '인포그래픽형',
    colorPalette: ['#3474B4', '#87B6ED', '#E6F0FF', '#333333', '#FFFFFF'],
    koreanFont: 'Nanum Myeongjo (Title), Pretendard (Body)',
    visualDensity: 'low',
    layout: 'Asymmetric vertical split with text-heavy left column and right-aligned visual data area',
    iconStyle: 'Functional data-centric clean vector charts and realistic photography',
    typography: 'Bold authoritative serif for headings; clean sans-serif for body and data labels',
    backgroundStyle: 'Clean minimalist solid white, no texture'
  }
};

/**
 * Get a style profile by name.
 * @param {string} name
 * @returns {object | null}
 */
export function getStyleProfile(name) {
  return STYLE_PROFILES[name] || null;
}

/**
 * List all available style names.
 * @returns {string[]}
 */
export function listStyles() {
  return Object.keys(STYLE_PROFILES);
}

/**
 * List styles with labels (for display).
 * @returns {{name: string, label: string}[]}
 */
export function listStylesWithLabels() {
  return Object.entries(STYLE_PROFILES).map(([name, profile]) => ({
    name,
    label: profile.label
  }));
}

/**
 * Build a style-guide string from a profile for injection into prompts.
 * @param {object} profile
 * @returns {string}
 */
export function buildStyleGuidePrompt(profile) {
  if (!profile) return '';

  const parts = [
    `Color palette: ${profile.colorPalette.join(', ')}`,
    `Layout: ${profile.layout}`,
    `Icon/visual style: ${profile.iconStyle}`,
    `Typography: ${profile.typography}. Korean font: ${profile.koreanFont}`,
    `Background: ${profile.backgroundStyle}`,
    `Visual density: ${profile.visualDensity}`
  ];

  if (profile.decorativeElements) {
    parts.push(`Decorative elements: ${profile.decorativeElements}`);
  }
  if (profile.slideComposition) {
    parts.push(`Slide composition: ${profile.slideComposition}`);
  }

  return parts.join('. ');
}

/**
 * Check if a style is a "no-text" style (documentary-like).
 * Documentary and report styles should not include visible text.
 * @param {string} styleName
 * @returns {boolean}
 */
export function isNoTextStyle(styleName) {
  return styleName === 'documentary';
}
