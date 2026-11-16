import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Reload the page when a lesson file is added to or removed from ../samples
// (Vite only watches its own folder by default).
function watchSamples(): Plugin {
  return {
    name: 'watch-samples',
    configureServer(server) {
      const dir = path.resolve(__dirname, '../samples');
      const samplesModule = path.resolve(__dirname, 'src/samples.ts');
      server.watcher.add(dir);
      const onChange = (file: string) => {
        if (!file.startsWith(dir)) return;
        server.moduleGraph.getModulesByFile(samplesModule)?.forEach((m) => server.moduleGraph.invalidateModule(m));
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}

// During development, API requests are forwarded to the Java server (./gradlew run).
export default defineConfig({
  plugins: [react(), watchSamples()],
  server: {
    port: 5173,
    // every server endpoint lives on the Java server
    proxy: Object.fromEntries(
      ['/run', '/count', '/complete', '/hover', '/signature', '/version', '/ping'].map((p) => [p, 'http://127.0.0.1:7070']),
    ),
    fs: { allow: ['..'] }, // lets the app import the shared ../samples folder
  },
});
