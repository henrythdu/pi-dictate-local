/**
 * dictate — minimal voice dictation for pi.
 *
 * Press ctrl+shift+m to start, press it again to stop.
 * Press ctrl+shift+n to cancel and discard the in-flight transcript.
 * On stop, the finalized transcript is appended to the pi input editor.
 *
 * Requires:
 *   - sox installed (`brew install sox` — provides the `rec` command)
 *   - DEEPGRAM_API_KEY environment variable set
 *
 * Streaming model: audio is sent to Deepgram while you talk; the server
 * transcribes in real time and emits per-utterance "final" results. We
 * collect those finals and inject the concatenated text on stop. No
 * partials are shown in the editor (cosmetic-only), so quality is good
 * and the editor never shows revisable text.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// Deepgram streaming endpoint. Tuning notes:
//   model=nova-3        — flagship, sub-300ms latency, best accuracy
//   encoding=linear16   — raw 16-bit PCM (what sox/rec gives us with -e signed-integer -b 16)
//   sample_rate=16000   — 16kHz mono is the standard low-bandwidth STT format
//   interim_results=false — we only want finals, never partials
//   smart_format=true   — formats numbers, dates, currencies nicely
//   punctuate=true      — adds commas/periods/question marks
//   endpointing=300     — 300ms of silence ends an utterance (faster finals)
const DG_URL =
  "wss://api.deepgram.com/v1/listen" +
  "?model=nova-3" +
  "&encoding=linear16" +
  "&sample_rate=16000" +
  "&channels=1" +
  "&interim_results=false" +
  "&smart_format=true" +
  "&punctuate=true" +
  "&endpointing=300";

type State = "idle" | "recording" | "stopping";

// Same braille frames pi-tui's Loader uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Audio meter — a tiny rolling waveform rendered in the status row while recording.
// Tweakable knobs:
//   METER_CELLS       = how many bars wide
//   METER_TICK_MS     = how often bars shift left (smaller = snappier, more renders)
//   METER_FLOOR_DB    = level at which the bar is empty (more negative = more sensitive)
//   METER_CEILING_DB  = level at which the bar is full (less negative = needs louder to peg)
const METER_CELLS = 6;
const METER_TICK_MS = 60;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
// const PEAK_BLOCKS = ["⠀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];
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

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let rec: ChildProcessWithoutNullStreams | null = null;
  let ws: WebSocket | null = null;
  let finals: string[] = [];
  let activeCtx: ExtensionContext | null = null;
  let flushed = false;
  let cancelled = false;
  let stopTimeout: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  // Audio meter state. `meter` is a ring of recent RMS values, newest at
  // index METER_CELLS-1. `currentLevel` is the most recent RMS observed from
  // any audio chunk — the meter tick just samples it. Crucially we never reset
  // it: empty ticks re-render the last observed value, so the bars never drop
  // to silence just because no chunk happened to arrive in that 60ms window.
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
    const render = () => setStatus(`🔴 ${meter.map(rmsToBlock).join("")} listening…`);
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

  const flush = () => {
    if (flushed || !activeCtx) return;
    flushed = true;
    if (cancelled) return; // discard transcript on cancel
    const text = finals.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    const current = activeCtx.ui.getEditorText() ?? "";
    const sep = current && !/\s$/.test(current) ? " " : "";
    activeCtx.ui.setEditorText(current + sep + text);
  };

  const cleanup = () => {
    flush();
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
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {}
      ws = null;
    }
    finals = [];
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
    flushed = false;
    cancelled = false;
  };

  const startDictation = (ctx: ExtensionContext) => {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      ctx.ui.notify("DEEPGRAM_API_KEY not set in environment", "error");
      return;
    }

    activeCtx = ctx;
    finals = [];
    flushed = false;
    cancelled = false;
    state = "recording";
    startMeter();

    // Spawn sox `rec` to capture 16kHz / 16-bit / mono PCM to stdout.
    try {
      rec = spawn(
        "rec",
        [
          "-q", // quiet
          // Shrink sox's IO buffer so stdout flushes ~every 16ms instead of
          // the default ~256ms. 512 bytes = 256 samples = 16ms at 16kHz/16-bit
          // mono. This is the dominant source of meter latency.
          "--buffer", "512",
          "-r", "16000",
          "-c", "1",
          "-b", "16",
          "-e", "signed-integer",
          "-t", "raw",
          "-", // stdout
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e: any) {
      ctx.ui.notify(`Failed to spawn 'rec'. Install sox: brew install sox`, "error");
      cleanup();
      return;
    }

    rec.on("error", (err) => {
      ctx.ui.notify(`rec error: ${err.message} (install sox: brew install sox)`, "error");
      cleanup();
    });

    rec.on("exit", (code) => {
      // Natural exit on SIGTERM during stopDictation is fine. Anything else
      // mid-recording is a problem.
      if (state === "recording" && code !== null && code !== 0) {
        if (activeCtx) {
          activeCtx.ui.notify(`rec exited unexpectedly (code ${code})`, "warn");
        }
        cleanup();
      }
    });

    // Open Deepgram WebSocket. Auth via subprotocol (portable across Node native
    // WebSocket and browsers): `new WebSocket(url, ["token", API_KEY])`.
    try {
      ws = new WebSocket(DG_URL, ["token", apiKey]);
    } catch (e: any) {
      ctx.ui.notify(`Deepgram WS failed: ${e.message}`, "error");
      cleanup();
      return;
    }

    ws.addEventListener("open", () => {
      if (!rec || !ws) return;
      rec.stdout.on("data", (chunk: Buffer) => {
        // Track loudness for the meter (just the latest chunk's RMS — the meter
        // tick samples this), then forward to Deepgram.
        currentLevel = rmsFromPcm16(chunk);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "Results" && msg.is_final) {
          const t = msg.channel?.alternatives?.[0]?.transcript;
          if (t) finals.push(t);
        }
        // We could also handle msg.type === "Metadata" (sent after CloseStream
        // finishes draining), but ws.close handles the same flush path.
      } catch {
        // ignore non-JSON frames
      }
    });

    ws.addEventListener("error", () => {
      if (activeCtx) activeCtx.ui.notify("Deepgram WebSocket error", "error");
      cleanup();
    });

    ws.addEventListener("close", () => {
      // Server-initiated close (or our own close in cleanup): finalize.
      if (state === "recording" || state === "stopping") {
        cleanup();
      }
    });
  };

  /** Stop dictation, finalize transcript, append to editor. */
  const stopDictation = () => {
    if (state !== "recording") return;
    state = "stopping";
    stopMeter();
    startSpinner("finalizing…");

    // Stop the mic first so no more audio enqueues.
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
    }

    // Tell Deepgram we're done; it will flush remaining finals then close.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        cleanup();
        return;
      }
      // Safety net: if Deepgram never closes the socket, force cleanup after 3s.
      stopTimeout = setTimeout(() => {
        if (state === "stopping") cleanup();
      }, 3000);
    } else {
      cleanup();
    }
  };

  /** Cancel dictation: discard any collected transcript and tear everything down immediately. */
  const cancelDictation = () => {
    if (state !== "recording" && state !== "stopping") return;
    cancelled = true;
    finals = [];
    // No need to wait for Deepgram to flush — we're throwing the result away.
    cleanup();
  };

  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Toggle voice dictation (Deepgram)",
    handler: async (ctx) => {
      if (state === "idle") {
        startDictation(ctx);
      } else if (state === "recording") {
        stopDictation();
      }
      // Ignore presses during the "stopping" state — Deepgram is finalizing.
    },
  });

  // Dedicated cancel binding. Dictation-only — a no-op when no dictation is
  // in flight, so it's safe to hammer without affecting anything else.
  pi.registerShortcut(Key.ctrlShift("n"), {
    description: "Cancel voice dictation (discard transcript)",
    handler: async () => {
      cancelDictation();
    },
  });

  pi.on("session_shutdown", () => {
    if (state !== "idle") cleanup();
  });
}
