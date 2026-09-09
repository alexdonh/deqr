// Copies zxing_reader.wasm to public/ for local extension use.
// Avoids blocked CDN fallback.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Matches zxing-wasm dist layout so locateFile finds the .wasm locally.
const src = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
const dest = new URL('../public/wasm/reader/zxing_reader.wasm', import.meta.url);

await mkdir(new URL('.', dest), { recursive: true });
await copyFile(src, dest);
console.log(`sync-wasm: ${src} -> public/wasm/reader/zxing_reader.wasm`);
