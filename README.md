# dictate

Minimal **local** voice dictation for pi. Runs entirely on your machine via **whisper.cpp** — no cloud, no paid API, and no audio is ever written to disk. No floating bubbles, no menu bar app, no notifications.

- **Toggle:** `alt+k` (press to start, press again to stop) — works **anywhere in pi**, not just the main chat input: quiz popups, `ask_user_question`, `ctx.ui.editor()`/`input()` dialogs, selectors. The key is intercepted at the TUI input layer, before whatever component has focus.
- **Cancel:** `alt+n` (discard the in-flight recording; safe to press anytime, no-op when nothing is recording)
- **Where text goes:** to whatever input field is focused **when you stop** (never replaces, always appends):
  - Main chat editor or any `ctx.ui.editor()`/`input()` popup → appended directly.
  - Opaque dialogs (quiz / ask_user_question selects) → typed in as keystrokes. Their internal focus is invisible to the extension, so **Tab into the note/Other field first** — that's where the text will land.
  - Nothing text-capable focused → transcript is copied to the clipboard (via `wl-copy` on Wayland, `pbcopy` on macOS — override with `DICTATE_CLIP_CMD`) and a notification says so. A finished dictation is never lost.
- **Start guard:** if no input field is focused when you press `alt+k`, dictation doesn't start and a notification explains why.
- **Live feedback:** while recording, the status row shows a red `●` plus a real-time mic-level meter (`● ▂▅▇ listening…`) — instant confirmation your mic is live. On stop it flips to a `finalizing…` spinner while whisper transcribes.

## Why local

- **No paid API.** Your voice never leaves the machine; there are no recurring costs and no API key.
- **No audio artifacts.** The take lives only in RAM for the ~second it takes to transcribe, then is discarded. Nothing is ever written to disk.

## Install

```bash
# extension:
pi install git:github.com/henrythdu/pi-dictate-local   # this fork
#  - or copy index.ts to ~/.pi/agent/extensions/dictate/index.ts (standalone)
```

## One-time setup — you need whisper.cpp

The extension shells out to the `whisper-cli` binary with a `whisper.cpp` ggml model. Install both:

```bash
# 1. mic capture (ALSA) — usually already present on Linux
sudo apt install alsa-utils          # provides `arecord`

# 2. whisper.cpp — a CUDA build is best if you have an NVIDIA GPU:
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_CUDA=ON         # CMake 3.14+; uses your CUDA toolkit
cmake --build build --config Release -j
sudo cp build/bin/whisper-cli /usr/local/bin/

# 3. the model (English-only pick; swap size freely)
#    download ggml-small.en.bin → ~/.cache/whisper/
```

A CPU build of whisper.cpp works identically if you have no NVIDIA GPU — just slower.

## Usage

1. Focus any pi input field — the main chat input, a quiz note field, an `ask_user_question` answer box.
2. Press `alt+k`. The status row shows a red `●` with a live mic-level meter: `● ▁▂▃▅ listening…`. The bars move with your voice — if they stay flat, no audio is reaching the mic.
3. Talk.
4. Press `alt+k` again. The meter is replaced by a braille spinner (`⠋ finalizing…`), then the text appears in the focused input.

Focus is resolved fresh at stop time, so if a dialog opened (or focus moved) while you were talking, the text goes to whatever is focused at that moment.

Run `/reload` in pi after first install (or after editing `index.ts`) to pick up changes.

## How it works

- While recording, the extension spawns `arecord` capturing 16kHz mono 16-bit PCM and buffers it **entirely in RAM** (a short dictation is ~1MB — trivial). Each chunk's RMS drives the live level meter.
- On stop, it kills the recorder and builds a standard WAV header in memory, then spawns `whisper-cli -m <model> -f - -nt` (adding `-ng` when GPU is disabled) and pipes the WAV in via **stdin** — no temp file.
- `-nt` prints the plain transcript (no timestamps) to stdout; the extension collects it, then delivers it through pi's focus-aware path:
  - editor-like components (`.getText`/`.setText`, including popups' inner `.editor`) get a direct append;
  - opaque components get the text as synthetic keystrokes routed by their own focus logic;
  - nothing focused → clipboard + a notification.
- whisper-cli runs as a short-lived process per dictation: the model is loaded, the take is transcribed, and the process exits — releasing any GPU memory it used.

## Customizing

All knobs are at the top of `index.ts`, and most are env-overridable:

| Env var | Default | Meaning |
|---|---|---|
| `WHISPER_CLI` | `whisper-cli` | path to the whisper.cpp binary |
| `WHISPER_MODEL` | `~/.cache/whisper/ggml-small.en.bin` | ggml model file |
| `WHISPER_GPU_LAYERS` | `24` | `0` = run fully on CPU (`-ng`); any `>0` = use GPU (default). whisper.cpp ≥1.9 made this a binary GPU/CPU switch |
| `DICTATE_STT_TIMEOUT_MS` | `15000` | safety timeout for a hung transcription |
| `ARECORD_DEVICE` | (default `-D`) | ALSA capture device if the default isn't your mic |
| `DICTATE_CLIP_CMD` | `wl-copy` | clipboard fallback command |
| `DICTATE_DEBUG` | off | append lifecycle log to `/tmp/dictate-debug.log` |

- **Hotkey:** change the `Key.alt("k")` / `Key.alt("n")` references near the bottom (the input listener `onGlobalInput` and the fallback `pi.registerShortcut` calls).
- **Model:** edit `WHISPER_MODEL` (or set the env var) — swap `ggml-small.en` for `base.en`, `medium.en`, etc. Only affects download size and accuracy; GPU latency is negligible either way.
- **GPU:** to disable GPU entirely (e.g. to free all VRAM for other workloads), set `WHISPER_GPU_LAYERS=0`.

## Why `alt+k` / `alt+n` (and tmux)

These are `alt`-based because **`ctrl+shift+<letter>` is not representable as a legacy terminal byte** — adding Shift to `Ctrl+M` doesn't change the byte, so `Ctrl+Shift+M` is indistinguishable from `Ctrl+M` (i.e. `\r` = Enter). That means inside **tmux** (which doesn't pass through the Kitty keyboard protocol, and only forwards modified keys when `extended-keys` is on — it's off by default), `ctrl+shift+k` would collapse to `Ctrl+K`. `alt+<letter>` has a distinct legacy byte (`Alt+K` → `ESC k`), which tmux forwards even without `extended-keys`, so the binding works both inside and outside tmux.

On macOS, your terminal must treat Option as Alt/Meta (pi already requires this for its own `alt+enter` follow-up and `alt+up` dequeue bindings). Ghostty does this by default; in iTerm2 set Profile → Keys → Left/Right Option key → `Esc+`.

If you prefer different bindings, edit the `registerShortcut` calls at the bottom of `index.ts`.

## Troubleshooting

- **"whisper-cli not found"** — install whisper.cpp and ensure `whisper-cli` is on `PATH` (or set `WHISPER_CLI`). Verify with `whisper-cli --version`.
- **"Whisper model not found"** — put the `ggml-*.bin` file at `WHISPER_MODEL`'s default (`~/.cache/whisper/`) or set `WHISPER_MODEL`.
- **"arecord error / Failed to spawn 'arecord'"** — `sudo apt install alsa-utils`; verify with `which arecord`. If the default device isn't your mic, set `ARECORD_DEVICE` (find names with `arecord -l`).
- **No mic input** — first check the level meter: if the bars stay flat while you talk, no audio is reaching arecord. Linux may need mic access granted to your terminal/desktop environment.
- **Slow transcription** — set `WHISPER_GPU_LAYERS=0` for pure CPU, or use a GPU build/model; a CPU `whisper-cli` build works fine, just slower on long takes.
- **'whisper failed (code …)'** — usually a GPU/model issue; run `whisper-cli -m <model> -f - -nt` manually to see stderr.
- **Nothing happens after stop** — check `DICTATE_DEBUG=1` and the `/tmp/dictate-debug.log`. If you saw "no input field is focused", the transcript was copied to the clipboard — paste with Ctrl+V (or ⌘V on mac).
- **Dictated text vanished into a quiz/ask dialog** — the dialog's option list (not its text field) had focus. Tab into the note/Other field before toggling dictation.
- **`alt+k` inserts `µ` instead of toggling** (macOS) — your terminal isn't treating Option as Alt. In iTerm2: Profile → Keys → Left/Right Option key → `Esc+`. (Ghostty/Kitty/WezTerm do this by default.)
- **Need lifecycle logs?** Run pi with `DICTATE_DEBUG=1` — the extension appends timestamped events (key hits, toggles, spawn/exit/errors with their session generation) to `/tmp/dictate-debug.log`.
