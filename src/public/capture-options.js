export function buildDisplayMediaOptions(supportedConstraints = {}) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  return {
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: "include",
    video: {
      displaySurface: "browser",
    },
    audio,
  };
}

export function buildMicrophoneMediaOptions(supportedConstraints = {}) {
  const audio = {};
  const preferredConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };

  for (const [name, value] of Object.entries(preferredConstraints)) {
    if (supportedConstraints[name] !== false) {
      audio[name] = value;
    }
  }

  return {
    audio,
    video: false,
  };
}
