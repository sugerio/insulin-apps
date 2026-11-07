#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// This controller deliberately supports POSIX process groups only.
let interrupted = false;
let activeRun;
function stopRun(signal) {
  interrupted = true;
  console.error(`Received ${signal}; initiating cleanup`);
  activeRun?.();
}
process.on('SIGINT', () => stopRun('SIGINT'));
process.on('SIGTERM', () => stopRun('SIGTERM'));

function validate(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('configuration must be an object');
  for (const key of ['timeoutMs', 'cleanupTimeoutMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 2147483647) throw new Error(`invalid ${key}`);
  }
  for (const key of ['run', 'disableIngress', 'rollback', 'verify']) {
    const command = config[key];
    if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !command[0]) throw new Error(`invalid ${key} command`);
  }
  return config;
}

// kill(0) also sees unreaped zombies: an unconfirmed group fails closed.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function terminateGroup(name, pid) {
  if (!pid) return true;
  const signal = value => {
    try { process.kill(-pid, value); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  try {
    if (!signal('SIGTERM')) return true;
    for (let i = 0; i < 5; i++) {
      await pause(20);
      if (!signal(0)) return true;
    }
    if (!signal('SIGKILL')) return true;
    for (let i = 0; i < 25; i++) {
      await pause(20);
      if (!signal(0)) return true;
    }
    console.error(`${name}: process group termination could not be confirmed (possibly unreaped zombies)`);
  } catch (error) {
    console.error(`${name}: process group termination could not be confirmed: ${error.message}`);
  }
  return false;
}

function execute(name, command, timeout, interruptible) {
  return new Promise(resolve => {
    let child;
    let failed = false;
    let timer;
    let termination;
    let finished = false;
    const terminate = () => termination ??= terminateGroup(name, child?.pid);
    const finish = async () => {
      const extinct = await terminate();
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (interruptible) activeRun = undefined;
      if (!extinct) failed = true;
      if (failed) console.error(`${name}: failed`);
      resolve(!failed);
    };
    const stop = () => { failed = true; void finish(); };
    try {
      child = spawn(command[0], command.slice(1), { shell: false, detached: true, stdio: 'inherit' });
      if (interruptible) activeRun = stop;
      timer = setTimeout(() => { console.error(`${name}: timed out`); stop(); }, timeout);
      child.on('error', error => { failed = true; console.error(`${name}: ${error.message}`); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code !== 0 || signal) failed = true;
        void finish();
      });
      if (interruptible && interrupted) stop();
    } catch (error) {
      failed = true;
      console.error(`${name}: ${error.message}`);
      void finish();
    }
  });
}

async function main() {
  if (process.platform === 'win32') throw new Error('POSIX process groups are required');
  if (process.argv.length !== 3) throw new Error('usage: node scripts/local-controller.mjs CONFIG.json');
  const config = validate(JSON.parse(await readFile(process.argv[2], 'utf8')));
  let ok = false;
  try {
    if (!interrupted) ok = await execute('run', config.run, config.timeoutMs, true);
  } catch (error) {
    console.error(`run: ${error.message}`);
  } finally {
    for (const name of ['disableIngress', 'rollback', 'verify']) {
      try {
        if (!await execute(name, config[name], config.cleanupTimeoutMs, false)) ok = false;
      } catch (error) {
        console.error(`${name}: ${error.message}`);
        ok = false;
      }
    }
  }
  if (interrupted) ok = false;
  process.exitCode = ok ? 0 : 1;
}
main().catch(error => { console.error(`controller: ${error.message}`); process.exitCode = 1; });
