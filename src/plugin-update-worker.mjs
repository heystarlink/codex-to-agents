#!/usr/bin/env node
// Detached helper for the board-only update backend. It inherits the lock nonce
// from the process that spawned it, performs the long Git/dependency work after
// the MCP HTTP response has already answered, and writes every transition to the
// shared state file the board polls.
import { runUpdateJob } from './plugin-update.mjs';

const [home, action] = process.argv.slice(2);
try {
  await runUpdateJob(home, { action, nonce: process.env.CODEX_TO_AGENTS_UPDATE_LOCK });
} catch (error) {
  console.error(`Codex to Agents update helper failed: ${error.message}`);
  process.exitCode = 1;
}
