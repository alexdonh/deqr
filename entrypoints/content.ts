import { defineContentScript } from 'wxt/utils/define-content-script';

import { Ui } from '../src/panel';
import { Scanner } from '../src/scan';
import { readSettings } from '../src/settings';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: true,
  async main() {
    const settings = await readSettings();
    if (settings.disabledSites.includes(location.hostname)) return;

    const ui = new Ui(settings);
    const scanner = new Scanner(settings, (el, outcome) => ui.add(el, outcome));
    scanner.start();
  },
});
