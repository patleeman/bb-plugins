// The capture controller: one per browser window, living at module scope so it
// outlives route changes. The app overlay attaches it to RPC and renders it;
// the composer content script and commands drive it.
//
// Durability model:
// - Audio is cut into segments at pauses (segmenter.ts). Each segment is its
//   own MediaRecorder file, so every one is independently decodable.
// - Every MediaRecorder chunk (4s) goes to the IndexedDB outbox at once.
// - The uploader drains the outbox in order; a segment is deleted locally only
//   after the server has it on disk.
// - The active recording is remembered in localStorage. After a reload the
//   controller reopens the microphone and continues the same recording in a
//   new capture session (shown as a paragraph break), and seals and uploads
//   whatever the previous page left in the outbox.
import { toast } from "sonner";
import { useSyncExternalStore } from "react";
import type {
  BbNavigate,
  PluginComposerThreadRowStatus,
  PluginContentScriptContext,
  PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type { Recording, RecordingKind, TalkRpcContract } from "../shared/contract";
import { PANEL_PATH, isEmptyRecording, joinTranscript } from "../shared/format";
import { findComposer, insertIntoComposer, type MicState } from "./composer-dom";
import { Outbox, isOrphan, isPermanentRejection, isUploadable, toBase64, type OutboxKey } from "./outbox";
import {
  FIELD_PENDING_PREFIX,
  findField,
  insertIntoField,
  parseField,
  requestOpenField,
  type FieldRef,
  type TalkStatus,
} from "./fields";
import {
  PENDING_STORAGE_KEY,
  addPending,
  readPending,
  readTimes,
  staleFields,
  withoutPending,
  writePending,
  writeTimes,
} from "./pending-inserts";
import {
  LevelTracker,
  pickMimeType,
  rmsOf,
  segmentPolicy,
  shouldCut,
  tickGap,
  uploadDuration,
  type SegmentPolicy,
} from "./segmenter";

export type Phase =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  /** Capture stopped; uploading what is left in the outbox. */
  | "finalizing"
  /** Dictation only: waiting for the last segments to transcribe. */
  | "transcribing"
  /** The microphone could not be reopened without a user gesture. */
  | "needs-resume";

export interface TalkState {
  phase: Phase;
  recordingId: string | null;
  kind: RecordingKind;
  /** The thread a dictation inserts into; null for the new-thread composer. */
  threadId: string | null;
  /** Another plugin's field a dictation inserts into, instead of a composer. */
  field: FieldRef | null;
  /** Recorded time from finished capture sessions. */
  recordedMs: number;
  /** When the live capture session started, for the running clock. */
  captureStartedAt: number | null;
  /** Segments not yet confirmed by the server. */
  pendingUploads: number;
  uploadError: string | null;
  recording: Recording | null;
  transcript: string;
}

interface Persisted {
  recordingId: string;
  kind: RecordingKind;
  phase: "recording" | "paused" | "finalizing" | "transcribing";
  threadId: string | null;
  field?: FieldRef | null;
  /** Type the transcript into the composer when it is done. */
  insert: boolean;
  composePath?: string | null;
}

interface OpenSegment {
  recorder: MediaRecorder;
  key: OutboxKey;
  startedAt: number;
  /** Recorded time, summed from level ticks so a sleep doesn't count. */
  elapsedMs: number;
  writes: Promise<void>;
  /** Settles once the segment is sealed in the outbox. */
  closed: Promise<void>;
}

interface Capture {
  stream: MediaStream;
  audio: AudioContext;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  sessionId: string;
  nextIndex: number;
  mimeType: string;
  current: OpenSegment | null;
  /** Segments not yet sealed, including one a cut is still closing. */
  open: Set<OpenSegment>;
  tracker: LevelTracker;
  lastTick: number;
  timers: number[];
  wakeLock: WakeLockSentinel | null;
}

const STORAGE_KEY = "bb-plugin-talk:active";
const LOCK_NAME = "bb-plugin-talk-capture";
const CHUNK_MS = 4000;
const HEARTBEAT_MS = 20_000;
const BITRATE = 32_000;

const INITIAL: TalkState = {
  phase: "idle",
  recordingId: null,
  kind: "recording",
  threadId: null,
  field: null,
  recordedMs: 0,
  captureStartedAt: null,
  pendingUploads: 0,
  uploadError: null,
  recording: null,
  transcript: "",
};

type SetThreadRowStatus = NonNullable<PluginContentScriptContext["experimental_setThreadRowStatus"]>;

/** How often a waiting dictation looks for its thread's composer. */
const PENDING_POLL_MS = 700;

function randomId(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

function keyString(key: OutboxKey): string {
  return `${key.recordingId}/${key.sessionId}/${key.index}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A start that a stop cancelled while it waited on the microphone or server. */
class StartCancelled extends Error {
  constructor() {
    super("Talk stopped before it started.");
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export class TalkController {
  private state: TalkState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly outbox = new Outbox();
  private readonly live = new Set<string>();
  private rpc: PluginRpcClient<TalkRpcContract> | null = null;
  private initialized = false;
  private capture: Capture | null = null;
  private policy: SegmentPolicy = segmentPolicy(25);
  private context: { projectId: string | null; threadId: string | null } = { projectId: null, threadId: null };
  private target: WeakRef<HTMLElement> | null = null;
  /** The new-thread composer's page, for a dictation started there. */
  private composePath: string | null = null;
  /** The recording whose page is on screen. */
  private viewing: string | null = null;
  private navigate: BbNavigate | null = null;
  private pendingTimer: number | null = null;
  private pendingComposer: HTMLElement | null = null;
  private fieldsOnScreen = new Set<string>();
  /** Finished captures still transcribing, to report ones discarded as empty. */
  private readonly settling = new Map<string, RecordingKind>();
  private insertOnDone = false;
  private releaseLock: (() => void) | null = null;
  private uploading = false;
  private uploadAgain = false;
  private uploadBackoffMs = 2000;
  private uploadRetry: number | null = null;
  private refreshTimer: number | null = null;
  private restartAttempts = 0;
  /** Bumped by every stop, so a start still in flight backs out. */
  private startEpoch = 0;
  replaceBuiltIn = true;

  // ── Store plumbing for React ─────────────────────────────────────────────
  getState = (): TalkState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Input level 0..1 for a meter; read it on animation frames. */
  level(): number {
    return this.capture?.tracker.level ?? 0;
  }

  private set(patch: Partial<TalkState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  attach(rpc: PluginRpcClient<TalkRpcContract>): void {
    this.rpc = rpc;
    if (this.initialized) return;
    this.initialized = true;
    window.addEventListener("online", () => void this.kickUpload());
    document.addEventListener("visibilitychange", () => void this.onVisible());
    window.addEventListener("pagehide", () => {
      const recorder = this.capture?.current?.recorder;
      if (recorder?.state === "recording") recorder.requestData();
    });
    window.addEventListener("storage", (event) => {
      if (event.key === PENDING_STORAGE_KEY) this.onPendingChanged();
    });
    this.onPendingChanged();
    void this.init();
  }

  configure(options: { segmentSeconds: number; replaceBuiltIn: boolean }): void {
    this.policy = segmentPolicy(options.segmentSeconds);
    if (this.replaceBuiltIn !== options.replaceBuiltIn) {
      this.replaceBuiltIn = options.replaceBuiltIn;
      this.set({});
    }
  }

  setContext(context: { projectId: string | null; threadId: string | null }): void {
    if (context.projectId === this.context.projectId && context.threadId === this.context.threadId) return;
    this.context = context;
    this.set({});
    this.onPendingChanged();
  }

  setNavigator(navigate: BbNavigate): void {
    this.navigate = navigate;
  }

  /** The recording page on screen, or null when it closes. */
  setViewing(recordingId: string | null): void {
    if (this.viewing === recordingId) return;
    this.viewing = recordingId;
    this.set({});
  }

  isDictating(): boolean {
    return this.state.kind === "dictation" && this.state.phase !== "idle";
  }

  isActive(): boolean {
    return this.state.phase !== "idle";
  }

  /** What field owners see on `<html data-bb-talk>`. */
  status(): { status: TalkStatus; field: string | null; phase: Phase } {
    const { phase, field } = this.state;
    if (phase === "idle") return { status: "idle", field: null, phase };
    if (this.isDictating() && field) return { status: "dictating", field: field.key, phase };
    return { status: "busy", field: null, phase };
  }

  // ── Where it started ─────────────────────────────────────────────────────
  /**
   * The composer a dictation types into, when it is on screen. Thread
   * dictations match by thread, since BB can reuse one composer element
   * across threads; new-thread dictations match the composer page.
   */
  private sourceComposer(): HTMLElement | null {
    const { kind, phase, threadId, field } = this.state;
    if (field || kind !== "dictation" || phase === "idle" || this.context.threadId !== threadId) return null;
    const target = this.target?.deref();
    if (target?.isConnected) return target;
    if (threadId === null && location.pathname !== this.composePath) return null;
    const found = findComposer();
    if (found) this.target = new WeakRef(found);
    return found;
  }

  /** Whether the user is looking at the page the capture started from. */
  isAtSource(): boolean {
    const { kind, phase, threadId, recordingId } = this.state;
    if (phase === "idle") return true;
    if (kind === "recording") return this.viewing === recordingId;
    if (this.state.field) return findField(this.state.field.key) !== null;
    if (threadId !== null) return this.context.threadId === threadId;
    return this.sourceComposer() !== null;
  }

  goToSource(): void {
    const { kind, threadId, recordingId, field } = this.state;
    if (kind === "dictation" && field) {
      requestOpenField(field.key);
      return;
    }
    const navigate = this.navigate;
    if (!navigate) return;
    if (kind === "recording") {
      if (recordingId) navigate.toPluginPanel(PANEL_PATH, { subPath: recordingId });
    } else if (threadId !== null) {
      navigate.toThread(threadId);
    } else {
      navigate.toCompose({ focusPrompt: true });
    }
  }

  /** How the composer mic in `promptbox` should look and behave. */
  micState(promptbox: HTMLElement): MicState {
    if (!this.isActive()) return { mode: "idle", title: "Dictate with Talk" };
    if (this.isDictating() && this.isSourceComposer(promptbox)) {
      return { mode: "active", title: "Stop Talk dictation and insert" };
    }
    return { mode: "busy", title: this.busyMessage() };
  }

  private isSourceComposer(promptbox: HTMLElement): boolean {
    const source = this.sourceComposer();
    if (source === promptbox) return true;
    // Another composer in the same thread (BB may remount it) also counts,
    // unless the one the dictation started in is still on screen.
    return source !== null && this.state.threadId !== null && !this.target?.deref()?.isConnected;
  }

  private busyMessage(): string {
    const { kind, threadId, field } = this.state;
    if (kind === "recording") return "Talk is recording. Stop it first.";
    if (field) return `Talk is already dictating into ${field.label}.`;
    return threadId !== null
      ? "Talk is already dictating in another thread."
      : "Talk is already dictating in the new-thread composer.";
  }

  private showBusy(): void {
    toast.error(this.busyMessage(), {
      action: this.navigate ? { label: "Go back", onClick: () => this.goToSource() } : undefined,
    });
  }

  private async init(): Promise<void> {
    try {
      await this.sealOrphans();
    } catch (error) {
      toast.error(`Talk cannot use local storage: ${message(error)}`);
    }
    void this.kickUpload();
    const saved = this.readPersisted();
    if (!saved) return;
    const epoch = this.startEpoch;
    let recording: Recording;
    try {
      recording = (await this.rpc!.call("recording_get", { id: saved.recordingId })).recording;
    } catch {
      // Deleted, or the server is unreachable. The outbox keeps any audio;
      // an unreachable server leaves the saved state for the next load.
      if (navigator.onLine) this.persist(null);
      return;
    }
    this.insertOnDone = saved.insert === true;
    this.composePath = typeof saved.composePath === "string" ? saved.composePath : null;
    this.set({
      recordingId: recording.id,
      kind: saved.kind,
      threadId: saved.threadId,
      field: parseField(saved.field),
      recording,
      recordedMs: recording.durationMs,
      phase: saved.phase === "recording" ? "starting" : saved.phase,
    });
    void this.refresh();
    if (saved.phase === "recording") {
      const locked = await this.acquireLock();
      if (this.cancelled(epoch, locked)) return;
      if (!locked) {
        this.set(INITIAL);
        return;
      }
      try {
        await this.startCapture(epoch);
      } catch (error) {
        if (!(error instanceof StartCancelled)) this.set({ phase: "needs-resume" });
      }
    } else if (saved.phase === "finalizing") {
      void this.finalize();
    } else if (saved.phase === "transcribing") {
      this.pollWhileTranscribing();
    }
  }

  // ── Public actions ───────────────────────────────────────────────────────
  async startRecording(
    kind: RecordingKind,
    promptbox: HTMLElement | null = null,
    field: FieldRef | null = null,
    options: { projectId?: string | null } = {},
  ): Promise<void> {
    if (!this.rpc) throw new Error("Talk is still loading.");
    if (this.state.phase !== "idle") {
      this.showBusy();
      return;
    }
    if (!(await this.acquireLock())) {
      toast.info("Talk is recording in another window.");
      return;
    }
    this.target = promptbox ? new WeakRef(promptbox) : null;
    this.composePath = this.context.threadId === null ? location.pathname : null;
    this.insertOnDone = kind === "dictation";
    // A field dictation belongs to the field, not to the open thread.
    const threadId = field ? null : this.context.threadId;
    this.set({ ...INITIAL, phase: "starting", kind, threadId, field });
    const epoch = this.startEpoch;
    let stream: MediaStream;
    try {
      stream = await this.openMicrophone();
    } catch (error) {
      // A stop while the permission prompt was up already went idle.
      if (epoch !== this.startEpoch) return;
      this.set(INITIAL);
      this.unlock();
      toast.error(`Talk could not open the microphone: ${message(error)}`);
      return;
    }
    let created: string | null = null;
    try {
      if (epoch !== this.startEpoch) throw new StartCancelled();
      const recording = await this.rpc.call("recording_create", {
        kind,
        projectId: options.projectId !== undefined ? options.projectId : this.context.projectId,
        threadId,
      });
      created = recording.id;
      if (epoch !== this.startEpoch) throw new StartCancelled();
      this.set({ recordingId: recording.id, recording });
      this.persistPhase("recording");
      await this.startCapture(epoch, stream);
    } catch (error) {
      stopTracks(stream);
      // Nothing was captured, so do not leave an empty recording behind:
      // finishing a recording with no audio discards it.
      if (created) void this.rpc.call("recording_state", { id: created, status: "finishing" }).catch(() => {});
      // The stop that cancelled the start has already gone idle.
      if (error instanceof StartCancelled) return;
      this.set(INITIAL);
      this.persist(null);
      this.unlock();
      toast.error(`Talk could not start: ${message(error)}`);
    }
  }

  /** Captures more audio into an existing recording, as a new paragraph. */
  async continueRecording(recording: Recording): Promise<void> {
    if (!this.rpc) throw new Error("Talk is still loading.");
    if (this.state.phase !== "idle") {
      this.showBusy();
      return;
    }
    if (!(await this.acquireLock())) {
      toast.info("Talk is recording in another window.");
      return;
    }
    this.target = null;
    this.insertOnDone = false;
    this.set({
      ...INITIAL,
      phase: "starting",
      recordingId: recording.id,
      recording,
      recordedMs: recording.durationMs,
      threadId: recording.threadId,
    });
    try {
      await this.startCapture(this.startEpoch);
      void this.refresh();
    } catch (error) {
      if (error instanceof StartCancelled) return;
      this.set(INITIAL);
      this.persist(null);
      this.unlock();
      toast.error(`Talk could not open the microphone: ${message(error)}`);
    }
  }

  /**
   * The composer mic: start dictating into this composer, or finish. Only the
   * composer the dictation started in finishes it; other mics say where it is.
   */
  async toggleDictation(promptbox: HTMLElement | null): Promise<void> {
    if (this.isActive()) {
      if (this.isDictating() && promptbox && this.isSourceComposer(promptbox)) await this.stop(true);
      else this.showBusy();
      return;
    }
    await this.startRecording("dictation", promptbox);
  }

  /** A field's dictate control: start dictating into it, or finish. */
  async toggleFieldDictation(field: FieldRef): Promise<void> {
    if (this.isActive()) {
      if (this.isDictating() && this.state.field?.key === field.key) await this.stop(true);
      else this.showBusy();
      return;
    }
    await this.startRecording("dictation", null, field);
  }

  async pause(): Promise<void> {
    if (this.state.phase !== "recording") return;
    await this.stopCapture();
    this.set({ phase: "paused" });
    this.persistPhase("paused");
    void this.rpc?.call("recording_state", { id: this.state.recordingId!, status: "paused" }).catch(() => {});
  }

  async resume(): Promise<void> {
    if (this.state.phase !== "paused" && this.state.phase !== "needs-resume") return;
    const epoch = this.startEpoch;
    const locked = await this.acquireLock();
    if (this.cancelled(epoch, locked)) return;
    if (!locked) {
      toast.info("Talk is recording in another window.");
      return;
    }
    this.set({ phase: "starting" });
    try {
      await this.startCapture(epoch);
    } catch (error) {
      if (error instanceof StartCancelled) return;
      this.set({ phase: "needs-resume" });
      toast.error(`Talk could not open the microphone: ${message(error)}`);
    }
  }

  /** Ends capture. A dictation with `insert` types its transcript into the composer when done. */
  async stop(insert = this.state.kind === "dictation"): Promise<void> {
    const { phase } = this.state;
    if (phase !== "recording" && phase !== "paused" && phase !== "needs-resume" && phase !== "starting") return;
    this.insertOnDone = insert && this.state.kind === "dictation";
    // Any start in flight (waiting on the microphone, the server, or a
    // retry) sees this and releases the microphone instead of capturing.
    this.startEpoch++;
    if (phase === "starting" && !this.capture) {
      this.unlock();
      // A new recording that the server hasn't created yet: nothing to finish.
      if (!this.state.recordingId) {
        this.finishIdle();
        return;
      }
    }
    await this.finalize();
  }

  /**
   * Whether a stop arrived since a start began at `epoch`. If so, the lock
   * the start just took is given back.
   */
  private cancelled(epoch: number, locked: boolean): boolean {
    if (epoch === this.startEpoch) return false;
    if (locked) this.unlock();
    return true;
  }

  // ── Capture ──────────────────────────────────────────────────────────────
  private openMicrophone(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(new Error("This browser cannot record audio."));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  }

  /**
   * Opens the microphone (unless given `stream`) and starts capturing. Throws
   * StartCancelled, having released the microphone, if a stop arrived since
   * `epoch`. On any failure the microphone it opened is released.
   */
  private async startCapture(epoch: number, stream?: MediaStream): Promise<void> {
    if (typeof MediaRecorder === "undefined") throw new Error("This browser cannot record audio.");
    if (epoch !== this.startEpoch) throw new StartCancelled();
    const media = stream ?? (await this.openMicrophone());
    let audio: AudioContext | null = null;
    let capture: Capture;
    try {
      if (epoch !== this.startEpoch) throw new StartCancelled();
      audio = new AudioContext();
      void audio.resume().catch(() => {});
      const analyser = audio.createAnalyser();
      analyser.fftSize = 2048;
      audio.createMediaStreamSource(media).connect(analyser);
      capture = {
        stream: media,
        audio,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        sessionId: randomId(),
        nextIndex: 0,
        mimeType: pickMimeType((type) => MediaRecorder.isTypeSupported(type)),
        current: null,
        open: new Set(),
        tracker: new LevelTracker(),
        lastTick: performance.now(),
        timers: [],
        wakeLock: null,
      };
      this.openSegment(capture);
      this.capture = capture;
    } catch (error) {
      stopTracks(media);
      void audio?.close().catch(() => {});
      throw error;
    }
    capture.timers.push(window.setInterval(() => this.tick(capture), 100));
    capture.timers.push(window.setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    for (const track of media.getAudioTracks()) {
      track.addEventListener("ended", () => void this.onTrackEnded(capture), { once: true });
    }
    void this.holdWakeLock(capture);
    this.restartAttempts = 0;
    this.set({ phase: "recording", captureStartedAt: Date.now() });
    this.persistPhase("recording");
    await this.rpc?.call("recording_state", { id: this.state.recordingId!, status: "recording" }).catch(() => {});
  }

  private openSegment(capture: Capture): void {
    const recorder = new MediaRecorder(capture.stream, {
      ...(capture.mimeType ? { mimeType: capture.mimeType } : {}),
      audioBitsPerSecond: BITRATE,
    });
    const key: OutboxKey = {
      recordingId: this.state.recordingId!,
      sessionId: capture.sessionId,
      index: capture.nextIndex++,
    };
    let markClosed!: () => void;
    const segment: OpenSegment = {
      recorder,
      key,
      startedAt: Date.now(),
      elapsedMs: 0,
      closed: new Promise<void>((resolve) => (markClosed = resolve)),
      writes: this.outbox.begin({
        ...key,
        startedAt: Date.now(),
        mimeType: recorder.mimeType || capture.mimeType || "audio/webm",
      }),
    };
    const report = (error: unknown): void => {
      toast.error(`Talk could not save audio locally: ${message(error)}`);
    };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return;
      segment.writes = segment.writes
        .then(() => event.data.arrayBuffer())
        .then((buffer) => this.outbox.appendPart(key, buffer))
        .catch(report);
    });
    recorder.addEventListener("stop", () => {
      const durationMs = segment.elapsedMs;
      segment.writes = segment.writes
        .then(() => this.outbox.complete(key, durationMs))
        .catch(report)
        .finally(() => {
          this.live.delete(keyString(key));
          capture.open.delete(segment);
          markClosed();
          void this.kickUpload();
        });
    });
    this.live.add(keyString(key));
    try {
      recorder.start(CHUNK_MS);
    } catch (error) {
      this.live.delete(keyString(key));
      throw error;
    }
    capture.open.add(segment);
    capture.current = segment;
  }

  /** Adds the time since the last tick to the open segment; returns it. */
  private advance(capture: Capture): number {
    const now = performance.now();
    const dt = tickGap(now - capture.lastTick);
    capture.lastTick = now;
    if (capture.current) capture.current.elapsedMs += dt;
    return dt;
  }

  private tick(capture: Capture): void {
    const dt = this.advance(capture);
    capture.analyser.getFloatTimeDomainData(capture.samples);
    const { quietForMs } = capture.tracker.push(rmsOf(capture.samples), dt);
    const current = capture.current;
    if (current && shouldCut(this.policy, current.elapsedMs, quietForMs)) {
      // Open the next recorder before stopping this one so no audio falls
      // between them; a few milliseconds of overlap is harmless.
      this.openSegment(capture);
      current.recorder.stop();
      capture.tracker.reset();
    }
  }

  /** Closes the open segment and releases the microphone. */
  private async stopCapture(): Promise<void> {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null;
    for (const timer of capture.timers) clearInterval(timer);
    this.advance(capture);
    const current = capture.current;
    if (current && current.recorder.state !== "inactive") current.recorder.stop();
    // Every segment, including one a cut is still closing, is sealed before
    // the lock goes: another window seals unfinished segments once it's free.
    await Promise.all([...capture.open].map((segment) => segment.closed));
    stopTracks(capture.stream);
    void capture.audio.close().catch(() => {});
    void capture.wakeLock?.release().catch(() => {});
    const started = this.state.captureStartedAt;
    this.set({
      captureStartedAt: null,
      recordedMs: this.state.recordedMs + (started ? Date.now() - started : 0),
    });
    this.unlock();
  }

  private async onTrackEnded(capture: Capture): Promise<void> {
    if (this.capture !== capture) return;
    // The device went away (unplugged, taken by a call, app backgrounded on
    // a phone). Keep what was recorded and try to reopen the microphone.
    await this.stopCapture();
    this.set({ phase: "starting" });
    const epoch = this.startEpoch;
    while (this.restartAttempts < 3) {
      this.restartAttempts++;
      await new Promise((resolve) => setTimeout(resolve, 1000 * this.restartAttempts));
      if (epoch !== this.startEpoch) return;
      if (document.visibilityState !== "visible") break;
      try {
        const locked = await this.acquireLock();
        if (this.cancelled(epoch, locked)) return;
        if (!locked) break;
        await this.startCapture(epoch);
        return;
      } catch (error) {
        if (error instanceof StartCancelled) return;
        // try again
      }
    }
    this.set({ phase: "needs-resume" });
  }

  private async onVisible(): Promise<void> {
    if (document.visibilityState !== "visible") return;
    const capture = this.capture;
    if (capture) {
      void this.holdWakeLock(capture);
      if (capture.stream.getAudioTracks().some((track) => track.readyState === "ended")) {
        await this.onTrackEnded(capture);
      }
    } else if (this.state.phase === "needs-resume") {
      await this.resume();
    }
    void this.kickUpload();
  }

  private async holdWakeLock(capture: Capture): Promise<void> {
    try {
      if (document.visibilityState === "visible" && "wakeLock" in navigator) {
        capture.wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch {
      // Optional: some engines refuse without a gesture.
    }
  }

  private async heartbeat(): Promise<void> {
    const id = this.state.recordingId;
    if (!id || !this.rpc) return;
    try {
      const { status } = await this.rpc.call("recording_heartbeat", { id });
      if (status === null) {
        // Deleted from another window while recording.
        await this.stopCapture();
        this.persist(null);
        this.set(INITIAL);
        toast.info("The Talk recording was deleted, so recording stopped.");
      }
    } catch {
      // Offline: the outbox keeps the audio; the server marks the recording
      // interrupted and the next heartbeat takes it back.
    }
  }

  // ── Finishing ────────────────────────────────────────────────────────────
  private async finalize(): Promise<void> {
    await this.stopCapture();
    this.set({ phase: "finalizing" });
    this.persistPhase("finalizing");
    await this.kickUpload();
  }

  /** After the outbox drains: tell the server capture is over. */
  private async maybeFinish(): Promise<void> {
    const id = this.state.recordingId;
    if (this.state.phase !== "finalizing" || !id || !this.rpc) return;
    const waiting = (await this.outbox.all()).some((segment) => segment.recordingId === id && !segment.rejected);
    if (waiting) return;
    const { kind } = this.state;
    let recording: Recording;
    try {
      recording = await this.rpc.call("recording_state", { id, status: "finishing" });
      this.set({ recording });
    } catch (error) {
      this.set({ uploadError: message(error) });
      this.scheduleUpload();
      return;
    }
    if (isEmptyRecording(recording)) {
      // The server discards it; an open recording page says so itself.
      if (kind === "dictation" || this.viewing !== id) this.announceEmpty(kind);
      if (this.state.recordingId === id) this.finishIdle();
    } else if (this.insertOnDone) {
      this.set({ phase: "transcribing" });
      this.persistPhase("transcribing");
      this.pollWhileTranscribing();
    } else {
      if (recording.status === "finishing") this.settling.set(id, kind);
      this.finishIdle();
    }
  }

  private pollWhileTranscribing(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setInterval(() => void this.refresh(), 3000);
    void this.refresh();
  }

  /** Re-reads the active recording; called on realtime signals and polls. */
  async refresh(changedId?: string): Promise<void> {
    if (changedId) void this.checkSettling(changedId);
    const id = this.state.recordingId;
    if (!id || !this.rpc || (changedId && changedId !== id)) return;
    try {
      const { recording, segments } = await this.rpc.call("recording_get", { id });
      if (this.state.recordingId !== id) return;
      this.set({ recording, transcript: joinTranscript(segments) });
      if (this.state.phase === "transcribing" && recording.status === "done") this.deliver();
    } catch (error) {
      if (/No recording/.test(message(error))) {
        // A dictation deleted while transcribing was discarded as empty.
        if (this.state.phase === "transcribing") this.announceEmpty(this.state.kind);
        await this.stopCapture();
        this.finishIdle();
      }
    }
  }

  /**
   * Types a finished dictation into the composer it started in. Away from
   * that thread, the text waits and goes in when the thread is next open.
   */
  private deliver(): void {
    const text = this.state.transcript.trim();
    const { threadId, field } = this.state;
    if (text === "") {
      this.announceEmpty(this.state.kind);
    } else if (field) {
      if (!insertIntoField(field.key, text)) {
        writePending(addPending(readPending(), `${FIELD_PENDING_PREFIX}${field.key}`, text));
        toast.success(`Dictation ready. It goes into ${field.label} when you go back.`, {
          action: { label: "Go back", onClick: () => this.openField(field) },
        });
        this.onPendingChanged();
      }
    } else if (insertIntoComposer(this.sourceComposer(), text)) {
      // Typed where it started.
    } else if (threadId !== null) {
      writePending(addPending(readPending(), threadId, text));
      toast.success("Dictation ready. It goes into the thread's composer when you go back.", {
        action: this.navigate ? { label: "Go back", onClick: () => this.navigate?.toThread(threadId) } : undefined,
      });
      this.onPendingChanged();
    } else {
      void navigator.clipboard?.writeText(text).then(
        () => toast.success("Dictation copied. Paste it into the composer."),
        () => toast.info("Dictation saved in Talk recordings."),
      );
    }
    this.finishIdle();
  }

  /**
   * "Go back" to a field. If its owner is gone, say because the plugin was
   * disabled, the waiting text is copied instead of stranded.
   */
  private openField(field: FieldRef): void {
    if (requestOpenField(field.key)) return;
    const pendingKey = `${FIELD_PENDING_PREFIX}${field.key}`;
    const text = readPending()[pendingKey];
    if (!text) return;
    writePending(withoutPending(readPending(), pendingKey));
    this.onPendingChanged();
    void navigator.clipboard?.writeText(text).then(
      () => toast.info(`Talk couldn't open ${field.label}, so it copied your dictation. Paste it where you need it.`),
      () => toast.info(`Talk couldn't open ${field.label}. Your dictation is in Talk recordings.`),
    );
  }

  /** Reports a finished capture the server discarded once it was transcribed. */
  private async checkSettling(id: string): Promise<void> {
    const kind = this.settling.get(id);
    if (!kind || !this.rpc || id === this.state.recordingId) return;
    try {
      const { recording } = await this.rpc.call("recording_get", { id });
      if (recording.status !== "finishing") this.settling.delete(id);
    } catch (error) {
      if (!/No recording/.test(message(error)) || !this.settling.delete(id)) return;
      // An open recording page says so itself.
      if (this.viewing !== id) this.announceEmpty(kind);
    }
  }

  private announceEmpty(kind: RecordingKind): void {
    toast.info(
      kind === "dictation"
        ? "Talk heard no speech, so it didn't keep the dictation."
        : "Talk heard nothing, so it didn't keep the recording.",
    );
  }

  // ── Dictations waiting for their thread ─────────────────────────────────
  private onPendingChanged(): void {
    const waiting = Object.keys(readPending()).length > 0;
    if (waiting && this.pendingTimer === null) {
      this.pendingTimer = window.setInterval(() => this.flushPending(), PENDING_POLL_MS);
    } else if (!waiting && this.pendingTimer !== null) {
      clearInterval(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.set({});
  }

  /**
   * Types a waiting dictation into the open thread's composer. The composer
   * must be on screen for a full poll first, so BB has restored the thread's
   * own unsent text before Talk adds to it.
   */
  private flushPending(): void {
    this.flushPendingFields();
    const threadId = this.context.threadId;
    const composer = threadId && document.visibilityState === "visible" ? findComposer() : null;
    const settled = composer !== null && composer === this.pendingComposer;
    this.pendingComposer = composer;
    if (!threadId || !settled) return;
    const pending = readPending();
    const text = pending[threadId];
    if (!text) return;
    // Claim it before typing, so a second window on this thread skips it.
    writePending(withoutPending(pending, threadId));
    if (insertIntoComposer(composer, text)) {
      toast.success("Added your dictation to the composer.");
    } else {
      writePending(addPending(readPending(), threadId, text));
    }
    this.onPendingChanged();
  }

  /**
   * Hands waiting dictations to their fields. Like composers, a field must be
   * on screen for a full poll first, so its owner has loaded its content.
   */
  private flushPendingFields(): void {
    this.expirePendingFields();
    const visible = document.visibilityState === "visible";
    const seen = new Set<string>();
    for (const [pendingKey, text] of Object.entries(readPending())) {
      if (!pendingKey.startsWith(FIELD_PENDING_PREFIX)) continue;
      const key = pendingKey.slice(FIELD_PENDING_PREFIX.length);
      if (!visible || !findField(key)) continue;
      seen.add(key);
      if (!this.fieldsOnScreen.has(key)) continue;
      // Claim it before inserting, so a second window skips it.
      writePending(withoutPending(readPending(), pendingKey));
      if (insertIntoField(key, text)) toast.success("Added your dictation.");
      else writePending(addPending(readPending(), pendingKey, text));
      this.onPendingChanged();
    }
    this.fieldsOnScreen = seen;
  }

  /** Drops field dictations whose owner hasn't shown the field for days. */
  private expirePendingFields(): void {
    const pending = readPending();
    const keys = Object.keys(pending).filter((key) => key.startsWith(FIELD_PENDING_PREFIX));
    const before = readTimes();
    const { stale, times } = staleFields(keys, before, Date.now());
    if (JSON.stringify(times) !== JSON.stringify(before)) writeTimes(times);
    if (stale.length === 0) return;
    writePending(stale.reduce(withoutPending, pending));
    toast.info(
      stale.length === 1
        ? "A dictation waited days for a field that never came back, so Talk stopped holding it. It's still in Talk recordings."
        : `${stale.length} dictations waited days for fields that never came back, so Talk stopped holding them. They're still in Talk recordings.`,
    );
    this.onPendingChanged();
  }

  /** Sidebar decorations: where Talk is dictating, and waiting dictations. */
  threadRowStatuses(): Map<string, PluginComposerThreadRowStatus> {
    const statuses = new Map<string, PluginComposerThreadRowStatus>();
    for (const threadId of Object.keys(readPending())) {
      if (threadId.startsWith(FIELD_PENDING_PREFIX)) continue;
      statuses.set(threadId, { icon: "Mic", label: "Talk dictation ready to insert", tone: "success" });
    }
    const { phase, threadId } = this.state;
    if (this.isDictating() && threadId !== null) {
      statuses.set(threadId, {
        icon: "Mic",
        label: phase === "transcribing" ? "Talk is transcribing a dictation" : "Talk is dictating here",
        tone: phase === "paused" || phase === "needs-resume" ? "default" : "running",
      });
    }
    return statuses;
  }

  /** Keeps thread rows decorated until `signal` aborts. */
  decorateThreadRows(setStatus: SetThreadRowStatus, signal: AbortSignal): void {
    let applied = new Map<string, string>();
    const sync = () => {
      const next = new Map<string, string>();
      for (const [threadId, status] of this.threadRowStatuses()) {
        const key = JSON.stringify(status);
        next.set(threadId, key);
        if (applied.get(threadId) !== key) setStatus(threadId, status);
      }
      for (const threadId of applied.keys()) if (!next.has(threadId)) setStatus(threadId, null);
      applied = next;
    };
    const unsubscribe = this.subscribe(sync);
    sync();
    signal.addEventListener("abort", unsubscribe, { once: true });
  }

  private finishIdle(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.target = null;
    this.composePath = null;
    this.insertOnDone = false;
    this.persist(null);
    this.set({ ...INITIAL, pendingUploads: this.state.pendingUploads });
  }

  /** Stops waiting for a dictation's transcript; it stays in recordings. */
  dismiss(): void {
    if (this.state.phase === "transcribing") this.finishIdle();
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  async kickUpload(): Promise<void> {
    if (this.uploading) {
      this.uploadAgain = true;
      return;
    }
    this.uploading = true;
    try {
      do {
        this.uploadAgain = false;
        await this.drain();
      } while (this.uploadAgain);
    } finally {
      this.uploading = false;
    }
  }

  private async drain(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    let segments = (await this.outbox.all().catch(() => [])).filter((s) => !s.rejected);
    for (const segment of segments.filter(isUploadable)) {
      this.set({ pendingUploads: segments.length });
      try {
        await rpc.call("segment_put", {
          recordingId: segment.recordingId,
          sessionId: segment.sessionId,
          index: segment.index,
          startedAt: segment.startedAt,
          durationMs: uploadDuration(segment.durationMs),
          mimeType: segment.mimeType,
          audioBase64: toBase64(segment.parts),
        });
      } catch (error) {
        if (isPermanentRejection(error)) {
          // Retrying can't help, and would hold up every segment behind it.
          // Keep the audio locally, set aside, and move on.
          console.warn(`Talk set aside a segment the server refused: ${message(error)}`, segment);
          toast.error(`Talk couldn't upload part of a recording and kept it on this device: ${message(error)}`);
          await this.outbox.reject(segment, message(error));
          segments = segments.filter((s) => s !== segment);
          continue;
        }
        if (!/No recording/.test(message(error))) {
          this.set({ uploadError: message(error) });
          this.scheduleUpload();
          return;
        }
        // The recording was deleted: its audio has nowhere to go.
      }
      await this.outbox.remove(segment);
      segments = segments.filter((s) => s !== segment);
    }
    this.uploadBackoffMs = 2000;
    this.set({ pendingUploads: segments.length, uploadError: null });
    await this.maybeFinish();
  }

  private scheduleUpload(): void {
    if (this.uploadRetry !== null) return;
    const delay = this.uploadBackoffMs;
    this.uploadBackoffMs = Math.min(60_000, this.uploadBackoffMs * 2);
    this.uploadRetry = window.setTimeout(() => {
      this.uploadRetry = null;
      void this.kickUpload();
    }, delay);
  }

  // ── Persistence and cross-window lock ───────────────────────────────────
  private readPersisted(): Persisted | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const value = raw ? (JSON.parse(raw) as Partial<Persisted>) : null;
      return value && typeof value.recordingId === "string" && typeof value.phase === "string"
        ? (value as Persisted)
        : null;
    } catch {
      return null;
    }
  }

  private persist(value: Persisted | null): void {
    try {
      if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode: the recording still works, it just will not resume.
    }
  }

  private persistPhase(phase: Persisted["phase"]): void {
    const { recordingId, kind, threadId, field } = this.state;
    if (recordingId) {
      this.persist({ recordingId, kind, phase, threadId, field, insert: this.insertOnDone, composePath: this.composePath });
    }
  }

  /**
   * Seals segments a closed or crashed page left open. Another window's live
   * segments are left alone: only the window holding the capture lock
   * records, so they are orphans only while the lock is free (or ours).
   */
  private async sealOrphans(): Promise<void> {
    const seal = (lockFree: boolean | null) =>
      this.outbox.sealOrphans((segment) =>
        isOrphan(segment, this.live.has(keyString(segment)), lockFree, Date.now()),
      );
    if (this.releaseLock) {
      await seal(true);
    } else if (!navigator.locks) {
      await seal(null);
    } else {
      await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => seal(lock !== null));
    }
  }

  /** Only one window captures at a time; the lock is held while capturing. */
  private acquireLock(): Promise<boolean> {
    if (this.releaseLock) return Promise.resolve(true);
    if (!navigator.locks) return Promise.resolve(true);
    return new Promise((resolve) => {
      void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return null;
        }
        resolve(true);
        return new Promise<void>((release) => {
          this.releaseLock = release;
        });
      });
    });
  }

  private unlock(): void {
    this.releaseLock?.();
    this.releaseLock = null;
  }
}

export const talk = new TalkController();

export function useTalkState(): TalkState {
  return useSyncExternalStore(talk.subscribe, talk.getState);
}
