import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/** Serve MediaPipe's classic Emscripten loader without Vite's ?import transform. */
function mediaPipeWasmDevPlugin(): Plugin {
  return {
    name: 'mediapipe-wasm-dev-loader',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requestPath = (req.url ?? '').split('?')[0];
        const match = requestPath.match(/^\/mediapipe\/wasm\/(vision_[^/]+\.js)$/);
        if (!match) {
          next();
          return;
        }
        const publicRoot = path.resolve(process.cwd(), 'public', 'mediapipe', 'wasm');
        const filePath = path.resolve(publicRoot, match[1]);
        if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
          next();
          return;
        }
        try {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(fs.readFileSync(filePath));
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [mediaPipeWasmDevPlugin(), react()],
  server: {
    host: true,
    port: 5173,
  },
});
