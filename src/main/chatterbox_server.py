# Her voice on your PC: Chatterbox Turbo (Resemble AI, MIT), kept loaded so each line is quick.
# Started by tts.js with Chatterbox's own Python. Listens on 127.0.0.1 only, prints "READY <port>"
# once the model is in, then: POST /tts {"text": "...", "voice": "C:/clip.wav" or null} -> audio/wav.

import io
import json
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS

def watch_parent():
    """Capri gone (closed, crashed, killed): stdin closes, and this goes too, freeing the GPU."""
    sys.stdin.read()
    os._exit(0)


threading.Thread(target=watch_parent, daemon=True).start()

device = "cuda" if torch.cuda.is_available() else "cpu"
model = ChatterboxTurboTTS.from_pretrained(device=device)
lock = threading.Lock()  # one GPU: one line at a time
default_conds = model.conds  # its built-in voice
current_voice = None         # the clip model.conds was made from (None: built-in)


def use_voice(voice):
    """The clip is read once, not for every sentence (that's most of the time a line takes)."""
    global current_voice
    if voice == current_voice:
        return
    if voice:
        model.prepare_conditionals(voice)
    else:
        model.conds = default_conds
    current_voice = voice

with torch.inference_mode():
    model.generate("Hi.")  # the first line is slow (CUDA warming up): said here, not to you


def to_wav(samples, rate):
    pcm = (samples.detach().cpu().float().clamp(-1, 1).squeeze() * 32767).to(torch.int16).numpy()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/tts":
            return self.send_error(404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            text = str(body.get("text") or "").strip()
            if not text:
                return self.send_error(400, "no text")
            with lock, torch.inference_mode():
                use_voice(body.get("voice") or None)
                audio = model.generate(text)
            data = to_wav(audio, model.sr)
        except Exception as err:  # said back to tts.js, which reads it with edge-tts instead
            msg = str(err).encode("utf-8", "replace")[:500]
            self.send_response(500)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.send_header("content-length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(f"READY {server.server_address[1]} {device}", flush=True)
server.serve_forever()
