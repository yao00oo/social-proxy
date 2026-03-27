#!/usr/bin/env node

import { login, isLoggedIn, getToken } from './auth';
import { startSync } from './sync';
import { info, error, success } from './logger';

const COMMANDS = ['login', 'start', 'status', 'stop'] as const;
type Command = (typeof COMMANDS)[number];

async function main() {
  const command = process.argv[2] as Command | undefined;

  if (command && !COMMANDS.includes(command)) {
    error(`Unknown command: ${command}`);
    console.log(`\nUsage: botook-agent [command]\n`);
    console.log('Commands:');
    console.log('  login   Log in to botook.ai via browser');
    console.log('  start   Start syncing (login first if needed)');
    console.log('  status  Show current sync status');
    console.log('  stop    Stop the running agent');
    console.log('\nNo command = login if needed, then start syncing.');
    process.exit(1);
  }

  switch (command) {
    case 'login':
      await handleLogin();
      break;

    case 'status':
      await handleStatus();
      break;

    case 'stop':
      await handleStop();
      break;

    case 'start':
    default:
      // Default: login if needed, then start syncing
      await handleStart();
      break;
  }
}

async function handleLogin() {
  if (await isLoggedIn()) {
    success('Already logged in.');
    return;
  }
  await login();
}

async function handleStart() {
  if (!(await isLoggedIn())) {
    info('Not logged in. Starting login flow...');
    await login();
  }

  const token = await getToken();
  if (!token) {
    error('Failed to get auth token. Please run `botook-agent login` first.');
    process.exit(1);
  }

  await startSync(token);
}

async function handleStatus() {
  const loggedIn = await isLoggedIn();
  if (loggedIn) {
    success('Logged in.');
  } else {
    info('Not logged in.');
  }

  // Check for running agent via PID file
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const pidFile = path.join(os.homedir(), '.botook', 'agent.pid');

  if (fs.existsSync(pidFile)) {
    const pid = fs.readFileSync(pidFile, 'utf-8').trim();
    try {
      process.kill(Number(pid), 0); // Check if process is alive
      success(`Agent running (PID ${pid})`);
    } catch {
      info('Agent not running (stale PID file).');
      fs.unlinkSync(pidFile);
    }
  } else {
    info('Agent not running.');
  }
}

async function handleStop() {
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const pidFile = path.join(os.homedir(), '.botook', 'agent.pid');

  if (!fs.existsSync(pidFile)) {
    info('Agent is not running.');
    return;
  }

  const pid = fs.readFileSync(pidFile, 'utf-8').trim();
  try {
    process.kill(Number(pid), 'SIGTERM');
    success(`Stopped agent (PID ${pid})`);
    fs.unlinkSync(pidFile);
  } catch {
    error(`Failed to stop agent (PID ${pid}). It may have already exited.`);
    fs.unlinkSync(pidFile);
  }
}

main().catch((err) => {
  error(err.message || String(err));
  process.exit(1);
});
