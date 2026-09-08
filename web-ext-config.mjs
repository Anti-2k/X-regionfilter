/* Keeps the dev tooling and tests out of the packaged extension. */
export default {
  ignoreFiles: [
    'node_modules',
    'test',
    'package.json',
    'bun.lock',
    'bun.lockb',
    'web-ext-config.mjs',
    'web-ext-artifacts',
    '*.md',
    '.env',
    '.env.example',
    '.gitignore',
    'LICENSE',
    '*.zip'
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
