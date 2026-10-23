// English interface: the same static page tests, run with the language forced to English; any Russian interface text left fails them.
process.env.LINGO_UI_LANG='en';
await import('./reference-ui.mjs');
await import('./models-ui.mjs');
await import('./library-root-ui.mjs');
