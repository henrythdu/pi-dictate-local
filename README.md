# dictate

Minimal voice dictation for pi. No floating bubbles, no menu bar app, no notifications.

- **Toggle:** `alt+m` (press to start, press again to stop)
- **Cancel:** `alt+n` (discard the in-flight transcript; safe to press anytime, no-op when no dictation is in flight)
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
2. Press `alt+m`. You'll see `🎤 listening…` in the status row.
3. Talk.
4. Press `alt+m` again. Status flips to `…finalizing`, then text appears in your input.

Run `/reload` in pi after first install (or after editing `index.ts`) to pick up changes.

## How it works

- The extension spawns `rec` (sox) capturing 16kHz mono 16-bit PCM to stdout.
- It opens a Deepgram WebSocket and pipes the PCM stream in.
- Deepgram returns "final" results (per-utterance, stable) as you talk. Interim/partial results are disabled — the editor never shows revisable text.
- On stop, the extension sends `{"type": "CloseStream"}`, waits for the server to flush, concatenates all finals, and appends to the editor with `ctx.ui.setEditorText(current + " " + transcript)`.

## Customizing

All knobs are at the top of `index.ts`:

- **Hotkey:** change the `pi.registerShortcut(Key.alt("m"), ...)` / `Key.alt("n")` calls near the bottom.
- **Model:** edit `DG_URL` — swap `model=nova-3` for `nova-2`, `enhanced`, etc.
- **Endpointing (how long a silence ends an utterance):** `endpointing=300` in the URL. Lower = faster finals, more fragmentation. Higher = slower finals, more coherent chunks.
- **Smart formatting / punctuation:** toggle `smart_format` and `punctuate` in the URL.

## Why `alt+m` / `alt+n` (and tmux)

The defaults are `alt`-based rather than `ctrl+shift`-based because **`ctrl+shift+<letter>` is not representable as a legacy terminal byte** — adding Shift to `Ctrl+M` doesn't change the byte, so `Ctrl+Shift+M` is indistinguishable from `Ctrl+M` (i.e. `\r` = Enter). That means inside **tmux** (which doesn't pass through the Kitty keyboard protocol, and only forwards modified keys when `extended-keys` is on — it's off by default), `ctrl+shift+m` would collapse to **Enter and submit your prompt**, and `ctrl+shift+n` would collapse to `Ctrl+N`.

`alt+<letter>` is safe because it has a distinct legacy byte (`Alt+M` → `ESC m`), which tmux forwards even without `extended-keys`. pi-tui matches this legacy form, so the binding works:

- inside tmux with default settings (the legacy `ESC m` form),
- inside tmux with `extended-keys on` + `extended-keys-format csi-u` (CSI-u form),
- and outside tmux with Kitty protocol / modifyOtherKeys active.

On macOS, your terminal must treat Option as Alt/Meta (pi already requires this for its own `alt+enter` follow-up and `alt+up` dequeue bindings). Ghostty does this by default; in iTerm2 set Profile → Keys → Left/Right Option key → `Esc+`.

If you prefer the original `ctrl+shift+m` / `ctrl+shift+n` bindings and run inside tmux, add this to `~/.tmux.conf` (tmux 3.5+) so tmux forwards modified keys in CSI-u form, then edit the `registerShortcut` calls at the bottom of `index.ts`:

```
set -g extended-keys on
set -g extended-keys-format csi-u
```

See https://pi.dev/docs/latest/tmux for the full pi-on-tmux keyboard guide.

## Troubleshooting

- **"DEEPGRAM_API_KEY not set"** — env var isn't visible to pi. Restart your terminal after editing your shell rc file, or run `export DEEPGRAM_API_KEY=...` in the same shell that launches pi.
- **"Failed to spawn 'rec'" / "rec error"** — `brew install sox` and verify with `which rec`.
- **No mic input** — macOS may need to grant your terminal app microphone access. System Settings → Privacy & Security → Microphone → enable your terminal (Terminal.app, iTerm, Ghostty, etc.).
- **Nothing happens after stop** — check console output (errors are surfaced as pi notifications). Most common cause: WebSocket couldn't reach Deepgram (firewall, bad key).
- **`alt+m` inserts `µ` instead of toggling** (macOS) — your terminal isn't treating Option as Alt. In iTerm2: Profile → Keys → Left/Right Option key → `Esc+`. (Ghostty/Kitty/WezTerm do this by default.)
- **Shortcuts don't work inside tmux** — if you rebound to `ctrl+shift+m`/`ctrl+shift+n`, those collapse to Enter / `Ctrl+N` unless tmux forwards modified keys; see the tmux section above. The default `alt+m`/`alt+n` bindings do not have this problem.
