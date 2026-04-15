#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Worktree Cleanup Tool
 * 
 * Safely removes stale worktrees from /tmp/randal-builds/ that are not 
 * associated with active builds in loop-state.json.
 * 
 * Usage:
 *   worktree-cleanup           # Dry-run mode (default) - shows what would be deleted
 *   worktree-cleanup --force   # Actually delete stale worktrees
 */

interface LoopState {
  builds: Record<string, {
    status: string;
    planFile: string;
    worktree?: string;
    [key: string]: any;
  }>;
}

const WORKTREE_BASE = '/tmp/randal-builds';
const LOOP_STATE_PATH = '.opencode/loop-state.json';

function log(message: string) {
  console.log(message);
}

function error(message: string) {
  console.error(`❌ ${message}`);
}

function getActiveWorktrees(): Set<string> {
  const activeWorktrees = new Set<string>();

  // Read loop-state.json to find active builds
  if (!existsSync(LOOP_STATE_PATH)) {
    log(`ℹ️  No loop-state.json found at ${LOOP_STATE_PATH}`);
    return activeWorktrees;
  }

  try {
    const loopStateContent = readFileSync(LOOP_STATE_PATH, 'utf-8');
    const loopState: LoopState = JSON.parse(loopStateContent);

    // Extract worktree paths from active builds
    for (const [buildId, build] of Object.entries(loopState.builds || {})) {
      if (build.status !== 'complete' && build.status !== 'merged' && build.worktree) {
        activeWorktrees.add(build.worktree);
        log(`✅ Active build: ${buildId} → ${build.worktree}`);
      }
    }
  } catch (err) {
    error(`Failed to read loop-state.json: ${err}`);
  }

  return activeWorktrees;
}

function getWorktreeDirectories(): string[] {
  if (!existsSync(WORKTREE_BASE)) {
    log(`ℹ️  Worktree directory ${WORKTREE_BASE} does not exist`);
    return [];
  }

  try {
    const entries = readdirSync(WORKTREE_BASE);
    const directories = entries.filter(entry => {
      const fullPath = join(WORKTREE_BASE, entry);
      try {
        return statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    });
    return directories.map(dir => join(WORKTREE_BASE, dir));
  } catch (err) {
    error(`Failed to read worktree directory: ${err}`);
    return [];
  }
}

function isGitWorktree(path: string): boolean {
  try {
    const gitDir = join(path, '.git');
    return existsSync(gitDir);
  } catch {
    return false;
  }
}

function removeWorktree(path: string, dryRun: boolean): boolean {
  if (!isGitWorktree(path)) {
    error(`${path} is not a valid git worktree - skipping for safety`);
    return false;
  }

  if (dryRun) {
    log(`🔍 Would remove worktree: ${path}`);
    return true;
  }

  try {
    // Use git worktree remove to safely clean up
    log(`🗑️  Removing worktree: ${path}`);
    execSync(`git worktree remove "${path}" --force`, { 
      stdio: 'inherit',
      cwd: process.cwd()
    });
    log(`✅ Removed: ${path}`);
    return true;
  } catch (err) {
    error(`Failed to remove ${path}: ${err}`);
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = !force;

  log('🧹 Worktree Cleanup Tool\n');

  if (dryRun) {
    log('🔍 Running in DRY-RUN mode (pass --force to actually delete)\n');
  } else {
    log('⚠️  Running in FORCE mode - will delete stale worktrees\n');
  }

  // Step 1: Get active worktrees from loop-state.json
  const activeWorktrees = getActiveWorktrees();
  log(`\nℹ️  Found ${activeWorktrees.size} active build(s)\n`);

  // Step 2: Scan /tmp/randal-builds/ for worktree directories
  const allWorktrees = getWorktreeDirectories();
  log(`ℹ️  Found ${allWorktrees.length} worktree directory(ies) in ${WORKTREE_BASE}\n`);

  if (allWorktrees.length === 0) {
    log('✨ No worktrees to clean up');
    return;
  }

  // Step 3: Identify stale worktrees
  const staleWorktrees = allWorktrees.filter(path => !activeWorktrees.has(path));

  if (staleWorktrees.length === 0) {
    log('✨ No stale worktrees found - all worktrees are active');
    return;
  }

  log(`\n🔍 Found ${staleWorktrees.length} stale worktree(s):\n`);
  
  // Step 4: Remove stale worktrees
  let removed = 0;
  for (const worktree of staleWorktrees) {
    if (removeWorktree(worktree, dryRun)) {
      removed++;
    }
  }

  log(`\n${dryRun ? '🔍' : '✅'} Summary: ${removed} worktree(s) ${dryRun ? 'would be' : 'were'} removed`);
  
  if (dryRun && removed > 0) {
    log('\n💡 Run with --force to actually remove these worktrees');
  }
}

main();
