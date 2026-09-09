import { browser } from 'wxt/browser';

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  /** Skip the prefilter and send every candidate to the decoder. Slower, catches more. */
  deepScan: boolean;
  /** Hostnames where deQR does not scan at all. */
  disabledSites: string[];
  /** Show Wi-Fi passwords and 2FA seeds without a click-to-reveal step. */
  revealSecrets: boolean;
  /** Colour scheme for the reveal panel and the options page. */
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  deepScan: false,
  disabledSites: [],
  revealSecrets: false,
  theme: 'system',
};

export function applyTheme(el: HTMLElement, theme: Theme): void {
  el.style.colorScheme = theme === 'system' ? 'light dark' : theme;
}

export async function readSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get({ ...DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export async function writeSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.local.set({ ...patch });
}
