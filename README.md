# dictate

Local voice dictation for pi. Runs on your machine with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No cloud, no paid API. Audio is never written to disk (unless you set `DICTATE_DUMP_WAV=1`).

- **Toggle:** `alt+k` — press to start, press again to stop. Works in any pi input: the chat editor, quiz popups, `ask_user_question` dialogs, selectors. The key is caught at the TUI input layer, before whatever component has focus.
- **Cancel:** `alt+n` — discards the recording. No-op when nothing is recording.
- **Where text goes:** to the input field that is focused when you stop. It appends, never replaces.
  - Chat editor or any `ctx.ui.editor()`/`input()` popup → appended.
  - Opaque dialogs (quiz / `ask_user_question` selects) → typed as keystrokes. Their internal focus is hidden from the extension, so **Tab into the note/Other field first**.
  - Nothing text-accepting focused → transcript is copied to the clipboard (`wl-copy` on Wayland, `pbcopy` on macOS, override with `DICTATE_CLIP_CMD`).
- **Start rule:** if no input field is focused when you press `alt+k`, dictation does not start.
- **While recording:** the status row shows a red `●` and a mic-level meter (`● ▂▅▇ listening…`). Flat bars = no audio reaching the mic. On stop it shows a `transcribing…` spinner.

## Install

```bash
pi install git:github.com/henrythdu/pi-dictate-local
```

Or copy `index.ts` to `~/.pi/agent/extensions/dictate/index.ts` (standalone).

## Setup

The extension runs the `whisper-cli` binary with a whisper.cpp ggml model. Install both:

```bash
# 1. mic capture (ALSA) — usually already present on Linux
sudo apt install alsa-utils          # provides `arecord`

# 2. whisper.cpp — CUDA build if you have an NVIDIA GPU:
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_CUDA=ON         # CMake 3.14+
cmake --build build --config Release -j
sudo cp build/bin/whisper-cli /usr/local/bin/

# 3. the model
#    download ggml-small.en.bin → ~/.cache/whisper/
```

A CPU build of whisper.cpp works too — just slower.

## Usage

1. Focus a pi input field.
2. Press `alt+k`. The status row shows a red `●` and a mic-level meter. The bars move with your voice; if they stay flat, no audio is reaching the mic.
3. Talk.
4. Press `alt+k` again. A `transcribing…` spinner appears, then the text lands in the focused input.

Run `/reload` in pi after install (or after editing `index.ts`).

## How it works

- While recording, the extension runs `arecord` capturing 16kHz mono 16-bit PCM and buffers it in memory (a short take is ~1MB).
- On stop it builds a WAV header in memory, runs `whisper-cli -m <model> -f - -nt -of - -otxt` (adds `-ng` when GPU is off) and pipes the WAV in via stdin — no audio file is written.
- whisper-cli writes the transcript to stdout; the extension reads it back after the process exits, then appends it to the focused input (or copies to clipboard).
- Each take runs whisper-cli as a short-lived process: model loads, take is transcribed, process exits and frees GPU memory.

## Configuration

Knobs are at the top of `index.ts`; most are env-overridable:

| Env var | Default | Meaning |
|---|---|---|
| `WHISPER_CLI` | `whisper-cli` | path to the whisper.cpp binary |
| `WHISPER_MODEL` | `~/.cache/whisper/ggml-small.en.bin` | ggml model file |
| `WHISPER_GPU_LAYERS` | `24` | `0` = CPU (`-ng`); `>0` = GPU (default). Binary switch — whisper.cpp ≥1.9 has no layer-granular offload |
| `DICTATE_STT_TIMEOUT_MS` | `15000` | time to wait for a hung transcription |
| `ARECORD_DEVICE` | (system default) | ALSA capture device if the default isn't your mic |
| `DICTATE_CLIP_CMD` | `wl-copy` | clipboard command |
| `DICTATE_DEBUG` | off | write lifecycle log to `/tmp/dictate-debug.log` |
| `DICTATE_DUMP_WAV` | off | debug: dump the transcribed WAV to `/tmp/dictate-dump.wav` |

- **Hotkey:** change the `Key.alt("k")` / `Key.alt("n")` references near the bottom of `index.ts`.
- **Model:** set `WHISPER_MODEL` — swap `ggml-small.en` for `base.en`, `medium.en`, etc. Only affects download size and accuracy.
- **GPU:** set `WHISPER_GPU_LAYERS=0` to disable GPU (frees VRAM for other work).

## Why `alt+k` / `alt+n` (tmux)

These are `alt`-based because `ctrl+shift+<letter>` is not representable as a legacy terminal byte. Adding Shift to `Ctrl+M` doesn't change the byte, so `Ctrl+Shift+M` is the same as `Ctrl+M` (`\r` = Enter). Inside tmux (which doesn't pass through the Kitty keyboard protocol and only forwards modified keys when `extended-keys` is on — off by default), `ctrl+shift+k` collapses to `Ctrl+K`. `alt+<letter>` has a distinct legacy byte (`Alt+K` → `ESC k`), which tmux forwards even without `extended-keys`, so the binding works inside and outside tmux.

On macOS, your terminal must treat Option as Alt/Meta. Ghostty does this by default; in iTerm2 set Profile → Keys → Left/Right Option key → `Esc+`.

To use different bindings, edit the `registerShortcut` calls at the bottom of `index.ts`.

## Troubleshooting

- **"whisper-cli not found"** — install whisper.cpp and put `whisper-cli` on `PATH` (or set `WHISPER_CLI`). Verify with `whisper-cli --version`.
- **"Whisper model not found"** — put the `ggml-*.bin` file at `WHISPER_MODEL`'s default (`~/.cache/whisper/`) or set `WHISPER_MODEL`.
- **"arecord error"** — install alsa-utils (`which arecord`). If the default device isn't your mic, set `ARECORD_DEVICE` (list devices with `arecord -l`).
- **Flat meter while talking** — no audio is reaching `arecord`. Grant mic access to your terminal/desktop environment, or set `ARECORD_DEVICE`.
- **Slow transcription** — set `WHISPER_GPU_LAYERS=0` for CPU, or use a GPU build.
- **"whisper failed (code …)"** — run `whisper-cli -m <model> -f - -nt -of - -otxt` manually to see stderr.
- **"No speech detected"** — the mic captured silence; check `ARECORD_DEVICE`. A separate **"Whisper backend error"** message means a real whisper/GPU failure, not the mic.
- **Nothing after stop** — run with `DICTATE_DEBUG=1` and check `/tmp/dictate-debug.log`. If you saw "no input field is focused", the text went to the clipboard — paste with Ctrl+V.
- **Text vanished into a quiz/ask dialog** — the dialog's option list had focus. Tab into the note/Other field first.
- **`alt+k` inserts `µ`** (macOS) — your terminal isn't treating Option as Alt. In iTerm2: Profile → Keys → Left/Right Option key → `Esc+`.
