/**
 * Catalogue integrity.
 *
 * tsc already covers the English side: wxt prepare turns _locales/en into a
 * typed overload per key, so a key used in code but missing from en will not
 * compile. Nothing checks the other locales, which is what these tests are for.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface Message {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

const LOCALES_DIR = fileURLToPath(new URL('../public/_locales', import.meta.url));
const DEFAULT_LOCALE = 'en';

const locales = readdirSync(LOCALES_DIR);
const load = (locale: string): Record<string, Message> =>
  JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

const base = load(DEFAULT_LOCALE);
const translations = locales.filter((l) => l !== DEFAULT_LOCALE);

/** Placeholder references in a message body: $name$, with $$ as a literal $. */
function used(message: string): string[] {
  return [...message.replace(/\$\$/g, '').matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) =>
    m[1]!.toLowerCase(),
  );
}

it('ships more than one locale', () => {
  expect(translations.length).toBeGreaterThan(0);
});

describe.each(locales)('%s', (locale) => {
  const messages = load(locale);
  const entries = Object.entries(messages);

  it('uses only key names the extension platform accepts', () => {
    // Chrome rejects anything outside this set - no dots, no dashes - and the
    // failure is a silently empty string at runtime rather than a load error.
    const invalid = Object.keys(messages).filter((key) => !/^[A-Za-z0-9_@]+$/.test(key));
    expect(invalid).toEqual([]);
  });

  it('has no empty message', () => {
    expect(entries.filter(([, m]) => !m.message.trim()).map(([k]) => k)).toEqual([]);
  });

  it('declares every placeholder it interpolates', () => {
    const undeclared = entries.flatMap(([key, m]) => {
      const declared = new Set(Object.keys(m.placeholders ?? {}).map((p) => p.toLowerCase()));
      return used(m.message)
        .filter((name) => !declared.has(name))
        .map((name) => `${key}: $${name}$`);
    });
    expect(undeclared).toEqual([]);
  });

  it('interpolates every placeholder it declares', () => {
    const unused = entries.flatMap(([key, m]) => {
      const inBody = new Set(used(m.message));
      return Object.keys(m.placeholders ?? {})
        .filter((name) => !inBody.has(name.toLowerCase()))
        .map((name) => `${key}: ${name}`);
    });
    expect(unused).toEqual([]);
  });
});

describe.each(translations)('%s matches the %s catalogue', (locale) => {
  const messages = load(locale);

  it('translates every key, and invents none', () => {
    expect(Object.keys(messages).sort()).toEqual(Object.keys(base).sort());
  });

  it('takes the same substitutions as English', () => {
    // A translation that drops or renumbers an argument silently loses the
    // hostname or amount the warning is about.
    const mismatched = Object.entries(base)
      .filter(([key, english]) => {
        const slots = (m?: Message) =>
          Object.values(m?.placeholders ?? {})
            .map((p) => p.content)
            .sort()
            .join(',');
        return slots(english) !== slots(messages[key]);
      })
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });
});
