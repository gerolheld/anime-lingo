import {existsSync} from 'node:fs';
// Local development uses the system Chromium; CI installs Playwright's own (`npx playwright install chromium`).
export const chromiumPath=process.env.CHROMIUM||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
