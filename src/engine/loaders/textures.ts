// Texture loading with caching, format detection and fallbacks. Port of the
// original `textureLoader`: one cache keyed by `file<>mode`, KTX2 (Basis)
// via three's KTX2Loader, plus bitmap/exr/svg/video/image formats.

import {
  CompressedTexture,
  Data3DTexture,
  DataTexture,
  LinearFilter,
  NearestFilter,
  RepeatWrapping,
  sRGBEncoding,
  Texture,
  TextureLoader as ThreeTextureLoader,
} from 'three';
import type { WebGLRenderer } from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { deferred, type Deferred } from '../../core/deferred';

const DEFAULT_TEXTURE = 'uv/uvchecker-srgb.png';
const DEFAULT_TEXTURE_BASIS = 'uv/uvchecker-srgb.ktx2';

export interface LoadedTexture extends Texture {
  _url?: string;
  _loadMode?: string;
  _loaded: Deferred<void>;
}

const ktx2Loader = new KTX2Loader().setTranscoderPath('/assets/libs/basis/');
const imageLoader = new ThreeTextureLoader();
const cache = new Map<string, LoadedTexture>();

/** Must be called once with the renderer to enable compressed textures. */
export function initTextureLoader(renderer: WebGLRenderer): void {
  ktx2Loader.detectSupport(renderer);
}

export const textureLoader = {
  load(url: string = DEFAULT_TEXTURE, mode = 'default'): LoadedTexture {
    const key = `${url}_<>_${mode}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const ext = url.split('.').pop() ?? '';
    const modeLower = mode.toLowerCase();
    let texture: LoadedTexture;

    if (ext.startsWith('ktx2')) {
      texture = (modeLower.includes('lut')
        ? new (Data3DTexture as any)()
        : new (CompressedTexture as any)()) as LoadedTexture;
    } else if (ext.startsWith('exr')) {
      texture = new (DataTexture as any)() as LoadedTexture;
    } else if (ext.startsWith('mp4') || ext.startsWith('webm')) {
      throw new Error(`video textures not ported: ${url}`);
    } else {
      texture = new Texture() as LoadedTexture;
    }

    texture._url = url;
    texture._loadMode = modeLower;
    texture._loaded = deferred();
    texture.encoding = modeLower.includes('srgb') ? sRGBEncoding : texture.encoding;
    cache.set(key, texture);

    const fullUrl = /^https?:\/\//.test(url) ? url : `/assets/images/${url}`;

    setTimeout(async () => {
      let loaded: Texture | null = null;
      try {
        if (ext.startsWith('ktx2')) {
          loaded = await ktx2Loader.loadAsync(fullUrl);
        } else {
          loaded = await imageLoader.loadAsync(fullUrl);
        }
      } catch (err) {
        console.warn('Texture load:', err);
        // fallback to the uv-checker texture (original behavior)
        try {
          const fallback = ext.startsWith('ktx2') ? DEFAULT_TEXTURE_BASIS : DEFAULT_TEXTURE;
          loaded = await (ext.startsWith('ktx2') ? ktx2Loader : imageLoader).loadAsync(
            `/assets/images/${fallback}`,
          );
        } catch {
          loaded = null;
        }
      }
      if (loaded && loaded !== texture) texture.copy(loaded);
      if (modeLower.includes('repeat')) {
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
      }
      if (modeLower.includes('colordata')) {
        texture.magFilter = LinearFilter;
        texture.minFilter = LinearFilter;
        texture.generateMipmaps = false;
      } else if (modeLower.includes('nearest')) {
        texture.magFilter = NearestFilter;
        texture.minFilter = NearestFilter;
        texture.generateMipmaps = false;
      }
      if (modeLower.includes('lut')) {
        texture.magFilter = NearestFilter;
        texture.minFilter = NearestFilter;
      }
      texture.encoding = modeLower.includes('srgb') ? sRGBEncoding : texture.encoding;
      texture.needsUpdate = true;
      texture._loaded.resolve();
    }, 0);

    return texture;
  },

  /** Replace a placeholder texture with the high-quality version once ready. */
  async loadProgressive(url: string, holder: { value: any }, field = 'value' as const): Promise<void> {
    await (holder as any)[field]._loaded;
    const high = this.load(url, (holder as any)[field]._loadMode);
    await high._loaded;
    (holder as any)[field] = high;
  },
};
