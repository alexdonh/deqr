import type { ReaderOptions } from 'zxing-wasm/reader';

/**
 * Decoder settings, kept in one place so the tests run the same configuration
 * the extension ships rather than the library defaults.
 */
export const READER_OPTIONS: ReaderOptions = {
  formats: ['QRCode', 'MicroQRCode', 'rMQRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  maxNumberOfSymbols: 1,
  // Use 'Plain' to keep the original payload, not reformatted.
  textMode: 'Plain',
};
