/**
 * Remotion rendering module — renders Remotion compositions to video files.
 *
 * Instead of importing Remotion's Node.js SSR API directly (which would require
 * Remotion as a dependency of the parent package), this module shells out to
 * `npx remotion render` within the Remotion project directory. This approach:
 *
 * - Avoids dependency resolution issues (Remotion lives in the template's package.json)
 * - Uses the project's own Remotion version and configuration
 * - Works with any Remotion project structure as long as it has a `src/index.ts` entry point
 *
 * Prerequisites:
 * - The project directory must have `node_modules` installed (with Remotion).
 * - Chrome/Chromium must be available (Remotion will download it on first run, or use system Chrome).
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Video codec. Defaults to "h264". */
  codec?: "h264" | "h265" | "vp8" | "vp9" | "prores";
  /** Frames per second. Defaults to 30. */
  fps?: number;
  /** Output width in pixels. */
  width?: number;
  /** Output height in pixels. */
  height?: number;
  /** CRF (Constant Rate Factor) for quality. Lower = better. Defaults to 18. */
  crf?: number;
  /** Timeout in milliseconds for the render process. Defaults to 300000 (5 min). */
  timeoutMs?: number;
  /** Path to Chrome/Chromium executable. If not set, Remotion finds its own. */
  chromiumExecutable?: string;
  /** Log level for Remotion. Defaults to "warn". */
  logLevel?: "verbose" | "info" | "warn" | "error";
}

export type RenderErrorCode =
  | "MISSING_PROJECT"
  | "MISSING_ENTRY_POINT"
  | "MISSING_NODE_MODULES"
  | "INVALID_ARGUMENTS"
  | "RENDER_FAILED"
  | "RENDER_TIMEOUT"
  | "OUTPUT_DIR_ERROR"
  | "COMPOSITION_NOT_FOUND";

/** Structured error for Remotion render failures. */
export class RenderError extends Error {
  constructor(
    message: string,
    public readonly code: RenderErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CODEC = "h264";
const DEFAULT_CRF = 18;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_LOG_LEVEL = "warn";
const ENTRY_POINT = "src/index.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate that the Remotion project directory is well-formed. */
function validateProjectDir(projectDir: string): void {
  const resolvedDir = resolve(projectDir);

  if (!existsSync(resolvedDir)) {
    throw new RenderError(
      `Project directory does not exist: "${resolvedDir}"`,
      "MISSING_PROJECT",
    );
  }

  const entryPoint = join(resolvedDir, ENTRY_POINT);
  if (!existsSync(entryPoint)) {
    throw new RenderError(
      `Remotion entry point not found: "${entryPoint}". Expected "${ENTRY_POINT}" in the project directory.`,
      "MISSING_ENTRY_POINT",
    );
  }

  const nodeModules = join(resolvedDir, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new RenderError(
      `node_modules not found in "${resolvedDir}". Run "npm install" or "bun install" in the Remotion project first.`,
      "MISSING_NODE_MODULES",
    );
  }
}

/** Ensure the output directory exists. */
async function ensureOutputDir(outputPath: string): Promise<void> {
  const dir = dirname(resolve(outputPath));
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new RenderError(
      `Cannot create output directory "${dir}": ${error instanceof Error ? error.message : String(error)}`,
      "OUTPUT_DIR_ERROR",
      error,
    );
  }
}

/**
 * Parse Remotion render stderr for common error patterns and return
 * a more user-friendly error code + message.
 */
function classifyRenderError(
  stderr: string,
  exitCode: number,
): { code: RenderErrorCode; message: string } {
  const lowerStderr = stderr.toLowerCase();

  if (
    lowerStderr.includes("composition") &&
    lowerStderr.includes("not found")
  ) {
    return {
      code: "COMPOSITION_NOT_FOUND",
      message: "Composition not found. Check that the composition ID is registered in Root.tsx.",
    };
  }

  if (
    lowerStderr.includes("chrome") ||
    lowerStderr.includes("chromium") ||
    lowerStderr.includes("browser")
  ) {
    return {
      code: "RENDER_FAILED",
      message: `Chrome/Chromium issue detected. Remotion needs a browser to render. Error: ${stderr.slice(0, 500)}`,
    };
  }

  return {
    code: "RENDER_FAILED",
    message: `Remotion render failed with exit code ${exitCode}.\nStderr:\n${stderr.slice(0, 2000)}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a Remotion composition to a video file.
 *
 * Shells out to `npx remotion render` in the specified project directory.
 *
 * @param projectDir - Path to the Remotion project (must contain `src/index.ts`).
 * @param compositionId - The ID of the composition to render (as registered in Root.tsx).
 * @param inputProps - JSON-serializable object passed as `--props` to Remotion.
 * @param outputPath - Path for the output video file.
 * @param options - Render configuration (codec, resolution, fps, etc.).
 * @returns The absolute path to the rendered output file.
 *
 * @throws {RenderError} On missing project, missing composition, Chrome issues,
 *   render failures, or timeouts.
 *
 * @example
 * ```ts
 * const output = await renderVideo(
 *   "./remotion-template",
 *   "ScriptedVideo",
 *   { script: { scenes: [...] } },
 *   "/tmp/video-gen/output.mp4",
 * );
 * ```
 */
export async function renderVideo(
  projectDir: string,
  compositionId: string,
  inputProps: Record<string, unknown>,
  outputPath: string,
  options: RenderOptions = {},
): Promise<string> {
  // --- Input validation ---
  if (!projectDir || projectDir.trim() === "") {
    throw new RenderError(
      "projectDir must be a non-empty string.",
      "INVALID_ARGUMENTS",
    );
  }

  if (!compositionId || compositionId.trim() === "") {
    throw new RenderError(
      "compositionId must be a non-empty string.",
      "INVALID_ARGUMENTS",
    );
  }

  if (!outputPath || outputPath.trim() === "") {
    throw new RenderError(
      "outputPath must be a non-empty string.",
      "INVALID_ARGUMENTS",
    );
  }

  if (inputProps === null || typeof inputProps !== "object" || Array.isArray(inputProps)) {
    throw new RenderError(
      "inputProps must be a non-null object.",
      "INVALID_ARGUMENTS",
    );
  }

  // --- Preflight checks ---
  const resolvedProjectDir = resolve(projectDir);
  validateProjectDir(resolvedProjectDir);
  await ensureOutputDir(outputPath);

  const resolvedOutputPath = resolve(outputPath);
  const codec = options.codec ?? DEFAULT_CODEC;
  const crf = options.crf ?? DEFAULT_CRF;
  const logLevel = options.logLevel ?? DEFAULT_LOG_LEVEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // --- Build the command ---
  const args: string[] = [
    "remotion", "render",
    ENTRY_POINT,
    compositionId,
    resolvedOutputPath,
    "--codec", codec,
    "--crf", String(crf),
    "--log", logLevel,
  ];

  // Serialize input props as JSON and pass via --props
  const propsJson = JSON.stringify(inputProps);
  args.push("--props", propsJson);

  // Optional overrides
  if (options.width !== undefined) {
    args.push("--width", String(options.width));
  }
  if (options.height !== undefined) {
    args.push("--height", String(options.height));
  }
  if (options.chromiumExecutable) {
    args.push("--browser-executable", options.chromiumExecutable);
  }

  // --- Execute ---
  const proc = Bun.spawn(["npx", ...args], {
    cwd: resolvedProjectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Suppress Remotion telemetry prompts
      REMOTION_DISABLE_UPDATE_CHECK: "true",
    },
  });

  // Race between render completion and timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(
        new RenderError(
          `Remotion render timed out after ${Math.round(timeoutMs / 1000)}s.`,
          "RENDER_TIMEOUT",
        ),
      );
    }, timeoutMs);
    // Clean up the timer if the process exits first
    proc.exited.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
  });

  let stdout: string;
  let stderr: string;
  let exitCode: number;

  try {
    [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]) as [string, string, number];
  } catch (error) {
    if (error instanceof RenderError) throw error;
    throw new RenderError(
      `Render process error: ${error instanceof Error ? error.message : String(error)}`,
      "RENDER_FAILED",
      error,
    );
  }

  if (exitCode !== 0) {
    const classified = classifyRenderError(stderr, exitCode);
    throw new RenderError(classified.message, classified.code);
  }

  // Verify the output file was created
  if (!existsSync(resolvedOutputPath)) {
    throw new RenderError(
      `Render appeared to succeed (exit code 0) but the output file was not found at "${resolvedOutputPath}".\nStdout: ${stdout.slice(0, 500)}`,
      "RENDER_FAILED",
    );
  }

  return resolvedOutputPath;
}
