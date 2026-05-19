# dictate

Minimal voice dictation for pi. No floating bubbles, no menu bar app, no notifications.

- **Toggle:** `ctrl+shift+m` (press to start, press again to stop)
- **Cancel:** `ctrl+shift+n` (discard the in-flight transcript; safe to press anytime, no-op when no dictation is in flight)
- **Where text goes:** appended to pi's input editor on stop (never replaces)
- **Backend:** Deepgram Nova-3 streaming
- **What's "real-time":** audio is transcribed *while you talk*; the finalized text is inserted in one shot when you stop. Stop-to-display latency is typically ~300-500ms.

## One-time setup

```bash
brew install sox                              # provides `rec` for audio capture
export DEEPGRAM_API_KEY=dg_xxxxxxxxxxxxxxxx   # add to ~/.zshrc or ~/.bashrc
```

Sign up at https://console.deepgram.com — $200 free credit, no card. The Nova-3 streaming rate is ~$0.0077/min (~$0.46/hr).

## Usage

1. Focus pi.
2. Press `ctrl+shift+m`. You'll see `🎤 listening…` in the status row.
3. Talk.
4. Press `ctrl+shift+m` again. Status flips to `…finalizing`, then text appears in your input.

Run `/reload` in pi after first install (or after editing `index.ts`) to pick up changes.

## How it works

- The extension spawns `rec` (sox) capturing 16kHz mono 16-bit PCM to stdout.
- It opens a Deepgram WebSocket and pipes the PCM stream in.
- Deepgram returns "final" results (per-utterance, stable) as you talk. Interim/partial results are disabled — the editor never shows revisable text.
- On stop, the extension sends `{"type": "CloseStream"}`, waits for the server to flush, concatenates all finals, and appends to the editor with `ctx.ui.setEditorText(current + " " + transcript)`.

## Customizing

All knobs are at the top of `index.ts`:

- **Hotkey:** change `pi.registerShortcut("ctrl+shift+m", ...)` near the bottom.
- **Model:** edit `DG_URL` — swap `model=nova-3` for `nova-2`, `enhanced`, etc.
- **Endpointing (how long a silence ends an utterance):** `endpointing=300` in the URL. Lower = faster finals, more fragmentation. Higher = slower finals, more coherent chunks.
- **Smart formatting / punctuation:** toggle `smart_format` and `punctuate` in the URL.

## Troubleshooting

- **"DEEPGRAM_API_KEY not set"** — env var isn't visible to pi. Restart your terminal after editing your shell rc file, or run `export DEEPGRAM_API_KEY=...` in the same shell that launches pi.
- **"Failed to spawn 'rec'" / "rec error"** — `brew install sox` and verify with `which rec`.
- **No mic input** — macOS may need to grant your terminal app microphone access. System Settings → Privacy & Security → Microphone → enable your terminal (Terminal.app, iTerm, Ghostty, etc.).
- **Nothing happens after stop** — check console output (errors are surfaced as pi notifications). Most common cause: WebSocket couldn't reach Deepgram (firewall, bad key).
