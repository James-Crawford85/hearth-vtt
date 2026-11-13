// Scene maps can be images or videos (MP4, WebM: animated maps). Videos play muted and looped,
// each player's on their own clock. These helpers treat both alike.

const VIDEO = /\.(mp4|webm|m4v)(\?|#|$)/i;

/** Whether a map's URL is a video. */
export const isVideo = (url) => VIDEO.test(String(url ?? ''));

/** A loaded image's or video's own size in pixels. */
export const sizeOf = (el) => ({ w: el?.videoWidth || el?.naturalWidth || 0, h: el?.videoHeight || el?.naturalHeight || 0 });

/** An image's or video's own size, { w, h }, loading just enough to know it (null if it fails). */
export function mediaSize(url) {
  return new Promise((resolve) => {
    if (isVideo(url)) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => resolve(null);
      v.src = url;
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const ANIMATE_KEY = 'hearth.animatedMaps';
/** This player's choice: play animated maps, or show a still frame (saves battery on slow machines). */
export function animatedMaps() {
  try { return localStorage.getItem(ANIMATE_KEY) !== 'off'; } catch { return true; }
}
export function setAnimatedMaps(on) {
  try { localStorage.setItem(ANIMATE_KEY, on ? 'on' : 'off'); } catch { /* private window */ }
}
