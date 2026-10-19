/* Keeps dev tooling and docs out of the packaged extension. */
export default {
  ignoreFiles: [
    'node_modules',
    'package.json',
    'web-ext-config.mjs',
    'web-ext-artifacts',
    '*.md',
    '.env',
    '.env.example',
    '.gitignore',
    'LICENSE',
    '*.zip',
    'server'
  ],
  run: {
    startUrl: ['https://x.com/home'],
    browserConsole: true
  },
  build: {
    overwriteDest: true
  },
  sign: {
    channel: 'unlisted'
  }
};
