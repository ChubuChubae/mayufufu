'use strict';

// Her voice: lines read aloud with edge-tts (free Microsoft Edge neural voices, needs internet
// and `python -m pip install edge-tts`). Returns the mp3 bytes; the overlay plays them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const DEFAULT_VOICE = 'en-US-EmmaMultilingualNeural'; // Emma, and she can read her other languages too
const MAX_CHARS = 2500; // a long answer is cut at the last full sentence before this

function clean(text) {
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')                 // code blocks: not something to listen to
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')         // [label](link) -> label
    .replace(/https?:\/\/\S+/g, '')                  // bare links aren't worth reading
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')           // table divider rows
    .replace(/\|/g, ', ')                            // table cells
    .replace(/[*_`#>~]/g, '')                        // markdown bits
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > MAX_CHARS) {
    const cut = s.slice(0, MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut;
  }
  return s;
}

// ElevenLabs: a voice of theirs by id, with your key (config apiKeys.elevenlabs or ELEVENLABS_API_KEY).
// Flash: their fastest model, and half the credits per character. null when it says no (out of
// credits, a library voice on the free plan…): edge-tts reads it instead.
const ELEVEN_MODEL = 'eleven_flash_v2_5';
async function elevenlabs(line, { voice, key, model = ELEVEN_MODEL }) {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: line, model_id: model }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`[capri] elevenlabs said ${res.status}:`, (await res.text().catch(() => '')).slice(0, 300));
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn('[capri] elevenlabs failed:', err.message);
    return null;
  }
}

async function speak(text, { voice = DEFAULT_VOICE, python = 'python', eleven = null } = {}) {
  const line = clean(text);
  if (!line) return null;
  if (eleven?.key && eleven.voice) {
    const bytes = await elevenlabs(line, eleven);
    if (bytes) return bytes;
  }
  return edge(line, { voice, python });
}

function edge(line, { voice, python }) {
  const out = path.join(os.tmpdir(), `capri-tts-${randomUUID()}.mp3`);
  return new Promise((resolve) => {
    execFile(
      python,
      ['-m', 'edge_tts', '--voice', voice, `--text=${line}`, '--write-media', out],
      { windowsHide: true, timeout: 45000 },
      (err) => {
        let bytes = null;
        try {
          if (!err) bytes = fs.readFileSync(out);
        } catch {}
        fs.rm(out, { force: true }, () => {});
        if (err) console.warn('[capri] tts failed:', err.message);
        resolve(bytes);
      },
    );
  });
}

module.exports = { speak, DEFAULT_VOICE };
