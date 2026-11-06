'use strict';

// Her voice: lines read aloud with edge-tts (free Microsoft Edge neural voices, needs internet
// and `python -m pip install edge-tts`). Returns the mp3 bytes; the overlay plays them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
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

// Chatterbox Turbo on your PC (chatterbox_server.py, its own Python in a venv): started the first time
// it's asked for and kept loaded. Until the model is in (a minute or two, longer the very first time while
// it downloads) her lines go to edge-tts, so she never goes quiet waiting for it.
const CHATTERBOX_PYTHON = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Capri', 'chatterbox', 'venv', 'Scripts', 'python.exe');
const CHATTERBOX_SCRIPT = path.join(__dirname, 'chatterbox_server.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const cbox = { child: null, port: 0, python: null };

function chatterboxReady() {
  return Boolean(cbox.port);
}

function chatterboxStart(python = CHATTERBOX_PYTHON) {
  if (cbox.child && cbox.python === python) return;
  chatterboxStop();
  if (!fs.existsSync(python)) {
    console.warn('[capri] chatterbox: no Python at', python);
    return;
  }
  const child = spawn(python, ['-u', CHATTERBOX_SCRIPT], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  Object.assign(cbox, { child, port: 0, python });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    const m = /READY (\d+) (\w+)/.exec(out);
    if (m && !cbox.port && cbox.child === child) {
      cbox.port = Number(m[1]);
      console.log(`[capri] chatterbox ready on ${m[2]}`);
    }
  });
  child.stderr.on('data', (d) => {
    const line = String(d).trim();
    if (/error|exception|traceback/i.test(line)) console.warn('[capri] chatterbox:', line.slice(0, 300));
  });
  child.on('exit', (code) => {
    if (cbox.child !== child) return;
    console.warn('[capri] chatterbox stopped', code);
    Object.assign(cbox, { child: null, port: 0, python: null });
  });
}

// A venv's python.exe is only a launcher: the real Python is its child, holding the model on the GPU.
// Killing the launcher alone leaves that one running, so the whole tree goes.
function chatterboxStop() {
  const pid = cbox.child?.pid;
  if (pid && process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    cbox.child?.kill();
  }
  Object.assign(cbox, { child: null, port: 0, python: null });
}

// One voice for the whole conversation: while the model loads, her lines wait for it (rather than
// starting in edge-tts and changing voice halfway); a line it fails on is skipped, not read in another
// voice. Only when Chatterbox can't run at all (not installed, crashed, never ready) does edge-tts speak.
const READY_WAIT = 90000;
const SKIP = Symbol('skip');

async function waitReady(ms) {
  const until = Date.now() + ms;
  while (!cbox.port && cbox.child && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  return Boolean(cbox.port);
}

async function chatterbox(line, { voice, python }) {
  chatterboxStart(python || CHATTERBOX_PYTHON);
  if (!cbox.child) return null;                 // can't run: edge-tts
  if (!(await waitReady(READY_WAIT))) return null; // crashed or stuck loading: edge-tts
  try {
    const res = await fetch(`http://127.0.0.1:${cbox.port}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: line, voice: voice || null }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      console.warn(`[capri] chatterbox said ${res.status}:`, (await res.text().catch(() => '')).slice(0, 300));
      return cbox.child ? SKIP : null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn('[capri] chatterbox failed:', err.message);
    return cbox.child ? SKIP : null;
  }
}

async function speak(text, { voice = DEFAULT_VOICE, python = 'python', eleven = null, cbox: local = null } = {}) {
  const line = clean(text);
  if (!line) return null;
  if (local) {
    const bytes = await chatterbox(line, local);
    if (bytes === SKIP) return null; // said by no one rather than in another voice
    if (bytes) return bytes;
  }
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

module.exports = { speak, DEFAULT_VOICE, CHATTERBOX_PYTHON, chatterboxStart, chatterboxStop, chatterboxReady };
