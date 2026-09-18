import { browser } from 'wxt/browser';

import { t, uiLanguage, type MessageKey } from '../../src/i18n';
import { applyTheme, readSettings, writeSettings, type Theme } from '../../src/settings';

// permissions.request() needs a user gesture and is unavailable in content
// scripts, which is why granting an origin happens here rather than inline on
// the page: the locked badge sends the user to this page instead of prompting.

const params = new URLSearchParams(location.search);
const pendingOrigin = params.get('origin');
const returnTab = Number(params.get('from')) || undefined;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const grantForm = $<HTMLFormElement>('grant-form');
const grantInput = $<HTMLInputElement>('grant-input');
const grantSubmit = $<HTMLButtonElement>('grant-submit');
const grantError = $<HTMLParagraphElement>('grant-error');
const grantedList = $<HTMLUListElement>('granted-list');
const siteForm = $<HTMLFormElement>('site-form');
const siteInput = $<HTMLInputElement>('site-input');
const siteList = $<HTMLUListElement>('site-list');
const deepScan = $<HTMLInputElement>('deep-scan');
const revealSecrets = $<HTMLInputElement>('reveal-secrets');
const themes = document.querySelectorAll<HTMLInputElement>('input[name="theme"]');

function localize(): void {
  document.documentElement.lang = uiLanguage();
  const apply = (attr: string, set: (el: HTMLElement, text: string) => void) => {
    for (const el of document.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const key = el.getAttribute(attr) as MessageKey | null;
      if (key) set(el, t(key));
    }
  };
  apply('data-i18n', (el, text) => (el.textContent = text));
  apply('data-i18n-aria-label', (el, text) => el.setAttribute('aria-label', text));
  apply('data-i18n-title', (el, text) => el.setAttribute('title', text));
  apply('data-i18n-placeholder', (el, text) => el.setAttribute('placeholder', text));
}

function row(label: string, onRemove: () => void): HTMLLIElement {
  const li = document.createElement('li');
  const text = document.createElement('span');
  text.textContent = label;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'remove';
  button.textContent = t('optRemove');
  button.addEventListener('click', onRemove);
  li.append(text, button);
  return li;
}

/**
 * `permissions.getAll()` also reports the match patterns of declared content
 * scripts, so ours shows up as `<all_urls>` even though the user granted
 * nothing. Listing it as a revokable grant would be a lie - it is not optional
 * and `permissions.remove` will not take it away. Only concrete host patterns
 * here are real grants.
 */
function isUserGrant(origin: string): boolean {
  return origin !== '<all_urls>' && !/^\*:\/\/(\*\/\*|\*\.?\/)$/.test(origin);
}

async function renderGranted(): Promise<void> {
  const { origins = [] } = await browser.permissions.getAll();
  const granted = origins.filter(isUserGrant);

  if (granted.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = t('optNoOrigins');
    grantedList.replaceChildren(empty);
    return;
  }

  grantedList.replaceChildren(
    ...granted.map((origin) =>
      row(origin, async () => {
        await browser.permissions.remove({ origins: [origin] });
        await renderGranted();
      }),
    ),
  );
}

async function renderSites(): Promise<void> {
  const { disabledSites } = await readSettings();
  if (disabledSites.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = t('optNoSites');
    siteList.replaceChildren(empty);
    return;
  }
  siteList.replaceChildren(
    ...disabledSites.map((site) =>
      row(site, async () => {
        const current = await readSettings();
        await writeSettings({
          disabledSites: current.disabledSites.filter((s) => s !== site),
        });
        await renderSites();
      }),
    ),
  );
}

grantForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  grantError.hidden = true;

  const raw = grantInput.value.trim();
  let origin: string;
  try {
    origin = new URL(raw.includes('://') ? raw : `https://${raw}`).origin;
  } catch {
    grantError.textContent = t('optInvalidOrigin');
    grantError.hidden = false;
    return;
  }
  if (!origin.startsWith('http')) {
    grantError.textContent = t('optOnlyHttp');
    grantError.hidden = false;
    return;
  }

  const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    grantError.textContent = t('optPermissionDeclined');
    grantError.hidden = false;
    return;
  }
  grantInput.value = '';
  await renderGranted();
  await goBack(origin);
});

async function goBack(origin: string): Promise<void> {
  if (returnTab === undefined || origin !== pendingOrigin) return;
  // A tab with no listener rejects; the images there simply stay locked until
  // the next load, which is no reason to strand the user on this page.
  await browser.tabs
    .sendMessage(returnTab, { type: 'grant-added', origin })
    .catch(() => undefined);
  try {
    await browser.tabs.update(returnTab, { active: true });
  } catch {
    return; // Tab is gone. Stay here rather than closing onto nothing.
  }
  const self = await browser.tabs.getCurrent();
  if (self?.id !== undefined) await browser.tabs.remove(self.id);
}

siteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = siteInput.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!value) return;
  const current = await readSettings();
  if (!current.disabledSites.includes(value)) {
    await writeSettings({ disabledSites: [...current.disabledSites, value] });
  }
  siteInput.value = '';
  await renderSites();
});

deepScan.addEventListener('change', () => {
  void writeSettings({ deepScan: deepScan.checked });
});
revealSecrets.addEventListener('change', () => {
  void writeSettings({ revealSecrets: revealSecrets.checked });
});

for (const input of themes) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    const theme = input.value as Theme;
    applyTheme(document.documentElement, theme);
    void writeSettings({ theme });
  });
}

async function init(): Promise<void> {
  localize();
  const settings = await readSettings();
  deepScan.checked = settings.deepScan;
  revealSecrets.checked = settings.revealSecrets;
  applyTheme(document.documentElement, settings.theme);
  for (const input of themes) input.checked = input.value === settings.theme;
  await Promise.all([renderGranted(), renderSites()]);

  if (pendingOrigin) {
    grantInput.value = pendingOrigin;
    grantSubmit.focus();
  }
}

void init();
