import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE = path.resolve('session-log.txt');

function sessionLogPlugin() {
  return {
    name: 'session-log',
    configureServer(server) {
      server.middlewares.use('/log', (req, res, next) => {
        if (req.method !== 'POST') return next();
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            fs.appendFileSync(LOG_FILE, body + '\n');
            res.statusCode = 204;
            res.end();
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
      server.middlewares.use('/log-session', (req, res, next) => {
        if (req.method !== 'POST') return next();
        const header =
          `\n# ─────────────────────────────────────────────\n` +
          `# Session started ${new Date().toISOString()}\n` +
          `# Format: time  EVENT  action  predicted/reason  dist/metrics\n` +
          `# ─────────────────────────────────────────────\n`;
        try {
          fs.appendFileSync(LOG_FILE, header);
          res.statusCode = 204;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [sessionLogPlugin()],
});
