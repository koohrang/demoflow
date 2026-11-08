import { db } from './db.js';

export const DEFAULT_SETTINGS = {
  ai: {
    provider: 'none',            // none | anthropic | openai
    anthropicKey: '',
    anthropicModel: 'claude-haiku-5-5',
    openaiKey: '',
    openaiModel: 'gpt-5-mini',
    openaiBase: 'https://api.openai.com/v1',
    tone: 'friendly',            // friendly | concise | formal
    language: 'English',
  },
  tts: {
    provider: 'none',            // none | openai | elevenlabs
    openaiKey: '',               // falls back to ai.openaiKey
    openaiModel: 'gpt-4o-mini-tts',
    openaiVoice: 'alloy',
    elevenKey: '',
    elevenVoice: '21m00Tcm4TlvDq8ikWAM',
    elevenModel: 'eleven_multilingual_v2',
  },
  updates: {
    auto: true,                  // check once a day when Demoflow opens
    feed: '',                    // '' = the address this copy was built with
    lastCheck: 0,
  },
  publish: {
    netlifyToken: '',
    sites: {},                   // demoId -> { siteId, url }
  },
};

// Settings and keys stay in this browser (localStorage for this file's origin).
const KEY = 'trailmark.settings';
export async function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { s = {}; }
  return {
    ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) },
    tts: { ...DEFAULT_SETTINGS.tts, ...(s.tts || {}) },
    updates: { ...DEFAULT_SETTINGS.updates, ...(s.updates || {}) },
    publish: { ...DEFAULT_SETTINGS.publish, ...(s.publish || {}), sites: { ...((s.publish && s.publish.sites) || {}) } },
  };
}
export async function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event('trailmark-settings'));
}

// Object URLs for stored blobs, cached for the life of the page.
const urlCache = new Map();
export async function blobUrl(id) {
  if (!id) return '';
  if (urlCache.has(id)) return urlCache.get(id);
  const blob = await db.getBlob(id);
  if (!blob) return '';
  const u = URL.createObjectURL(blob);
  urlCache.set(id, u);
  return u;
}
export function forgetBlobUrl(id) {
  const u = urlCache.get(id);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
}
