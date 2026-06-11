import assert from "node:assert/strict";
import test from "node:test";

import { buildDisplayMediaOptions } from "../src/public/capture-options.js";

test("buildDisplayMediaOptions configures browser tab capture without suppressing playback", () => {
  const options = buildDisplayMediaOptions({ suppressLocalAudioPlayback: true });

  assert.equal(Object.hasOwn(options.audio, "suppressLocalAudioPlayback"), false);
  assert.equal(options.audio.echoCancellation, false);
  assert.equal(options.video.displaySurface, "browser");
});
