import { browser } from 'wxt/browser';

export interface Settings {
  /** Skip the prefilter and send every candidate to the decoder. Slower, catches more. */
  deepScan: boolean;
  /** Hostnames where deQR does not scan at all. */
  disabledSites: string[];
  /** Show Wi-Fi passwords and 2FA seeds without a click-to-reveal step. */
  revealSecrets: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  deepScan: false,
  disabledSites: [],
  revealSecrets: false,
};

export async function readSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get({ ...DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export async function writeSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.local.set({ ...patch });
}
