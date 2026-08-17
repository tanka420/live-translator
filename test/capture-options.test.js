import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDisplayMediaOptions,
  buildMicrophoneMediaOptions,
} from "../src/public/capture-options.js";

test("buildDisplayMediaOptions configures browser tab capture without suppressing playback", () => {
  const options = buildDisplayMediaOptions({ suppressLocalAudioPlayback: true });

  assert.equal(Object.hasOwn(options.audio, "suppressLocalAudioPlayback"), false);
  assert.equal(options.audio.echoCancellation, false);
  assert.equal(options.video.displaySurface, "browser");
});

test("buildMicrophoneMediaOptions optimizes microphone capture for speech", () => {
  const options = buildMicrophoneMediaOptions({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: true,
  });

  assert.deepEqual(options, {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
});

test("buildMicrophoneMediaOptions omits explicitly unsupported constraints", () => {
  const options = buildMicrophoneMediaOptions({
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: false,
  });

  assert.deepEqual(options.audio, { echoCancellation: true });
});
