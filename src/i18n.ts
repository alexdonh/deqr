/**
 * Message lookup.
 *
 * The locale comes from the browser's own UI language.
 */

import { browser } from 'wxt/browser';

/**
 * Every key in the English catalogue. Derived from the file itself, so a key
 * that does not exist there will not compile.
 */
export type MessageKey = keyof typeof import('../public/_locales/en/messages.json');

type GetMessage = (key: string, substitutions?: string[]) => string;

export function t(key: MessageKey, args?: string[]): string {
  return (browser.i18n.getMessage as unknown as GetMessage)(key, args) || key;
}

export function uiLanguage(): string {
  return browser.i18n.getUILanguage();
}

/** "Latin and Cyrillic" / "Latin và Cyrillic". */
export function formatList(items: string[]): string {
  return new Intl.ListFormat(uiLanguage(), { type: 'conjunction' }).format(items);
}
