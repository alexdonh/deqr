import { browser } from 'wxt/browser';

import { readSettings, writeSettings } from '../../src/settings';

// permissions.request() needs a user gesture and is unavailable in content
// scripts, which is why granting an origin happens here rather than inline on
// the page: the locked badge sends the user to this page instead of prompting.

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const grantForm = $<HTMLFormElement>('grant-form');
const grantInput = $<HTMLInputElement>('grant-input');
const grantError = $<HTMLParagraphElement>('grant-error');
const grantedList = $<HTMLUListElement>('granted-list');
const siteForm = $<HTMLFormElement>('site-form');
const siteInput = $<HTMLInputElement>('site-input');
const siteList = $<HTMLUListElement>('site-list');
const deepScan = $<HTMLInputElement>('deep-scan');
const revealSecrets = $<HTMLInputElement>('reveal-secrets');

function row(label: string, onRemove: () => void): HTMLLIElement {
  const li = document.createElement('li');
  const text = document.createElement('span');
  text.textContent = label;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'remove';
  button.textContent = 'Remove';
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
    empty.textContent = 'No origins allowed yet.';
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
    empty.textContent = 'No sites disabled.';
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
    grantError.textContent = 'That is not a valid origin.';
    grantError.hidden = false;
    return;
  }
  if (!origin.startsWith('http')) {
    grantError.textContent = 'Only http and https origins can be granted.';
    grantError.hidden = false;
    return;
  }

  const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    grantError.textContent = 'Permission was declined.';
    grantError.hidden = false;
    return;
  }
  grantInput.value = '';
  await renderGranted();
});

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

async function init(): Promise<void> {
  const settings = await readSettings();
  deepScan.checked = settings.deepScan;
  revealSecrets.checked = settings.revealSecrets;
  await Promise.all([renderGranted(), renderSites()]);
}

void init();
