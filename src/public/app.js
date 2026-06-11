import { buildDisplayMediaOptions } from "/capture-options.js";

const TRANSLATION_CALL_URL =
  "https://api.openai.com/v1/realtime/translations/calls";

const OUTPUT_TRANSCRIPT_EVENTS = new Set(["session.output_transcript.delta"]);
const INPUT_TRANSCRIPT_EVENTS = new Set(["session.input_transcript.delta"]);

const targetLanguage = document.querySelector("#targetLanguage");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const sessionCount = document.querySelector("#sessionCount");
const accountName = document.querySelector("#accountName");
const logoutButton = document.querySelector("#logoutButton");
const inputMeter = document.querySelector("#inputMeter");
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
let reconnectDelayMs = 1000;
let sessionRecoveryInProgress = false;
let authState = {
  authenticated: true,
  enabled: false,
  username: null,
};

startButton.disabled = true;
stopButton.disabled = true;
targetLanguage.disabled = true;
logoutButton.disabled = true;
setEventLogExpanded(false);

logoutButton.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/";
});

eventLogToggle.addEventListener("click", () => {
  setEventLogExpanded(eventLogPanel.hidden);
});

startButton.addEventListener("click", async () => {
  beginSession();
  setControls({ running: true });
  setStatus("Pick a browser tab with audio", "idle");

  try {
    activeMeetingReset();
    captureStream = await captureTabAudio();
    startInputMeter(captureStream);

    setStatus("Creating Realtime Translation session", "idle");
    const session = await createRealtimeSession(targetLanguage.value);

    setStatus("Connecting WebRTC", "idle");
    await connectRealtimeTranslation(session, captureStream);

    setStatus("Translating tab audio", "live");
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

async function createSession(language) {
  const response = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: language }),
  });

  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Authentication required.");
    }
    throw new Error(body.error ?? "Failed to create session.");
  }

  return body;
}

async function createRealtimeSession(language) {
  const session = await createSession(language);
  scheduleSessionRefresh(session.expires_at);
  return session;
}

async function connectRealtimeTranslation(session, stream) {
  peerConnection = new RTCPeerConnection();
  dataChannel = peerConnection.createDataChannel("oai-events");

  peerConnection.onconnectionstatechange = () => {
    diagnostics.connectionState = peerConnection?.connectionState ?? "closed";
    chunksSent.textContent = diagnostics.connectionState;
    logEvent("webrtc.connection", diagnostics.connectionState);
    updateDiagnostics();
    if (shouldRecoverConnection(diagnostics.connectionState)) {
      void scheduleConnectionRecovery("WebRTC connection lost");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    diagnostics.iceConnectionState =
      peerConnection?.iceConnectionState ?? "closed";
    queueProgress.value =
      diagnostics.iceConnectionState === "connected" ||
      diagnostics.iceConnectionState === "completed"
        ? 1
        : 0;
    updateDiagnostics();
  };

  peerConnection.ontrack = () => {
    diagnostics.remoteAudioTracks += 1;
    outputAudioDeltas.textContent = String(diagnostics.remoteAudioTracks);
    logEvent("remote.audio", "track received");
    updateDiagnostics();
  };

  dataChannel.onopen = () => {
    diagnostics.dataChannelState = dataChannel?.readyState ?? "open";
    activeInputFrames.textContent = diagnostics.dataChannelState;
    logEvent("datachannel.open", "ok");
    updateDiagnostics();
  };
  dataChannel.onclose = () => {
    diagnostics.dataChannelState = "closed";
    activeInputFrames.textContent = "closed";
    logEvent("datachannel.close", "closed");
    updateDiagnostics();
  };
  dataChannel.onerror = () => {
    logEvent("datachannel.error", "error");
  };
  dataChannel.onmessage = handleRealtimeEvent;

  for (const track of stream.getAudioTracks()) {
    peerConnection.addTrack(track, stream);
  }

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

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

  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });

  logEvent("webrtc.offer", `connected for ${session.targetLanguage}`);
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

  dataChannel?.close();
  dataChannel = null;

  peerConnection?.close();
  peerConnection = null;

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
  targetLanguage.disabled = running || !authState.authenticated;
  logoutButton.disabled = !authState.authenticated || !authState.enabled;
}

function setStatus(message, state) {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "live" ? "live" : ""} ${
    state === "error" ? "error" : ""
  }`;
}

function appendTranslatedText(text) {
  translatedTranscript.textContent += text;
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
    targetLanguage.disabled = true;
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
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return;
  }

  const refreshDelayMs = Math.max(30_000, expiresAt - Date.now() - 60_000);
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
    const session = await createRealtimeSession(targetLanguage.value);
    if (!captureStream) {
      return;
    }
    await connectRealtimeTranslation(session, captureStream);
    setStatus("Translating tab audio", "live");
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

function closeRealtimeConnection() {
  dataChannel?.close();
  dataChannel = null;

  peerConnection?.close();
  peerConnection = null;
}

function shouldRecoverConnection(connectionState) {
  return (
    connectionState === "failed" ||
    connectionState === "disconnected"
  );
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
