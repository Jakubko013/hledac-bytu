import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// Output format: scrypt$N$r$p$saltB64$hashB64 (verified by src/lib/auth.ts)
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

/** Reads one line from stdin. On a TTY the typed characters are not echoed; piped stdin works as-is. */
function readPassword(): Promise<string> {
  const interactive = Boolean(process.stdin.isTTY);
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: interactive });
  return new Promise((resolve, reject) => {
    let done = false;
    rl.once('line', (line) => {
      done = true;
      rl.close();
      if (interactive) process.stderr.write('\n');
      resolve(line);
    });
    rl.once('close', () => {
      if (!done) reject(new Error('no password provided on stdin'));
    });
    if (interactive) {
      rl.setPrompt('Password: ');
      rl.prompt();
    }
    muted = interactive;
  });
}

if (process.argv.length > 2) {
  console.error('Passwords are no longer accepted as arguments (they leak via shell history). Run without args, or pipe via stdin.');
  process.exit(1);
}

let password: string;
try {
  password = await readPassword();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
if (!password) {
  console.error('Password must not be empty.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, KEYLEN, { N, r, p });
console.log(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`);
