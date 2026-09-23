// BB's useVoiceInput, VoiceRecordingBar, and WaveformVisualizer (apps/app
// promptbox): the dictation flow and the strip that replaces the action row.
import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

type VoiceState = "idle" | "recording" | "transcribing";

const MIN_RECORDING_DURATION_MS = 1_000;
const CHUNK_TIMESLICE_MS = 250;
// The plugin's transcribe RPC carries base64 audio, so keep recordings bounded.
const MAX_RECORDING_DURATION_MS = 120_000;
const MAX_RECORDING_BYTES = 5 * 1024 * 1024;
const AUDIO_INPUT_DEVICE_STORAGE_KEY = "bb.voiceInput.audioInputDeviceId";

export function voiceUnsupportedMessage() {
  return typeof window !== "undefined" && window.isSecureContext === false
    ? "Voice input needs an HTTPS connection to this server"
    : "Voice input is not supported in this browser";
}

function preferredAudioInputDeviceId() {
  try {
    const stored = localStorage.getItem(AUDIO_INPUT_DEVICE_STORAGE_KEY);
    return stored && stored.trim() && stored.length <= 1024 ? stored : null;
  } catch {
    return null;
  }
}

function recordingErrorMessage(error: unknown, preferredDevice = false) {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
      case "OverconstrainedError":
        return preferredDevice
          ? "Selected microphone was not found"
          : "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is already in use";
      case "AbortError":
        return "Voice capture was aborted";
      default:
        return "Failed to start voice recording";
    }
  }
  const message =
    error instanceof Error
      ? error.message.replace(/\s+/g, " ").replace(/^(HTTP \d+: )+/, "").trim()
      : "";
  return message || "Voice input failed";
}

function preferredAudioMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    ["audio/webm", "audio/mp4", "audio/ogg"].find((type) =>
      MediaRecorder.isTypeSupported(type),
    ) ?? null
  );
}

/**
 * Records until stopped, then hands the audio to `transcribe`. Cancelling while
 * transcribing drops the result, as in a thread composer.
 */
export function useVoiceInput({
  transcribe,
  onTranscript,
  onError,
  getPromptContext,
}: {
  transcribe: (audio: Blob, promptContext: string | undefined) => Promise<string>;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  getPromptContext?: () => string | undefined;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isSupported, setIsSupported] = useState(false);
  const callbacks = useRef({ transcribe, onTranscript, onError, getPromptContext });
  callbacks.current = { transcribe, onTranscript, onError, getPromptContext };
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shouldTranscribe = useRef(true);
  const transcription = useRef(0);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const alive = useRef(true);
  const starting = useRef(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    if (limitTimer.current) clearTimeout(limitTimer.current);
    limitTimer.current = null;
    void wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
  }, []);

  const fail = useCallback((message: string) => {
    if (!alive.current) return;
    setState("idle");
    callbacks.current.onError(message);
  }, []);

  useEffect(() => {
    alive.current = true;
    setIsSupported(
      Boolean(navigator.mediaDevices?.getUserMedia) &&
        typeof MediaRecorder !== "undefined",
    );
    return () => {
      alive.current = false;
      transcription.current++;
      shouldTranscribe.current = false;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      stopStream();
    };
  }, [stopStream]);

  const start = useCallback(async () => {
    if (state !== "idle" || starting.current || recorderRef.current) return;
    if (!isSupported) {
      fail(voiceUnsupportedMessage());
      return;
    }
    const deviceId = preferredAudioInputDeviceId();
    starting.current = true;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      if (!alive.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = media;
      setStream(media);
      const promptContext = callbacks.current.getPromptContext?.();
      const mimeType = preferredAudioMimeType();
      const recorder = mimeType
        ? new MediaRecorder(media, { mimeType })
        : new MediaRecorder(media);
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      let startedAt = Date.now();
      shouldTranscribe.current = true;
      recorder.onstart = () => {
        startedAt = Date.now();
        setState("recording");
      };
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        stopStream();
        fail("Voice recording failed");
      };
      recorder.onstop = async () => {
        recorderRef.current = null;
        stopStream();
        if (!alive.current) return;
        if (!shouldTranscribe.current) {
          setState("idle");
          return;
        }
        if (Date.now() - startedAt < MIN_RECORDING_DURATION_MS) {
          fail("Recording too short (minimum 1 second)");
          return;
        }
        if (!chunks.length) {
          fail("No audio was captured");
          return;
        }
        const audio = new Blob(chunks, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        if (audio.size > MAX_RECORDING_BYTES) {
          fail("Recording exceeds 5 MB. Try a shorter message.");
          return;
        }
        setState("transcribing");
        const attempt = ++transcription.current;
        try {
          const text = (
            await callbacks.current.transcribe(audio, promptContext)
          )
            .replace(/\s+/g, " ")
            .trim();
          if (attempt !== transcription.current || !alive.current) return;
          if (!text)
            throw new Error("Voice transcription returned an empty result.");
          callbacks.current.onTranscript(text);
          setState("idle");
        } catch (error) {
          if (attempt === transcription.current)
            fail(recordingErrorMessage(error));
        }
      };
      recorder.start(CHUNK_TIMESLICE_MS);
      limitTimer.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, MAX_RECORDING_DURATION_MS);
      if ("wakeLock" in navigator && document.visibilityState === "visible")
        navigator.wakeLock
          .request("screen")
          .then((sentinel) => {
            if (streamRef.current === media) wakeLock.current = sentinel;
            else void sentinel.release().catch(() => {});
          })
          .catch(() => {});
    } catch (error) {
      stopStream();
      recorderRef.current = null;
      fail(recordingErrorMessage(error, deviceId !== null));
    } finally {
      starting.current = false;
    }
  }, [fail, isSupported, state, stopStream]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (state !== "recording" || recorder?.state !== "recording") return;
    shouldTranscribe.current = true;
    recorder.stop();
  }, [state]);

  const cancel = useCallback(() => {
    if (state === "recording") {
      shouldTranscribe.current = false;
      if (recorderRef.current?.state === "recording")
        recorderRef.current.stop();
      return;
    }
    if (state === "transcribing") {
      transcription.current++;
      setState("idle");
    }
  }, [state]);

  return { state, stream, isSupported, start, stop, cancel };
}

const CONTROL_BUTTON_CLASS =
  "size-8 rounded-full p-0 max-md:pointer-coarse:size-10";

export function VoiceRecordingBar({
  state,
  stream,
  onConfirm,
  onCancel,
}: {
  state: "recording" | "transcribing";
  stream: MediaStream | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isTranscribing = state === "transcribing";

  return (
    <div className="flex flex-row items-center gap-2 px-2 py-1.5">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={
          isTranscribing ? "Cancel transcription" : "Cancel recording"
        }
        onClick={onCancel}
        className={CONTROL_BUTTON_CLASS}
      >
        <Icon name="X" className="size-4" />
      </Button>
      <div className="relative flex min-w-0 flex-1 items-center">
        <div
          className={cn("h-7 w-full", isTranscribing && "animate-shine-icon")}
        >
          <WaveformVisualizer stream={stream} active={!isTranscribing} />
        </div>
        <span className="sr-only" aria-live="polite">
          {isTranscribing ? "Transcribing" : "Recording"}
        </span>
      </div>
      <Button
        type="button"
        size="icon"
        variant="default"
        aria-label={
          isTranscribing
            ? "Transcribing voice input"
            : "Stop and transcribe recording"
        }
        disabled={isTranscribing}
        onClick={onConfirm}
        className={CONTROL_BUTTON_CLASS}
      >
        {isTranscribing ? (
          <Icon name="Spinner" className="size-4 animate-spin" />
        ) : (
          <Icon name="Check" className="size-4" />
        )}
      </Button>
    </div>
  );
}

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const BAR_PITCH = BAR_WIDTH + BAR_GAP;
const SAMPLE_EVERY_N_FRAMES = 2;
const NOISE_FLOOR = 0.006;
const AMPLITUDE_GAIN = 8;
const AMPLITUDE_GAMMA = 0.6;
const IDLE_AMPLITUDE = 0.06;

function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === "function" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

function WaveformVisualizer({
  stream,
  active,
}: {
  stream: MediaStream | null;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barsRef = useRef<number[]>([]);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let color = "currentColor";
    let cssWidth = 0;
    let cssHeight = 0;
    let barCount = 1;
    let midY = 0;
    let maxHalf = 0;
    let edgeFade = 0;

    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;
      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      color = getComputedStyle(canvas).color || color;
      ctx.strokeStyle = color;
      ctx.lineCap = "round";
      ctx.lineWidth = BAR_WIDTH;
      midY = cssHeight / 2;
      maxHalf = Math.max(0, (cssHeight * 0.95 - BAR_WIDTH) / 2);
      edgeFade = cssWidth * 0.15;
      barCount = Math.max(1, Math.floor(cssWidth / BAR_PITCH));
      if (barsRef.current.length > barCount) {
        barsRef.current = barsRef.current.slice(
          barsRef.current.length - barCount,
        );
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      const bars = barsRef.current;
      for (let i = 0; i < bars.length; i++) {
        const amp = bars[bars.length - 1 - i]!;
        const cx = cssWidth - BAR_WIDTH / 2 - i * BAR_PITCH;
        if (cx + BAR_WIDTH < 0) break;
        const half = amp * maxHalf;
        ctx.globalAlpha = cx < edgeFade ? Math.max(0.15, cx / edgeFade) : 1;
        ctx.beginPath();
        ctx.moveTo(cx, midY - half);
        ctx.lineTo(cx, midY + half);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const observeResize = (onResize: () => void): ResizeObserver | null => {
      if (typeof ResizeObserver === "undefined") return null;
      const observer = new ResizeObserver(onResize);
      observer.observe(canvas);
      return observer;
    };

    const redrawOnResize = () => {
      measure();
      draw();
    };

    measure();

    const audioTrack = stream?.getAudioTracks()[0] ?? null;
    const canAnimate =
      active &&
      audioTrack !== null &&
      typeof window.AudioContext !== "undefined" &&
      !prefersReducedMotion;

    if (!canAnimate || audioTrack === null) {
      if (barsRef.current.length === 0) {
        barsRef.current = Array.from(
          { length: barCount },
          () => IDLE_AMPLITUDE,
        );
      }
      draw();
      const observer = observeResize(redrawOnResize);
      return () => observer?.disconnect();
    }

    const audioCtx = new AudioContext();
    void audioCtx.resume();
    const analysisTrack = audioTrack.clone();
    const source = audioCtx.createMediaStreamSource(
      new MediaStream([analysisTrack]),
    );
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const timeData = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let rafId = 0;

    const tick = () => {
      if (audioCtx.state === "suspended") void audioCtx.resume();
      if (frame % SAMPLE_EVERY_N_FRAMES === 0) {
        analyser.getByteTimeDomainData(timeData);
        let sumSquares = 0;
        for (let i = 0; i < timeData.length; i++) {
          const centered = (timeData[i]! - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / timeData.length);
        const boosted = Math.max(0, rms - NOISE_FLOOR) * AMPLITUDE_GAIN;
        const amp = Math.min(1, boosted ** AMPLITUDE_GAMMA);
        const bars = barsRef.current;
        bars.push(amp);
        if (bars.length > barCount) bars.shift();
        draw();
      }
      frame++;
      rafId = requestAnimationFrame(tick);
    };

    const observer = observeResize(redrawOnResize);
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      observer?.disconnect();
      source.disconnect();
      analyser.disconnect();
      analysisTrack.stop();
      void audioCtx.close();
    };
  }, [stream, active, prefersReducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="block h-full w-full text-foreground"
    />
  );
}
