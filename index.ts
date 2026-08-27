/**
 * dictate — minimal voice dictation for pi. Local transcription.
 *
 * Press alt+k to start, press it again to stop.
 * Press alt+n to cancel and discard the in-flight transcript.
 *
 * Focus-aware: alt+k/alt+n are intercepted at the TUI input layer (before any
 * focused component), so dictation works inside ANY dialog — quiz popups,
 * ask_user_question, ctx.ui.editor()/input() — not just the main chat editor.
 *
 * Start rule: dictation only begins if some text-capable component is
 * focused; otherwise an ephemeral notification explains why nothing happened.
 * Opaque dialogs (quiz/ask selects) count as text-capable, but their internal
 * focus is invisible to us — Tab into the note/Other field first so the text
 * lands there.
 *
 * Stop rule: the delivery target is resolved fresh at stop time and the
 * transcript goes to whatever is focused THEN (editor-like components get a
 * direct setText append; opaque components get synthetic keystrokes). If
 * nothing text-capable is focused at stop, the transcript is copied to the
 * clipboard and a notification says so — a finished dictation is never lost.
 *
 * Local pipeline (no cloud, no audio persisted):
 *   arecord captures 16kHz/16-bit/mono PCM into memory.
 *   On stop a WAV header is built in memory and piped straight into
 *   whisper-cli stdin (whisper.cpp, ggml.cuda build). Nothing is written to
 *   disk — the audio exists only in RAM for the duration of the take, then is
 *   discarded. Default hotkeys are alt+k (toggle) / alt+n (cancel) so they
 *   don't clash with pi-intercom's alt+m.
 *
 * Requires:
 *   - arecord             (ALSA utils; usually preinstalled on Linux)
 *   - whisper-cli         (whisper.cpp — preferably a CUDA build for GPU)
 *   - a ggml model file, e.g. ggml-small.en.bin
 *
 * Tuning (all env-overridable):
 *   WHISPER_CLI            path to whisper-cli (default: "whisper-cli" on PATH)
 *   WHISPER_MODEL          path to the ggml model (default: ~/.cache/whisper/ggml-small.en.bin)
 *   WHISPER_GPU_LAYERS     -ngl layers offloaded to GPU (default 24; set 0 = full CPU,
 *                           lower if it must share VRAM with LM Studio)
 *   DICTATE_STT_TIMEOUT_MS safety timeout for a hung transcription (default 15000)
 *   ARECORD_DEVICE         ALSA device for arecord -D (default: system default)
 *   DICTATE_CLIP_CMD       clipboard fallback command (default: wl-copy, Linux; pbcopy on mac)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { spawn, spawnSync, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { appendFileSync, existsSync } from "node:fs";

// Optional forensic logging: run pi with DICTATE_DEBUG=1 to append timestamped
// lifecycle events (listener hits, toggles, spawn/exit, errors) to
// /tmp/dictate-debug.log.
const DEBUG = !!process.env.DICTATE_DEBUG;
const dbg = (msg: string) => {
  if (!DEBUG) return;
  try {
    appendFileSync("/tmp/dictate-debug.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

const HOME = process.env.HOME ?? "";

// ── Local STT knobs (env-overridable) ─────────────────────────────────────
const WHISPER_CLI = process.env.WHISPER_CLI ?? "whisper-cli";
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ?? `${HOME}/.cache/whisper/ggml-small.en.bin`;
// GPU control. whisper.cpp ≥1.9 has no layer-granular offload (-ngl was removed);
// it's binary: GPU on by default, or fully CPU with -ng.
// Set WHISPER_GPU_LAYERS=0 to run entirely on CPU (frees ALL VRAM for LM Studio).
// Even on GPU, small.en's occupancy is ~600MB and transient — the process exits
// after each dictation, so it never resides alongside LM Studio models.
// (Env value kept as a tiny bit-flag for source compatibility with older docs.)
const WHISPER_GPU_LAYERS = Number(process.env.WHISPER_GPU_LAYERS ?? 24);
const GPU_ON = WHISPER_GPU_LAYERS > 0;
const STT_TIMEOUT_MS = Number(process.env.DICTATE_STT_TIMEOUT_MS ?? 15000);
const ARECORD_DEVICE = process.env.ARECORD_DEVICE ?? "";
const CLIP_CMD = process.env.DICTATE_CLIP_CMD ?? "wl-copy";
// Diagnostics: dump the exact WAV the extension would transcribe to
// /tmp/dictate-dump.wav on every stop. Analyze offline; remove in prod.
const DUMP_WAV = !!process.env.DICTATE_DUMP_WAV;

const AUDIO_SAMPLE_RATE = 16000;

type State = "idle" | "recording" | "stopping";

// ── Focus-aware delivery ──────────────────────────────────────────────────
// The TUI handle is captured once via a zero-height widget factory (the only
// extension-API surface that exposes it). With it we can:
//   1. Listen to ALL terminal input via tui.addInputListener — listeners run
//      before the focused component, so alt+k works even while a custom
//      dialog has stolen focus from the main editor (extension shortcuts are
//      otherwise only matched by the main editor component).
//   2. Inspect tui.focusedComponent to decide where the transcript goes.
// `focusedComponent` is declared private in the typings but is a plain
// runtime property — a benign peek, easily patched if pi internals change.
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  | { kind: "editor"; editor: EditorLike }
  | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

// Same braille frames pi-tui's Loader uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Audio meter — a tiny rolling waveform rendered in the status row while recording.
const METER_CELLS = 6;
const METER_TICK_MS = 60;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;

/** Compute normalized RMS (0..1) over a buffer of signed 16-bit little-endian PCM samples. */
function rmsFromPcm16(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount * 2; i += 2) {
    const s = buf.readInt16LE(i);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

/** Map a normalized RMS value to one of PEAK_BLOCKS by converting to dB and clamping into the visible range. */
function rmsToBlock(rms: number): string {
  if (rms <= 0) return PEAK_BLOCKS[0]!;
  const db = 20 * Math.log10(rms);
  const t = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
  const idx = Math.floor(t * (PEAK_BLOCKS.length - 1));
  return PEAK_BLOCKS[idx]!;
}

/** Build a 16kHz / mono / 16-bit PCM WAV header and concatenate the payload. No file I/O. */
function wavFromPcm16(pcm: Buffer): Buffer {
  const numChannels = 1;
  const bits = 16;
  const sampleRate = AUDIO_SAMPLE_RATE;
  const blockAlign = (numChannels * bits) / 8;
  const byteRate = (sampleRate * numChannels * bits) / 8;
  const dataSize = pcm.length;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataSize, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(numChannels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataSize, 40);
  return Buffer.concat([h, pcm]);
}

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let rec: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let transcribeProc: ChildProcessWithoutNullStreams | null = null;
  let pcmChunks: Buffer[] = [];
  let activeCtx: ExtensionContext | null = null;
  let cancelled = false;
  let stopTimeout: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  // Session generation: incremented on every start and every cleanup. All
  // async event handlers capture the generation they belong to and no-op
  // when it's stale — otherwise a PREVIOUS session's process exiting late
  // (e.g. one we aborted) would run cleanup() and tear down the CURRENT one.
  let generation = 0;
  // Audio meter state (see startMeter).
  let meterTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(0);
  let currentLevel = 0;

  const setStatus = (msg: string | undefined) => {
    if (!activeCtx) return;
    activeCtx.ui.setStatus("dictate", msg);
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const stopMeter = () => {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
  };

  /** Start the meter ticking. Each tick shifts the ring and samples currentLevel. */
  const startMeter = () => {
    stopMeter();
    meter = new Array(METER_CELLS).fill(0);
    currentLevel = 0;
    const render = () => {
      const dot = activeCtx?.ui.theme.fg("error", "●") ?? "●";
      setStatus(`${dot} ${meter.map(rmsToBlock).join("")} listening…`);
    };
    render();
    meterTimer = setInterval(() => {
      meter.shift();
      meter.push(currentLevel);
      render();
    }, METER_TICK_MS);
  };

  /** Animate the dictate status row with a braille spinner + suffix message. */
  const startSpinner = (suffix: string) => {
    stopSpinner();
    spinnerFrame = 0;
    setStatus(`${SPINNER_FRAMES[0]} ${suffix}`);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      setStatus(`${SPINNER_FRAMES[spinnerFrame]} ${suffix}`);
    }, SPINNER_INTERVAL_MS);
  };

  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;

  /** Resolve where dictated text would go RIGHT NOW, based on keyboard focus. */
  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.focusedComponent;
    if (!focused) return null;
    const editor = asEditorLike(focused) ?? asEditorLike(focused.editor);
    if (editor) return { kind: "editor", editor };
    if (typeof focused.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  /** Place the finished transcript in the focused field (or clipboard). */
  const deliverTranscript = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || !activeCtx) return;

    // Legacy fallback: no TUI handle captured (non-TUI mode / older pi) —
    // append to the main chat editor exactly as before.
    if (!tuiHandle) {
      const current = activeCtx.ui.getEditorText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      activeCtx.ui.setEditorText(current + sep + clean);
      return;
    }

    const target = resolveTarget();
    if (target?.kind === "editor") {
      const current = target.editor.getText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      target.editor.setText(current + sep + clean);
      tuiHandle.requestRender?.();
      return;
    }
    if (target?.kind === "typable") {
      target.component.handleInput(clean);
      tuiHandle.requestRender?.();
      return;
    }
    // Nothing to type into: don't throw the transcript away — stash it on the
    // clipboard and say so.
    try {
      const p = spawn(CLIP_CMD, [], { stdio: ["pipe", "ignore", "ignore"] });
      p.stdin.end(clean);
    } catch {}
    activeCtx.ui.notify("Dictation finished but no input field is focused — transcript copied to clipboard", "warning");
  };

  const cleanup = () => {
    generation++; // invalidate the dying session's event handlers
    dbg(`cleanup → gen ${generation}`);
    stopSpinner();
    stopMeter();
    if (stopTimeout) {
      clearTimeout(stopTimeout);
      stopTimeout = null;
    }
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
      rec = null;
    }
    if (transcribeProc) {
      try {
        transcribeProc.kill("SIGTERM");
      } catch {}
      transcribeProc = null;
    }
    pcmChunks = [];
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
    cancelled = false;
  };

  const startDictation = (ctx: ExtensionContext) => {
    // Model/CLI get an early existence check so the user learns a missing
    // piece before talking (arecord surfaces as an ENOENT on spawn instead).
    const hasModel = existsSync(WHISPER_MODEL);
    if (!hasModel) {
      ctx.ui.notify(`Whisper model not found: ${WHISPER_MODEL}`, "error");
      return;
    }
    const knock = spawnSync(WHISPER_CLI, ["--version"], { stdio: "ignore" });
    if (knock.error || knock.status !== 0) {
      ctx.ui.notify(`whisper-cli not found — install whisper.cpp (${WHISPER_CLI})`, "error");
      return;
    }

    activeCtx = ctx;
    pcmChunks = [];
    cancelled = false;
    state = "recording";
    const myGeneration = ++generation;
    dbg(`start (gen ${myGeneration})`);
    startMeter();

    // Capture 16kHz / 16-bit / mono raw PCM from ALSA to stdout; we buffer it
    // entirely in memory — no audio ever touches disk.
    const devArgs = ARECORD_DEVICE ? ["-D", ARECORD_DEVICE] : [];
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn(
        "arecord",
        [
          "-q",
          "-t", "raw",
          "-f", "S16_LE",
          "-r", String(AUDIO_SAMPLE_RATE),
          "-c", "1",
          ...devArgs,
          "-",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e: any) {
      ctx.ui.notify(`Failed to spawn 'arecord'. Install alsa-utils: sudo apt install alsa-utils`, "error");
      cleanup();
      return;
    }
    rec = proc;

    proc.on("error", (err) => {
      if (myGeneration !== generation) return;
      ctx.ui.notify(`arecord error: ${err.message} (install alsa-utils)`, "error");
      cleanup();
    });

    proc.on("exit", (code) => {
      if (myGeneration !== generation) return; // stale recorder
      if (state === "recording" && code !== null && code !== 0) {
        if (activeCtx) activeCtx.ui.notify(`arecord exited unexpectedly (code ${code})`, "warning");
        cleanup();
      }
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      currentLevel = rmsFromPcm16(chunk);
      pcmChunks.push(chunk);
    });
  };

  /** Stop dictation, transcribe locally, deliver the text. */
  const stopDictation = () => {
    if (state !== "recording") return;
    state = "stopping";
    stopMeter();
    startSpinner("transcribing…");

    // Stop the mic first so no more audio accumulates.
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
    }

    const myGeneration = generation;
    const data = Buffer.concat(pcmChunks);
    pcmChunks = [];
    if (data.length === 0) {
      cleanup();
      if (activeCtx) activeCtx.ui.notify("No audio captured", "warning");
      return;
    }
    const wav = wavFromPcm16(data);
    if (DUMP_WAV) {
      try {
        appendFileSync("/tmp/dictate-dump.wav", wav);
        dbg(`dumped ${data.length} PCM bytes → /tmp/dictate-dump.wav`);
      } catch {}
    }

    // Pipe the in-memory WAV into whisper-cli stdin; nothing is written to disk.
    let proc: ChildProcessWithoutNullStreams;
    const args = ["-m", WHISPER_MODEL, "-f", "-", "-nt", "-of", "-", "-otxt"];
    if (!GPU_ON) args.push("-ng"); // run fully on CPU instead of GPU
    try {
      proc = spawn(WHISPER_CLI, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) {
      if (activeCtx) activeCtx.ui.notify(`whisper-cli failed to spawn: ${e.message}`, "error");
      cleanup();
      return;
    }
    transcribeProc = proc;

    const out: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", () => {}); // swallow progress/noise

    proc.on("error", (e) => {
      if (myGeneration !== generation) return;
      if (activeCtx) activeCtx.ui.notify(`whisper-cli error: ${e.message}`, "error");
      cleanup();
    });

    proc.on("exit", (code) => {
      if (myGeneration !== generation) return; // stale transcription
      const text = Buffer.concat(out).toString().trim();
      if (text) {
        deliverTranscript(text);
      } else if (activeCtx) {
        // Empty transcript: transcribe on silence used to fail silently —
        // surface it instead so mic problems are diagnosable.
        activeCtx.ui.notify(
          code === 0 ? "No speech detected — check the mic (ARECORD_DEVICE)" : `whisper failed (code ${code})`,
          "warning",
        );
      }
      cleanup();
    });

    proc.stdin.end(wav);

    // Safety net: if whisper never exits, force cleanup (delivering whatever
    // came through) and surface a warning.
    stopTimeout = setTimeout(() => {
      if (state !== "stopping") return;
      if (myGeneration !== generation) return;
      const text = Buffer.concat(out).toString().trim();
      if (text) deliverTranscript(text);
      else if (activeCtx) activeCtx.ui.notify("Transcription timed out", "warning");
      cleanup();
    }, STT_TIMEOUT_MS);
  };

  /** Cancel dictation: discard any collected audio and tear everything down immediately. */
  const cancelDictation = () => {
    if (state !== "recording" && state !== "stopping") return;
    cancelled = true;
    pcmChunks = [];
    cleanup();
  };

  /** Toggle dictation, gated on there being somewhere for the text to go. */
  const toggleDictation = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (state === "idle") {
      if (tuiHandle && !resolveTarget()) {
        ctx.ui.notify("No input field is focused — dictation not started", "warning");
        return;
      }
      startDictation(ctx);
    } else if (state === "recording") {
      stopDictation();
    }
    // Ignore presses during the "stopping" state — whisper is transcribing.
  };

  // Global input listener: catches alt+k/alt+n before ANY focused component,
  // which is what makes dictation work inside dialogs. Registered once the
  // TUI handle is captured (see session_start below).
  const onGlobalInput = (data: string) => {
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (matchesKey(data, Key.alt("k"))) {
      dbg(`alt+k (data=${JSON.stringify(data)}) state=${state}`);
      if (lastCtx) toggleDictation(lastCtx);
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("n"))) {
      dbg(`alt+n (data=${JSON.stringify(data)}) state=${state}`);
      cancelDictation();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.mode !== "tui" || tuiHandle) return;
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      tuiHandle = tui;
      removeInputListener = tui.addInputListener(onGlobalInput);
      return { render: () => [], invalidate: () => {} };
    });
  });

  // Shortcut registrations kept as a fallback for contexts where the TUI
  // handle was never captured (non-TUI modes, older pi): they only fire when
  // the main editor is focused, but that's precisely the legacy path. When
  // the listener IS installed it consumes the key first, so no double-fire.
  pi.registerShortcut(Key.alt("k"), {
    description: "Toggle voice dictation (local whisper.cpp)",
    handler: async (ctx) => {
      toggleDictation(ctx);
    },
  });

  // Dedicated cancel binding. Dictation-only — a no-op when no dictation is
  // in flight, so it's safe to hammer without affecting anything else.
  pi.registerShortcut(Key.alt("n"), {
    description: "Cancel voice dictation (discard transcript)",
    handler: async () => {
      cancelDictation();
    },
  });

  pi.on("session_shutdown", () => {
    if (state !== "idle") cleanup();
    removeInputListener?.();
    removeInputListener = null;
  });
}
