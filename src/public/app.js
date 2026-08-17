import {
  buildDisplayMediaOptions,
  buildMicrophoneMediaOptions,
} from "/capture-options.js";
import { getSessionRefreshDelay } from "/session-timing.js";

const TRANSLATION_CALL_URL =
  "https://api.openai.com/v1/realtime/translations/calls";

const OUTPUT_TRANSCRIPT_EVENTS = new Set(["session.output_transcript.delta"]);
const INPUT_TRANSCRIPT_EVENTS = new Set(["session.input_transcript.delta"]);
const MAX_LOG_ENTRIES = 500;

const AUDIO_SOURCES = {
  tab: {
    buttonLabel: "Choose event tab",
    capturePrompt: "Pick a browser tab with audio",
    translatingStatus: "Translating tab audio",
    endedStatus: "Tab audio sharing ended",
    meterLabel: "Captured tab audio",
    guide: "For tab audio, pick a browser tab and enable audio sharing.",
  },
  microphone: {
    buttonLabel: "Use microphone",
    capturePrompt: "Allow microphone access",
    translatingStatus: "Translating microphone audio",
    endedStatus: "Microphone capture ended",
    meterLabel: "Captured microphone audio",
    guide: "For microphone audio, allow access when your browser asks.",
  },
};

const captureSource = document.querySelector("#captureSource");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const sessionCount = document.querySelector("#sessionCount");
const accountName = document.querySelector("#accountName");
const logoutButton = document.querySelector("#logoutButton");
const inputMeter = document.querySelector("#inputMeter");
const inputMeterLabel = document.querySelector("#inputMeterLabel");
const captureGuide = document.querySelector("#captureGuide");
const queueProgress = document.querySelector("#queueProgress");
const translatedTranscript = document.querySelector("#translatedTranscript");
const eventLogToggle = document.querySelector("#eventLogToggle");
const eventLogPanel = document.querySelector("#eventLogPanel");
const eventLog = document.querySelector("#eventLog");
const captureState = document.querySelector("#captureState");
const chunksSent = document.querySelector("#chunksSent");
const activeInputFrames = document.querySelector("#activeInputFrames");
const peakInputLevel = document.querySelector("#peakInputLevel");
const outputAudioDeltas = document.querySelector("#outputAudioDeltas");
const transcriptDeltas = document.querySelector("#transcriptDeltas");
const lastEventType = document.querySelector("#lastEventType");

let peerConnection = null;
let dataChannel = null;
let captureStream = null;
let meterContext = null;
let meterSource = null;
let meterAnalyser = null;
let meterTimer = null;
let diagnostics = createEmptyDiagnostics();
let sessionNumber = 0;
let sessionRefreshTimer = null;
let reconnectTimer = null;
let disconnectRecoveryTimer = null;
let reconnectDelayMs = 1000;
let sessionRecoveryInProgress = false;
let authState = {
  authenticated: true,
  enabled: false,
  username: null,
};

startButton.disabled = true;
stopButton.disabled = true;
captureSource.disabled = true;
logoutButton.disabled = true;
setEventLogExpanded(false);
updateCaptureSourceUi();

logoutButton.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/";
});

eventLogToggle.addEventListener("click", () => {
  setEventLogExpanded(eventLogPanel.hidden);
});

captureSource.addEventListener("change", updateCaptureSourceUi);

startButton.addEventListener("click", async () => {
  const source = getSelectedAudioSource();
  beginSession();
  setControls({ running: true });
  setStatus(source.capturePrompt, "idle");

  try {
    activeMeetingReset();
    const capturePromise = captureAudio(captureSource.value);
    const sessionPromise = createSession();
    const [captureResult, sessionResult] = await Promise.allSettled([
      capturePromise,
      sessionPromise,
    ]);

    if (
      captureResult.status === "rejected" ||
      sessionResult.status === "rejected"
    ) {
      if (captureResult.status === "fulfilled") {
        captureResult.value.getTracks().forEach((track) => track.stop());
      }
      throw captureResult.status === "rejected"
        ? captureResult.reason
        : sessionResult.reason;
    }

    captureStream = captureResult.value;
    const session = sessionResult.value;
    startInputMeter(captureStream);
    scheduleSessionRefresh(session.expires_at);

    setStatus("Connecting WebRTC", "idle");
    await connectRealtimeTranslation(session, captureStream);

    setStatus(source.translatingStatus, "live");
  } catch (error) {
    logEvent("error", error instanceof Error ? error.message : String(error));
    await stop("Stopped after startup error", "error");
    if (error instanceof Error && /authentication required/i.test(error.message)) {
      location.href = "/";
    }
  }
});

stopButton.addEventListener("click", async () => {
  await stop("Stopped", "idle");
});

async function createSession() {
  const response = await fetch("/session", {
    method: "POST",
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Authentication required.");
    }
    throw new Error(getSessionErrorMessage(body));
  }

  return body;
}

function getSessionErrorMessage(body) {
  const openAIMessage = body?.details?.error?.message;
  if (typeof openAIMessage === "string" && openAIMessage) {
    return openAIMessage;
  }
  if (typeof body?.details === "string" && body.details) {
    return body.details;
  }
  return body?.error ?? "Failed to create session.";
}

async function createRealtimeSession() {
  const session = await createSession();
  scheduleSessionRefresh(session.expires_at);
  return session;
}

async function connectRealtimeTranslation(session, stream) {
  const connection = new RTCPeerConnection();
  const channel = connection.createDataChannel("oai-events");
  peerConnection = connection;
  dataChannel = channel;

  connection.onconnectionstatechange = () => {
    if (peerConnection !== connection) {
      return;
    }
    diagnostics.connectionState = connection.connectionState;
    chunksSent.textContent = diagnostics.connectionState;
    logEvent("webrtc.connection", diagnostics.connectionState);
    updateDiagnostics();
    if (diagnostics.connectionState === "failed") {
      clearDisconnectRecoveryTimer();
      void scheduleConnectionRecovery("WebRTC connection lost");
    } else if (diagnostics.connectionState === "disconnected") {
      scheduleDisconnectRecovery();
    } else if (diagnostics.connectionState === "connected") {
      clearDisconnectRecoveryTimer();
    }
  };

  connection.oniceconnectionstatechange = () => {
    if (peerConnection !== connection) {
      return;
    }
    diagnostics.iceConnectionState = connection.iceConnectionState;
    queueProgress.value =
      diagnostics.iceConnectionState === "connected" ||
      diagnostics.iceConnectionState === "completed"
        ? 1
        : 0;
    updateDiagnostics();
  };

  connection.ontrack = () => {
    if (peerConnection !== connection) {
      return;
    }
    diagnostics.remoteAudioTracks += 1;
    outputAudioDeltas.textContent = String(diagnostics.remoteAudioTracks);
    logEvent("remote.audio", "track received");
    updateDiagnostics();
  };

  channel.onopen = () => {
    if (dataChannel !== channel) {
      return;
    }
    diagnostics.dataChannelState = channel.readyState;
    activeInputFrames.textContent = diagnostics.dataChannelState;
    logEvent("datachannel.open", "ok");
    updateDiagnostics();
  };
  channel.onclose = () => {
    if (dataChannel !== channel) {
      return;
    }
    diagnostics.dataChannelState = "closed";
    activeInputFrames.textContent = "closed";
    logEvent("datachannel.close", "closed");
    updateDiagnostics();
  };
  channel.onerror = () => {
    logEvent("datachannel.error", "error");
  };
  channel.onmessage = handleRealtimeEvent;

  for (const track of stream.getAudioTracks()) {
    connection.addTrack(track, stream);
  }

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);

  const sdpResponse = await fetch(TRANSLATION_CALL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.client_secret}`,
      "Content-Type": "application/sdp",
    },
    body: offer.sdp,
  });

  const answerSdp = await sdpResponse.text();
  if (!sdpResponse.ok) {
    throw new Error(answerSdp);
  }

  await connection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });

  logEvent("webrtc.offer", `connected -> ${session.targetLanguage}`);
}

async function captureTabAudio() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser does not support tab audio capture.");
  }

  const supportedConstraints =
    navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const stream = await navigator.mediaDevices.getDisplayMedia(
    buildDisplayMediaOptions(supportedConstraints),
  );

  const audioTracks = stream.getAudioTracks();
  const videoTracks = stream.getVideoTracks();

  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("No tab audio was shared. Pick a Chrome tab and enable tab audio.");
  }

  audioTracks[0].addEventListener(
    "ended",
    () => {
      void stop("Tab audio sharing ended", "idle");
    },
    { once: true },
  );

  const audioSettings = audioTracks[0].getSettings?.() ?? {};
  const suppressed =
    typeof audioSettings.suppressLocalAudioPlayback === "boolean"
      ? String(audioSettings.suppressLocalAudioPlayback)
      : "unknown";
  captureState.textContent = `audio=${audioTracks[0].readyState}, video=${videoTracks.length}, suppressed=${suppressed}`;
  logEvent(
    "capture.started",
    `audio tracks=${audioTracks.length}, video tracks=${videoTracks.length}, suppressed=${suppressed}`,
  );

  return stream;
}

async function captureMicrophoneAudio() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support microphone capture.");
  }

  const supportedConstraints =
    navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const stream = await navigator.mediaDevices.getUserMedia(
    buildMicrophoneMediaOptions(supportedConstraints),
  );
  const audioTracks = stream.getAudioTracks();

  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("No microphone audio track is available.");
  }

  audioTracks[0].addEventListener(
    "ended",
    () => {
      void stop(AUDIO_SOURCES.microphone.endedStatus, "idle");
    },
    { once: true },
  );

  const settings = audioTracks[0].getSettings?.() ?? {};
  const deviceLabel = audioTracks[0].label || "default microphone";
  captureState.textContent = `microphone=${audioTracks[0].readyState}, channels=${settings.channelCount ?? "unknown"}`;
  logEvent(
    "capture.started",
    `source=microphone, device=${deviceLabel}, channels=${settings.channelCount ?? "unknown"}`,
  );

  return stream;
}

async function captureAudio(source) {
  if (source === "microphone") {
    return captureMicrophoneAudio();
  }
  return captureTabAudio();
}

function startInputMeter(stream) {
  meterContext = new AudioContext();
  meterSource = meterContext.createMediaStreamSource(stream);
  meterAnalyser = meterContext.createAnalyser();
  meterAnalyser.fftSize = 2048;
  meterSource.connect(meterAnalyser);

  const samples = new Float32Array(meterAnalyser.fftSize);
  meterTimer = window.setInterval(() => {
    meterAnalyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples.length);
    inputMeter.value = Math.min(1, rms * 12);
    diagnostics.peakInputLevel = Math.max(diagnostics.peakInputLevel, rms);
    peakInputLevel.textContent = diagnostics.peakInputLevel.toFixed(3);
  }, 100);
}

function handleRealtimeEvent(message) {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    logEvent("message", "Received non-JSON data channel message.");
    return;
  }

  diagnostics.lastEventType = event.type;
  lastEventType.textContent = event.type;

  if (event.type === "error") {
    logEvent("error", JSON.stringify(event.error ?? event));
    return;
  }

  if (OUTPUT_TRANSCRIPT_EVENTS.has(event.type) && typeof event.delta === "string") {
    diagnostics.transcriptDeltas += 1;
    appendTranslatedText(event.delta);
    updateDiagnostics();
    return;
  }

  if (INPUT_TRANSCRIPT_EVENTS.has(event.type) && typeof event.delta === "string") {
    logEvent("input", event.delta);
    return;
  }

  if (
    event.type === "session.created" ||
    event.type === "session.updated" ||
    event.type === "output_audio_buffer.started"
  ) {
    logEvent(event.type, "ok");
  }

  updateDiagnostics();
}

async function stop(message, state = "idle") {
  activeMeetingReset();
  if (meterTimer) {
    window.clearInterval(meterTimer);
    meterTimer = null;
  }

  meterSource?.disconnect();
  meterAnalyser?.disconnect();
  meterSource = null;
  meterAnalyser = null;

  if (meterContext?.state !== "closed") {
    await meterContext?.close();
  }
  meterContext = null;

  closeRealtimeConnection();

  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = null;

  inputMeter.value = 0;
  queueProgress.value = 0;
  setControls({ running: false });
  setStatus(message, state);
}

function setControls({ running }) {
  startButton.disabled = running || !authState.authenticated;
  stopButton.disabled = !running;
  captureSource.disabled = running || !authState.authenticated;
  logoutButton.disabled = !authState.authenticated || !authState.enabled;
}

function getSelectedAudioSource() {
  return AUDIO_SOURCES[captureSource.value] ?? AUDIO_SOURCES.tab;
}

function updateCaptureSourceUi() {
  const source = getSelectedAudioSource();
  startButton.textContent = source.buttonLabel;
  inputMeterLabel.textContent = source.meterLabel;
  captureGuide.textContent = source.guide;
}

function setStatus(message, state) {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "live" ? "live" : ""} ${
    state === "error" ? "error" : ""
  }`;
}

function appendTranslatedText(text) {
  translatedTranscript.append(document.createTextNode(text));
  translatedTranscript.scrollTop = translatedTranscript.scrollHeight;
}

function clearTranscript() {
  translatedTranscript.textContent = "";
}

function createEmptyDiagnostics() {
  return {
    connectionState: "new",
    dataChannelState: "connecting",
    iceConnectionState: "new",
    lastEventType: "none",
    peakInputLevel: 0,
    remoteAudioTracks: 0,
    transcriptDeltas: 0,
  };
}

function resetDiagnostics() {
  diagnostics = createEmptyDiagnostics();
  captureState.textContent = "Starting";
  eventLog.textContent = "";
  if (!eventLogPanel.hidden) {
    eventLog.scrollTop = eventLog.scrollHeight;
  }
  updateDiagnostics();
}

function beginSession() {
  sessionNumber += 1;
  sessionCount.textContent = `Session ${sessionNumber}`;
  clearTranscript();
  resetDiagnostics();
}

function activeMeetingReset() {
  clearSessionRefreshTimer();
  clearReconnectTimer();
  clearDisconnectRecoveryTimer();
  sessionRecoveryInProgress = false;
  reconnectDelayMs = 1000;
}

async function syncAuthState() {
  try {
    const response = await fetch("/auth/status");
    const body = await response.json();
    authState = {
      authenticated: Boolean(body.authenticated),
      enabled: Boolean(body.enabled),
      username: body.username ?? null,
    };
  } catch {
    authState = {
      authenticated: false,
      enabled: false,
      username: null,
    };
  }

  if (!authState.authenticated) {
    accountName.textContent = "Sign in required";
    logoutButton.hidden = true;
    startButton.disabled = true;
    stopButton.disabled = true;
    captureSource.disabled = true;
    logoutButton.disabled = true;
    return;
  }

  logoutButton.hidden = !authState.enabled;
  accountName.textContent = authState.enabled
    ? `Signed in as ${authState.username ?? "internal user"}`
    : "Auth disabled";
  setControls({ running: false });
}

function scheduleSessionRefresh(expiresAt) {
  clearSessionRefreshTimer();
  const refreshDelayMs = getSessionRefreshDelay(expiresAt);
  if (refreshDelayMs === null) {
    return;
  }

  sessionRefreshTimer = window.setTimeout(() => {
    sessionRefreshTimer = null;
    void scheduleConnectionRecovery("Session expiring");
  }, refreshDelayMs);
}

async function scheduleConnectionRecovery(reason) {
  if (!captureStream || !authState.authenticated || sessionRecoveryInProgress || !peerConnection) {
    return;
  }

  if (reconnectTimer) {
    return;
  }

  sessionRecoveryInProgress = true;
  clearSessionRefreshTimer();
  try {
    logEvent("reconnect", `${reason}; retrying now`);
    setStatus("Reconnecting session", "idle");
    closeRealtimeConnection();
    const session = await createRealtimeSession();
    if (!captureStream) {
      return;
    }
    await connectRealtimeTranslation(session, captureStream);
    setStatus(getSelectedAudioSource().translatingStatus, "live");
    reconnectDelayMs = 1000;
    logEvent("reconnect", "Session restored");
  } catch (error) {
    closeRealtimeConnection();
    const detail = error instanceof Error ? error.message : String(error);
    logEvent("error", detail);
    scheduleReconnectRetry(reason);
  } finally {
    sessionRecoveryInProgress = false;
  }
}

function scheduleReconnectRetry(reason) {
  if (!captureStream || !activeMeetingRunning()) {
    return;
  }

  clearReconnectTimer();
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  logEvent("reconnect", `${reason}; retry in ${Math.round(delay / 1000)}s`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void scheduleConnectionRecovery(reason);
  }, delay);
}

function clearSessionRefreshTimer() {
  if (sessionRefreshTimer) {
    window.clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleDisconnectRecovery() {
  if (disconnectRecoveryTimer) {
    return;
  }

  disconnectRecoveryTimer = window.setTimeout(() => {
    disconnectRecoveryTimer = null;
    if (peerConnection?.connectionState === "disconnected") {
      void scheduleConnectionRecovery("WebRTC connection lost");
    }
  }, 3_000);
}

function clearDisconnectRecoveryTimer() {
  if (disconnectRecoveryTimer) {
    window.clearTimeout(disconnectRecoveryTimer);
    disconnectRecoveryTimer = null;
  }
}

function closeRealtimeConnection() {
  const channel = dataChannel;
  const connection = peerConnection;
  dataChannel = null;
  peerConnection = null;
  channel?.close();
  connection?.close();
}

function activeMeetingRunning() {
  return Boolean(captureStream && startButton.disabled && !stopButton.disabled);
}

function updateDiagnostics() {
  chunksSent.textContent = diagnostics.connectionState;
  activeInputFrames.textContent = diagnostics.dataChannelState;
  peakInputLevel.textContent = diagnostics.peakInputLevel.toFixed(3);
  outputAudioDeltas.textContent = String(diagnostics.remoteAudioTracks);
  transcriptDeltas.textContent = String(diagnostics.transcriptDeltas);
  lastEventType.textContent = diagnostics.lastEventType;
}

function logEvent(type, detail) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${type}: ${detail}`;
  eventLog.append(entry);
  while (eventLog.childElementCount > MAX_LOG_ENTRIES) {
    eventLog.firstElementChild?.remove();
  }
  if (!eventLogPanel.hidden) {
    eventLog.scrollTop = eventLog.scrollHeight;
  }
}

function setEventLogExpanded(expanded) {
  eventLogPanel.hidden = !expanded;
  eventLogToggle.setAttribute("aria-expanded", String(expanded));
  eventLogToggle.textContent = expanded ? "Hide debug log" : "Show debug log";
}

void syncAuthState();
