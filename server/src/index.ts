/**
 * API server entry point: `npm start` (or `npm run dev` with watch). Serves the API on PORT
 * (default 3001) and, when web/dist exists (`npm run build`), the web app on the same port.
 */
import { checkOcrTools, INSTALL_HINT } from './ingest/index.js';
import { createApp } from './api/app.js';

const port = Number(process.env.PORT ?? 3001);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`Shipment → NetCHB entry server listening on http://localhost:${port}`);
  void checkOcrTools().then((s) => {
    const found = (['tesseract', 'pdftoppm', 'pdftotext'] as const).map((t) => `${t} ${s[t] ?? 'MISSING'}`).join(', ');
    if (s.ok) console.log(`OCR tools OK: ${found}`);
    else console.warn(`OCR tools missing (${s.missing.join(', ')}): ${found}\n${INSTALL_HINT}`);
  });
});

server.on('error', (err) => {
  console.error(`Could not start the server on port ${port}: ${err.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
