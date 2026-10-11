/**
 * Call / system audio capture via getDisplayMedia. OWNER: ASR agent.
 *
 * Chromium on Windows offers audio with every kind of share: a tab's own audio ("Also share tab audio"), system
 * audio for an entire screen ("Also share system audio", the WASAPI loopback that captures the Teams/Zoom desktop
 * apps), and, since 141 with windowAudio, system audio for a window too. Options:
 *  - audio: no echo cancellation, noise suppression or gain control. Chromium's constraint code defaults to voice
 *    processing for getDisplayMedia audio as for other non-extension capture; call audio is already processed by
 *    the call app, and a second pass would only distort it for ASR. The applied settings are logged on success.
 *  - systemAudio 'include', windowAudio 'system', monitorTypeSurfaces 'include': every route to the call audio is
 *    offered. ('window' would capture only the shared app's own audio via per-process loopback; untested with
 *    Teams, whose audio may come from child processes.)
 *  - audioSelection 'preferred' (Chrome/Edge 152+): the audio checkbox starts ticked for screens and windows
 *    (tabs already do), so fewer shares arrive without audio.
 *  - selfBrowserSurface 'exclude': this tab has nothing to transcribe. surfaceSwitching 'include': "Share this
 *    tab instead" re-targets the same audio track, so a running session simply continues with the new tab.
 *  - restrictOwnAudio is not requested: it is new (141) and how it separates this document's audio from other
 *    tabs (a call in Teams for the web) is not documented; this page plays nothing during a meeting anyway.
 *
 * The video track (getDisplayMedia cannot be asked for audio alone) is stopped at once, saving the cost of
 * capturing the screen for hours. That leaves the audio running: in Chromium's MediaStreamManager::StopDevice a
 * stopped device is removed from its request, and the request, with its other device and the "Stop sharing" UI,
 * lives until every device has stopped. Tab audio and system loopback are separate audio capturers on Windows,
 * independent of the screen capturer. "Stop sharing" still ends the audio track, which the session reports
 * through onSourceEnded. (macOS system audio comes from ScreenCaptureKit together with the video; if that platform
 * ever matters, keep the video track there.)
 */

type DisplayMediaOptions = DisplayMediaStreamOptions & {
  systemAudio?: 'include' | 'exclude';
  windowAudio?: 'exclude' | 'window' | 'system';
  audioSelection?: 'preferred';
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
};

const OPTIONS: DisplayMediaOptions = {
  video: true,
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // The user must keep hearing the call.
    suppressLocalAudioPlayback: false,
  } as MediaTrackConstraints,
  systemAudio: 'include',
  windowAudio: 'system',
  audioSelection: 'preferred',
  monitorTypeSurfaces: 'include',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
};

/**
 * Ask the user to share a tab, window or screen WITH audio, and return a stream that has only its audio track.
 * Must be called synchronously from a click handler (before any await), or the browser refuses.
 * Rejects with a user-readable message when nothing was shared or no audio was included.
 */
export function requestSystemAudio(): Promise<MediaStream> {
  const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (typeof devices?.getDisplayMedia !== 'function') {
    return Promise.reject(
      new Error('This browser cannot capture call or tab audio here (screen sharing needs a current Chrome or Edge, on https or localhost).'),
    );
  }
  let request: Promise<MediaStream>;
  try {
    // Synchronously, while the click's user activation is still valid.
    request = devices.getDisplayMedia(OPTIONS);
  } catch (err) {
    return Promise.reject(readableError(err));
  }
  return request.then(keepAudio, (err: unknown) => {
    throw readableError(err);
  });
}

function keepAudio(stream: MediaStream): MediaStream {
  const audio = stream.getAudioTracks();
  const video = stream.getVideoTracks();
  const surface = video[0]?.getSettings().displaySurface;
  if (audio.length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(noAudioMessage(surface));
  }
  for (const track of video) track.stop();

  const settings = audio[0].getSettings();
  console.info(`[asr] sharing audio of a ${surface ?? 'display surface'}: "${audio[0].label}"`, {
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
  });
  if (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl) {
    console.warn('[asr] the browser kept voice processing on the shared audio despite the constraints', settings);
  }
  return new MediaStream(audio);
}

function noAudioMessage(surface: string | undefined): string {
  switch (surface) {
    case 'browser':
      return 'The tab was shared without its audio. Share it again and leave "Also share tab audio" switched on.';
    case 'monitor':
      return 'The screen was shared without system audio. Share it again and switch on "Also share system audio".';
    case 'window':
      return (
        'The window was shared without audio (this browser may not offer audio for windows). Share the entire screen ' +
        'with "Also share system audio", or the call\'s browser tab with its audio.'
      );
    default:
      return 'Nothing with audio was shared. Share the call\'s tab with "Also share tab audio", or the entire screen with "Also share system audio".';
  }
}

function readableError(err: unknown): Error {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
  switch (name) {
    case 'NotAllowedError':
      return new Error(
        'Sharing was cancelled, or screen capture is blocked by the browser, an IT policy or the operating system. ' +
          'To transcribe the call, try again and pick its tab, window or screen with audio switched on.',
      );
    case 'InvalidStateError':
      return new Error('Sharing has to start directly from a click on this page. Click the button again.');
    case 'NotFoundError':
      return new Error('There is no screen, window or tab available to share.');
    case 'NotReadableError':
      return new Error(`The selected source could not be captured; the operating system or another app may be blocking it${detail}.`);
    default:
      return new Error(`Screen sharing failed${detail || `: ${String(err)}`}.`);
  }
}
