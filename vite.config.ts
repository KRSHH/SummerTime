import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serves the clean card URLs (/r and /play) in `vite dev` and `vite preview`,
 * mirroring the rewrites in vercel.json. The X player card only ever sees the
 * production URLs; this keeps local testing on exactly the same ones.
 */
function cardUrls(): Plugin {
  const routes: Record<string, string> = {
    '/r': '/card.html',
    '/r/': '/card.html',
    '/play': '/play.html',
    '/play/': '/play.html',
  };
  const middleware = (req: IncomingMessage, _res: ServerResponse, next: () => void) => {
    const [path, query] = (req.url ?? '').split('?');
    const target = routes[path];
    if (target) req.url = query ? `${target}?${query}` : target;
    next();
  };
  return {
    name: 'summertime-card-urls',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), cardUrls()],
  // The P2P wasm package must not be pre-bundled by Vite's dep optimizer.
  optimizeDeps: {
    exclude: ['summer-iroh'],
  },
  publicDir: 'public',
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // Three pages: the site, the X card page (what the posted link opens),
      // and the player page (what X embeds in the timeline).
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        card: fileURLToPath(new URL('./card.html', import.meta.url)),
        play: fileURLToPath(new URL('./play.html', import.meta.url)),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
