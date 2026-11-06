'use strict';

// Hearing you: what you say to her, turned into text by Whisper, here on this PC (transformers.js,
// onnxruntime). The model is downloaded once, the first time you talk, into her data folder.

const path = require('node:path');
const { app } = require('electron');

const MODELS = {
  'whisper-tiny': 'onnx-community/whisper-tiny',
  'whisper-base': 'onnx-community/whisper-base',
  'whisper-small': 'onnx-community/whisper-small',
};
// about how much each downloads (q8, all its files): its files turn up one after the other, so their
// sizes alone would make the bar fill up, then fall back
const SIZE = { 'whisper-tiny': 42e6, 'whisper-base': 80e6, 'whisper-small': 250e6 };
// languages you can speak to her in besides hers (Whisper codes), offered in the tray menu
const LANGS = { th: 'ไทย (Thai)' };
// languages tiny and base barely understand: they get the small model
const NEEDS_SMALL = new Set(['th']);
// what Whisper "hears" in silence or noise: never sent as if you'd said it
const HALLUCINATIONS = /^(?:thanks? (?:you )?for watching|ขอบคุณที่รับชม|ติดตามช่อง|ซับไตเติ้ล|คำบรรยาย|merci d['’]avoir regardé|sous-titr|subt[ií]tulos|legendas|продолжение следует|редактор субтитров|amara\.org|\[.*\]|\(.*\)|\*.*\*$|you\.?$|(?:(?:весёлая|веселая|спокойная|грустная|тревожная|динамичная)\s+)?музыка\.?$)/i;

let loading = null; // Promise of the pipeline
let loadedName = null;
let state = { ready: false, downloading: false, progress: 0 };

function load(name, onProgress) {
  if (!MODELS[name]) name = 'whisper-base';
  const id = MODELS[name];
  if (loading && loadedName === id) return loading;
  loadedName = id;
  loading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(app.getPath('userData'), 'models');
    env.allowLocalModels = false;
    const files = new Map(); // file -> [loaded, total]
    const pipe = await pipeline('automatic-speech-recognition', id, {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, [p.loaded, p.total]);
        let got = 0;
        let all = 0;
        for (const [l, t] of files.values()) { got += l; all += t; }
        const k = Math.min(0.99, got / Math.max(all, SIZE[name]));
        state = { ready: false, downloading: true, progress: Math.max(state.progress, k) };
        onProgress?.(state);
      },
    });
    state = { ready: true, downloading: false, progress: 1 };
    onProgress?.(state);
    return pipe;
  })().catch((err) => {
    loading = null;
    state = { ready: false, downloading: false, progress: 0 };
    throw err;
  });
  return loading;
}

// audio: 16 kHz mono Float32Array. Resolves with { ok, text } ('' when nothing was said).
async function transcribe(audio, { lang, model, onProgress } = {}) {
  try {
    if (NEEDS_SMALL.has(lang) && model !== 'whisper-small') model = 'whisper-small';
    const pipe = await load(model, onProgress);
    const out = await pipe(audio, {
      language: lang || null, // her language; Whisper guesses when it's not one of hers
      task: 'transcribe',
      chunk_length_s: 30,
    });
    const text = String(out?.text || '').replace(/\s+/g, ' ').trim();
    const said = text && /[\p{L}\p{N}]/u.test(text) && !HALLUCINATIONS.test(text) ? text : '';
    return { ok: true, text: said };
  } catch (err) {
    console.error('[capri] stt:', err);
    return { ok: false, error: err?.message || String(err) };
  }
}

const status = () => state;

module.exports = { load, transcribe, status, MODELS, LANGS };
