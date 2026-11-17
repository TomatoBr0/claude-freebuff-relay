'use strict';
// Shared pieces of the fb bridge: IPC endpoint naming, newline-delimited framing,
// path normalisation and keystroke escapes. No dependencies.

const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const WIN = process.platform === 'win32';

// Git Bash reports $PWD as /c/Users/... ; Node on Windows needs C:\Users\...
function toNativePath(p) {
  const s = String(p == null ? '' : p);
  if (!WIN) return s;
  const m = s.match(/^\/(?:cygdrive\/)?([a-zA-Z])(\/.*)?$/);
  if (m) return m[1].toUpperCase() + ':' + (m[2] || '/').replace(/\//g, '\\');
  return s;
}

function normCwd(p) {
  return path.resolve(toNativePath(p || process.cwd()));
}

// One daemon per project folder. Windows: named pipe. Elsewhere: unix socket in the temp dir.
function endpointFor(cwd) {
  const key = normCwd(cwd);
  const h = crypto.createHash('sha1').update(WIN ? key.toLowerCase() : key).digest('hex').slice(0, 12);
  if (WIN) return `\\\\.\\pipe\\fb-relay-${h}`;
  return path.join(os.tmpdir(), `fb-relay-${h}.sock`);
}

function encode(obj) {
  return JSON.stringify(obj) + '\n';
}

// Resolves a connected socket, or null when nothing listens on the endpoint.
function connect(endpoint, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!v) sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.once('connect', () => finish(sock));
    sock.once('error', () => finish(null));
  });
}

// Returns feed(chunk). Calls onLine(string) for every complete, non-empty line. Handles split UTF-8.
function lineSplitter(onLine) {
  const dec = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : dec.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}

// Parses a line into an object; a bad frame becomes {type:'error'} instead of throwing.
function parseFrame(line) {
  try {
    const o = JSON.parse(line);
    if (o && typeof o === 'object') return o;
  } catch (e) {
    // fall through
  }
  return { type: 'error', message: 'bad frame: ' + String(line).slice(0, 200) };
}

// Keystroke escapes for `fb keys`: \r \n \t \e \\ \xHH \0
function decodeEscapes(s) {
  return String(s == null ? '' : s).replace(/\\(x[0-9a-fA-F]{2}|[rnte\\"'0])/g, (m, c) => {
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    return { r: '\r', n: '\n', t: '\t', e: '\x1b', '\\': '\\', '"': '"', "'": "'", '0': '\0' }[c];
  });
}

module.exports = {
  WIN,
  toNativePath,
  normCwd,
  endpointFor,
  encode,
  connect,
  lineSplitter,
  parseFrame,
  decodeEscapes,
};
