// AI writing (Anthropic or OpenAI-compatible) and voiceover (OpenAI TTS or ElevenLabs).
// Keys live in this browser and requests go straight from here to the provider.
import { db } from './db.js';
import { annotatedForAI } from './media.js';
import { describeStep } from './model.js';

export function aiReady(s) {
  if (s.ai.provider === 'anthropic') return !!s.ai.anthropicKey;
  if (s.ai.provider === 'openai') return !!s.ai.openaiKey;
  return false;
}
export function ttsReady(s) {
  if (s.tts.provider === 'openai') return !!(s.tts.openaiKey || s.ai.openaiKey);
  if (s.tts.provider === 'elevenlabs') return !!s.tts.elevenKey;
  return false;
}

const TONES = {
  friendly: 'warm and encouraging, like a helpful teammate',
  concise: 'crisp and to the point',
  formal: 'professional and precise',
};

function systemPrompt(s) {
  return [
    'You write the tooltip copy for one step of an interactive, click-through product demo.',
    `Write in ${s.ai.language || 'English'}. Tone: ${TONES[s.ai.tone] || TONES.friendly}.`,
    'Rules:',
    '- One or two short sentences, at most 24 words in total.',
    '- Address the viewer as "you" and tell them what to click or what they are looking at.',
    '- Put the exact on-screen label of the clicked element in **double asterisks** once.',
    '- When the benefit is obvious from the screen, add it in a few words. Never invent features.',
    '- No emojis, no quotation marks around the whole answer, no preamble. Output only the tooltip text.',
  ].join('\n');
}

function host(u) { try { const x = new URL(u); return x.host + x.pathname; } catch { return ''; } }

function stepContext(demo, step, idx) {
  const el = step.element || {};
  const prev = demo.steps[idx - 1];
  const next = demo.steps[idx + 1];
  const lines = [
    `Demo title: ${demo.title || 'Untitled'}`,
    `This is step ${idx + 1} of ${demo.steps.length}.`,
    step.pageTitle ? `Page: ${step.pageTitle} (${host(step.pageUrl)})` : '',
    step.action === 'type'
      ? `The presenter typed ${step.typed ? `"${step.typed}"` : 'text'} into a field labelled "${el.label || 'unlabelled'}" (marked in red).`
      : el.label ? `The presenter clicked a ${el.kind || el.tag || 'element'} labelled "${el.label}" (marked with the red circle).`
        : 'The presenter clicked the spot marked with the red circle.',
    prev && prev.type === 'screen' && prev.tooltip && prev.tooltip.text ? `Previous step's tooltip: ${prev.tooltip.text}` : '',
    next && next.type === 'screen' && next.element && next.element.label ? `The next click will be on "${next.element.label}".` : '',
    step.tooltip && step.tooltip.text && step.tooltip.text !== describeStep(step) ? `Current draft (improve it): ${step.tooltip.text}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

async function readError(res, provider) {
  let detail = '';
  try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.type)) || j.detail?.message || JSON.stringify(j).slice(0, 200); } catch { /* ignore */ }
  if (res.status === 401 || res.status === 403) return new Error(`${provider} rejected the API key (${res.status}). Check it in Settings.`);
  if (res.status === 429) return new Error(`${provider} rate limit or quota reached (429). Try again in a moment.`);
  if (res.status === 404) return new Error(`${provider} couldn’t find that model (404). Check the model name in Settings. ${detail}`);
  return new Error(`${provider} returned ${res.status}. ${detail}`.trim());
}

async function complete(s, { system, text, imageB64, maxWords = 60 }) {
  if (s.ai.provider === 'anthropic') {
    const content = [];
    if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } });
    content.push({ type: 'text', text });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.ai.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: s.ai.anthropicModel, max_tokens: Math.min(8000, Math.max(200, maxWords * 6)), system, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) throw await readError(res, 'Anthropic');
    const j = await res.json();
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  }
  if (s.ai.provider === 'openai') {
    const base = (s.ai.openaiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const content = [{ type: 'text', text }];
    if (imageB64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } });
    const body = { model: s.ai.openaiModel, messages: [{ role: 'system', content: system }, { role: 'user', content }], max_completion_tokens: Math.max(2500, Math.min(16000, maxWords * 8)) };
    let res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.ai.openaiKey}` }, body: JSON.stringify(body),
    });
    if (res.status === 400) {
      // Some OpenAI-compatible servers only know max_tokens.
      const txt = await res.clone().text();
      if (/max_completion_tokens/.test(txt)) {
        delete body.max_completion_tokens; body.max_tokens = Math.min(8000, Math.max(400, maxWords * 6));
        res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.ai.openaiKey}` }, body: JSON.stringify(body) });
      }
    }
    if (!res.ok) throw await readError(res, 'OpenAI');
    const j = await res.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    return String((msg && msg.content) || '').trim();
  }
  throw new Error('Choose an AI provider and add its API key in Settings.');
}

function tidy(t) {
  t = String(t || '').trim().replace(/^["“”']+|["“”']+$/g, '').replace(/^tooltip:\s*/i, '').trim();
  return t;
}

export async function writeStep(s, demo, idx) {
  const step = demo.steps[idx];
  if (step.type === 'chapter') return writeChapter(s, demo, idx);
  const blob = step.imageId ? await db.getBlob(step.imageId) : null;
  const imageB64 = blob ? await annotatedForAI(blob, step) : null;
  const out = await complete(s, { system: systemPrompt(s), text: stepContext(demo, step, idx), imageB64 });
  return tidy(out);
}

async function writeChapter(s, demo, idx) {
  const after = demo.steps.slice(idx + 1).filter((x) => x.type === 'screen').slice(0, 6)
    .map((x, i) => `${i + 1}. ${x.tooltip && x.tooltip.text || ''}`).join('\n');
  const out = await complete(s, {
    system: `You write short section intros for an interactive product demo. Write in ${s.ai.language || 'English'}. Tone: ${TONES[s.ai.tone] || TONES.friendly}. Answer as JSON: {"title": "max 7 words", "text": "one sentence, max 22 words"}. No emojis.`,
    text: `Demo: ${demo.title}\nThe steps that follow this intro:\n${after || '(none yet)'}`,
  });
  try {
    const j = JSON.parse(out.replace(/^```(json)?|```$/g, '').trim());
    return { title: tidy(j.title), text: tidy(j.text) };
  } catch {
    return { title: '', text: tidy(out) };
  }
}

export async function writeTitle(s, demo) {
  const steps = demo.steps.filter((x) => x.type === 'screen').slice(0, 10)
    .map((x, i) => `${i + 1}. ${x.tooltip && x.tooltip.text || ''} (page: ${x.pageTitle || host(x.pageUrl)})`).join('\n');
  const out = await complete(s, {
    system: `Name an interactive product demo. Write in ${s.ai.language || 'English'}. Output only the name: 3 to 7 words, sentence case, describing what the viewer will learn to do. No quotes, no emojis.`,
    text: steps,
  });
  return tidy(out).replace(/\.$/, '');
}

export async function testAI(s) {
  const out = await complete(s, { system: 'Reply with the single word: ready', text: 'Are you there?' });
  return out;
}

// ---------- Voiceover ----------
export async function synthesize(s, text) {
  text = String(text || '').replace(/\*\*/g, '').trim();
  if (!text) throw new Error('There’s no text to read for this step.');
  if (s.tts.provider === 'openai') {
    const key = s.tts.openaiKey || s.ai.openaiKey;
    const base = (s.ai.openaiBase && s.ai.provider === 'openai' && !s.tts.openaiKey ? s.ai.openaiBase : 'https://api.openai.com/v1').replace(/\/+$/, '');
    const body = { model: s.tts.openaiModel || 'gpt-4o-mini-tts', voice: s.tts.openaiVoice || 'alloy', input: text, response_format: 'mp3' };
    if (/gpt-4o/.test(body.model)) body.instructions = 'Speak clearly at a relaxed pace, like a friendly product guide.';
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body),
    });
    if (!res.ok) throw await readError(res, 'OpenAI');
    return res.blob();
  }
  if (s.tts.provider === 'elevenlabs') {
    const voice = encodeURIComponent(s.tts.elevenVoice || '21m00Tcm4TlvDq8ikWAM');
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': s.tts.elevenKey },
      body: JSON.stringify({ text, model_id: s.tts.elevenModel || 'eleven_multilingual_v2' }),
    });
    if (!res.ok) throw await readError(res, 'ElevenLabs');
    const b = await res.blob();
    return b.type ? b : new Blob([b], { type: 'audio/mpeg' });
  }
  throw new Error('Choose a voice provider and add its API key in Settings.');
}

// Translate a list of short UI strings. Returns an array of the same length.
export async function translateTexts(s, texts, language) {
  const out = texts.slice();
  const idx = texts.map((t, i) => (t && t.trim() ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k < idx.length; k += 30) {
    const part = idx.slice(k, k + 30);
    const src = part.map((i) => texts[i]);
    const system = `You translate product-demo text into ${language}. Keep it natural and short, keep **bold** markers, product names, numbers and URLs unchanged. Reply with only a JSON array of strings, the same length and order as the input.`;
    const raw = await complete(s, { system, text: JSON.stringify(src), maxWords: Math.min(4000, 40 + src.join(' ').split(/\s+/).length * 3) });
    let arr = null;
    try { arr = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)); } catch { arr = null; }
    if (!Array.isArray(arr) || arr.length !== src.length) throw new Error('The AI reply couldn’t be read as a translation. Try again, or try another model.');
    part.forEach((i, j) => { out[i] = String(arr[j] == null ? texts[i] : arr[j]); });
  }
  return out;
}
