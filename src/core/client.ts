// Device / browser / capability detection. Port of the original `client`
// singleton, rewritten without ua-parser-js (light regexes with the same
// semantics: device, browser.name, capabilities).

interface Client {
  device: 'desktop' | 'mobile' | 'tablet';
  browser: { name: string; version: number };
  os: { name: string; version: number };
  screen: {
    dpr: number;
    width: number;
    height: number;
    w: number;
    h: number;
  };
  capabilities: {
    webgl: boolean;
    webgpu: boolean;
    touch: boolean;
    fullScreen: boolean;
    geo: boolean;
    imageBitmap: boolean;
  };
  visible: boolean;
  focused: boolean;
  oldIphone: boolean;
}

const ua = navigator.userAgent;
const lower = ua.toLowerCase();

function parseBrowser(): { name: string; version: number } {
  const firefox = ua.match(/Firefox\/([\d.]+)/);
  if (firefox) return { name: 'firefox', version: parseFloat(firefox[1]) };
  const safari = ua.match(/Version\/([\d.]+).*Safari/);
  if (safari) return { name: 'safari', version: parseFloat(safari[1]) };
  const chrome = ua.match(/Chrome\/([\d.]+)/);
  if (chrome) return { name: 'chrome', version: parseFloat(chrome[1]) };
  return { name: 'unknown', version: 0 };
}

function detectDevice(): Client['device'] {
  const m = /(android|iphone|ipad|ipod|mobile)/i.exec(ua);
  if (!m) return 'desktop';
  if (m[1].toLowerCase() === 'ipad' || /tablet/i.test(ua)) return 'tablet';
  return 'mobile';
}

function webglSupported(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

export const client: Client = {
  device: detectDevice(),
  browser: parseBrowser(),
  os: { name: 'unknown', version: 0 },
  screen: {
    dpr: window.devicePixelRatio || 1,
    width: window.innerWidth,
    height: window.innerHeight,
    w: window.innerWidth,
    h: window.innerHeight,
  },
  capabilities: {
    webgl: webglSupported(),
    webgpu: typeof (navigator as any).gpu !== 'undefined',
    touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    fullScreen:
      document.fullscreenEnabled || // eslint-disable-line @typescript-eslint/no-explicit-any
      (document as any).webkitFullscreenEnabled ||
      (document as any).mozFullscreenEnabled,
    geo: typeof navigator.geolocation !== 'undefined',
    imageBitmap: typeof createImageBitmap === 'function',
  },
  visible: document.visibilityState === 'visible',
  focused: document.hasFocus(),
  oldIphone: lower.includes('iphone') && /os [1-9]_\d/.test(lower),
};

const setSize = () => {
  client.screen.width = window.innerWidth;
  client.screen.height = window.innerHeight;
  client.screen.w = window.innerWidth;
  client.screen.h = window.innerHeight;
  client.screen.dpr = window.devicePixelRatio || 1;
};
window.addEventListener('resize', setSize);
document.addEventListener('visibilitychange', () => {
  client.visible = document.visibilityState === 'visible';
});
window.addEventListener('focus', () => {
  client.focused = true;
});
window.addEventListener('blur', () => {
  client.focused = false;
});
