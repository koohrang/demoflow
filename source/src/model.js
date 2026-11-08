// Demo and step shapes. Positions are fractions (0..1) of the screenshot so
// everything scales with the stage.
import { uid } from './db.js';

export const DEFAULT_THEME = {
  accent: '#4F46E5',     // buttons, progress, links
  hotspot: '#FFB21A',    // beacon colour
  tooltipBg: '#FFFFFF',
  tooltipText: '#1D2433',
  radius: 12,
  font: '',              // '' = Inter/system
};

// Ready-made looks for the Branding section.
export const THEMES = [
  { name: 'Indigo', accent: '#4F46E5', hotspot: '#FFB21A', tooltipBg: '#FFFFFF', tooltipText: '#1D2433', radius: 12 },
  { name: 'Ocean', accent: '#0E7AE6', hotspot: '#22D3EE', tooltipBg: '#FFFFFF', tooltipText: '#0B2540', radius: 14 },
  { name: 'Forest', accent: '#15803D', hotspot: '#F59E0B', tooltipBg: '#FBFDF8', tooltipText: '#14261A', radius: 10 },
  { name: 'Sunset', accent: '#E8590C', hotspot: '#7C3AED', tooltipBg: '#FFFBF7', tooltipText: '#2A1608', radius: 16 },
  { name: 'Rose', accent: '#DB2777', hotspot: '#0EA5E9', tooltipBg: '#FFFFFF', tooltipText: '#2B1020', radius: 18 },
  { name: 'Midnight', accent: '#818CF8', hotspot: '#FBBF24', tooltipBg: '#141A2E', tooltipText: '#EEF1FA', radius: 12 },
  { name: 'Mono', accent: '#111827', hotspot: '#EF4444', tooltipBg: '#FFFFFF', tooltipText: '#111827', radius: 6 },
];

export const FONTS = [
  { name: 'Inter (default)', value: '' },
  { name: 'System', value: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { name: 'Rounded', value: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif' },
  { name: 'Serif', value: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif' },
  { name: 'Humanist', value: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif' },
  { name: 'Mono', value: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace' },
];

export const ANNO_COLORS = ['#E5484D', '#FFB21A', '#4F46E5', '#12A150', '#111827'];

export function newDemo(props = {}) {
  const now = Date.now();
  return {
    id: uid('d_'),
    title: 'Untitled demo',
    createdAt: now,
    updatedAt: now,
    sourceUrl: '',
    steps: [],
    theme: { ...DEFAULT_THEME },
    settings: {
      showProgress: true,
      showStepCount: true,
      showBack: true,
      voice: 'off',          // off | browser | audio
      autoAdvance: false,    // advance automatically after the voiceover ends
      endScreen: { enabled: true, title: 'That’s the tour', text: 'Want to see it with your own data?', ctaLabel: 'Book a demo', ctaUrl: '', showRestart: true },
    },
    published: null,         // { url, siteId, at }
    brand: { logoId: null, position: 'tl', name: '' },
    music: null,             // { audioId, name, volume }
    gate: { enabled: false, title: '', text: 'Enter your email to watch the demo.', askName: false, askCompany: false, button: 'Start the demo', webhook: '', privacy: '' },
    ...props,
  };
}

export function newScreenStep(props = {}) {
  return {
    id: uid('s_'),
    type: 'screen',
    imageId: null,
    imgW: 1280,
    imgH: 800,
    pageUrl: '',
    pageTitle: '',
    action: 'click',         // click | type | upload
    play: 'click',           // click: wait for the viewer | auto: video only, plays by itself
    hold: 0.8,               // auto: seconds the screenshot shows before its movement plays
    caption: false,          // auto: show the tooltip text as a caption
    element: null,           // { tag, text, label, role, kind }
    typed: '',
    hotspot: { x: 0.5, y: 0.5, style: 'beacon' },   // beacon | spotlight | none
    highlight: null,         // { x, y, w, h } element box, used by spotlight
    tooltip: { text: '', placement: 'auto' },        // auto | top | bottom | left | right
    next: { type: 'next' },  // what clicking the hotspot does: next | step | url | end
    buttons: [],             // [{ id, label, style: primary|secondary, action: {type, stepId, url} }]
    blurs: [],               // [{ id, x, y, w, h }]
    annotations: [],         // [{ id, kind: box|arrow|label, color, x, y, w, h | x1, y1, x2, y2 | text }]
    zoom: null,              // { scale } zooms in on the hotspot
    voice: { text: '', sameAsTooltip: true, audioId: null, audioText: '' },
    ...props,
  };
}

// A recorded screen video that plays inside the demo.
export function newVideoStep(props = {}) {
  return {
    id: uid('s_'),
    type: 'video',
    videoId: null,
    imageId: null,           // poster frame
    imgW: 1280,
    imgH: 800,
    dur: 0,
    autoNext: true,
    tooltip: { text: '', placement: 'auto' },
    next: { type: 'next' },
    buttons: [],
    voice: { text: '', sameAsTooltip: true, audioId: null, audioText: '' },
    ...props,
  };
}

export function newChapterStep(props = {}) {
  return {
    id: uid('s_'),
    type: 'chapter',
    title: 'What would you like to see?',
    text: 'Pick a path and we’ll walk you through it.',
    buttons: [
      { id: uid('b_'), label: 'Start the tour', style: 'primary', action: { type: 'next' } },
    ],
    voice: { text: '', sameAsTooltip: true, audioId: null, audioText: '' },
    ...props,
  };
}

// Opening and closing cards: section cards with a role, pinned to the ends of a demo.
export function newOpeningCard(demo, { auto = false } = {}) {
  return newChapterStep({
    role: 'opening',
    title: (demo && demo.title) || 'Welcome',
    titleLinked: true,        // follows the demo title until edited
    text: auto ? 'A short walkthrough of how it works.' : 'A quick interactive tour. Click through at your own pace.',
    buttons: [{ id: uid('b_'), label: auto ? 'Watch the walkthrough' : 'Start the tour', style: 'primary', action: { type: 'next' } }],
  });
}

export function newClosingCard(end = {}) {
  const buttons = [{ id: uid('b_'), label: end.ctaLabel || 'Get started', style: 'primary', action: { type: 'url', url: end.ctaUrl || '' } }];
  if (end.showRestart !== false) buttons.push({ id: uid('b_'), label: 'Watch again', style: 'secondary', action: { type: 'restart' } });
  return newChapterStep({
    role: 'closing',
    title: end.title || 'That’s the tour',
    text: end.text != null && end.text !== '' ? end.text : 'Ready to try it yourself?',
    buttons,
  });
}

// Give a demo its opening and closing cards (once; deleting them is respected).
export function addCards(demo, { auto } = {}) {
  if (demo.cardsInit) return demo;
  demo.settings = demo.settings || {};
  const end = demo.settings.endScreen || {};
  if (auto == null) auto = demo.steps.some((x) => x.play === 'auto');
  if (!demo.steps.some((x) => x.role === 'opening')) demo.steps.unshift(newOpeningCard(demo, { auto }));
  if (!demo.steps.some((x) => x.role === 'closing')) demo.steps.push(newClosingCard(end.enabled === false ? {} : end));
  demo.settings.endScreen = { ...end, enabled: false };
  demo.cardsInit = true;
  return demo;
}

export function newButton(props = {}) {
  return { id: uid('b_'), label: 'Learn more', style: 'secondary', action: { type: 'next' }, ...props };
}

// A readable instruction for a recorded step without any AI.
export function describeStep(step) {
  if (step.type === 'chapter') return step.title || '';
  const el = step.element || {};
  const name = cleanName(el.label || el.text || '');
  if (step.action === 'type') {
    const field = name ? `the ${quote(name)} field` : 'this field';
    return step.typed ? `Type ${quote(step.typed)} in ${field}.` : `Fill in ${field}.`;
  }
  if (!name) return 'Click here to continue.';
  const kind = el.kind || '';
  if (kind === 'link') return `Open ${quote(name)}.`;
  if (kind === 'checkbox') return `Tick ${quote(name)}.`;
  if (kind === 'tab') return `Switch to the ${quote(name)} tab.`;
  if (kind === 'menuitem' || kind === 'option') return `Choose ${quote(name)}.`;
  if (kind === 'input') return `Click the ${quote(name)} field.`;
  return `Click ${quote(name)}.`;
}

function cleanName(s) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > 48 ? s.slice(0, 45).trim() + '…' : s;
}
function quote(s) { return `“${s}”`; }

export function stepVoiceText(step) {
  if (step.type === 'video' && (!step.voice || step.voice.sameAsTooltip !== false)) return (step.tooltip && step.tooltip.text || '').replace(/\*\*/g, '').trim();
  const v = step.voice || {};
  if (v.sameAsTooltip === false) return (v.text || '').trim();
  if (step.type === 'chapter') return [step.title, step.text].filter(Boolean).join('. ');
  return (step.tooltip && step.tooltip.text || '').trim();
}

export function screenSteps(demo) { return demo.steps.filter((s) => s.type === 'screen'); }

// Seconds of movement a step actually plays (after trimming).
export function motionLength(step) {
  const m = step && step.motion;
  if (!m) return 0;
  const start = +m.start || 0;
  const end = m.end != null && +m.end > start ? +m.end : (+m.dur || 0);
  return Math.max(0, end - start);
}
