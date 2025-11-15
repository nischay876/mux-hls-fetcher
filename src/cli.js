#!/usr/bin/env node
/* eslint-disable no-console */

const path = require('path');
const start = require('./index');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .usage('Fetch and save the contents of an HLS playlist locally.\nUsage: $0')
  .option('input', {
    alias: 'i',
    describe: 'uri to m3u8 (required)',
    type: 'string',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    describe: "output path (default:'./hls-fetcher')",
    type: 'string',
    default: './hls-fetcher'
  })
  .option('concurrency', {
    alias: 'c',
    describe: 'number of simultaneous fetches (default: 10)',
    type: 'number',
    default: 10
  })
  .option('decrypt', {
    alias: 'd',
    describe: 'decrypt and remove encryption from manifest (default: false)',
    type: 'boolean',
    default: false
  })
  .help()
  .argv;

// Make output path
const output = path.resolve(argv.output);
const startTime = Date.now();
const options = {
  input: argv.input,
  output,
  concurrency: argv.concurrency,
  decrypt: argv.decrypt
};

console.log(`🚀 Starting Mux HLS fetcher...`);
console.log(`📥 Input: ${argv.input}`);
console.log(`📁 Output: ${output}`);
console.log(`⚡ Concurrency: ${options.concurrency}`);
console.log(`🔐 Decrypt: ${options.decrypt}`);

start(options).then(function() {
  const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('✅ Operation completed successfully in', timeTaken, 'seconds.');
  process.exit(0);
}).catch(function(error) {
  console.error('❌ ERROR:', error);
  process.exit(1);
});
