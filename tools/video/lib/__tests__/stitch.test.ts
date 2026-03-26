import { describe, test, expect } from "bun:test";
import { stitchClips, StitchError } from "../stitch";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stitchClips", () => {
  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  test("throws INVALID_ARGUMENTS with empty array", async () => {
    try {
      await stitchClips([], "/tmp/test-output.mp4");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      expect(err.code).toBe("INVALID_ARGUMENTS");
      expect(err.message).toContain("at least 2");
    }
  });

  test("throws INVALID_ARGUMENTS with single clip", async () => {
    try {
      await stitchClips(["/tmp/clip1.mp4"], "/tmp/test-output.mp4");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      expect(err.code).toBe("INVALID_ARGUMENTS");
      expect(err.message).toContain("at least 2");
    }
  });

  test("throws INVALID_ARGUMENTS with empty output path", async () => {
    try {
      await stitchClips(["/tmp/a.mp4", "/tmp/b.mp4"], "");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      expect(err.code).toBe("INVALID_ARGUMENTS");
      expect(err.message).toContain("non-empty");
    }
  });

  test("throws INVALID_ARGUMENTS with whitespace-only output path", async () => {
    try {
      await stitchClips(["/tmp/a.mp4", "/tmp/b.mp4"], "   ");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      expect(err.code).toBe("INVALID_ARGUMENTS");
    }
  });

  test("throws INVALID_ARGUMENTS with non-positive crossfade transition duration", async () => {
    try {
      await stitchClips(
        ["/tmp/a.mp4", "/tmp/b.mp4"],
        "/tmp/test-output.mp4",
        { transition: "crossfade", transitionDuration: 0 },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      expect(err.code).toBe("INVALID_ARGUMENTS");
      expect(err.message).toContain("positive");
    }
  });

  test("throws INVALID_ARGUMENTS with negative crossfade transition duration", async () => {
    try {
      await stitchClips(
        ["/tmp/a.mp4", "/tmp/b.mp4"],
        "/tmp/test-output.mp4",
        { transition: "crossfade", transitionDuration: -1 },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      expect(err.code).toBe("INVALID_ARGUMENTS");
    }
  });

  // -------------------------------------------------------------------------
  // Missing input files (validated after ffmpeg check)
  // -------------------------------------------------------------------------

  test("throws MISSING_INPUT when given nonexistent files", async () => {
    try {
      await stitchClips(
        [
          "/tmp/does-not-exist-abc123.mp4",
          "/tmp/does-not-exist-xyz789.mp4",
        ],
        "/tmp/test-stitch-output.mp4",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      // Could be FFMPEG_NOT_FOUND (if ffmpeg missing) or MISSING_INPUT
      // On CI without ffmpeg, this would be FFMPEG_NOT_FOUND.
      // On dev with ffmpeg, this would be MISSING_INPUT.
      expect(["MISSING_INPUT", "FFMPEG_NOT_FOUND"]).toContain(err.code);
    }
  });

  test("throws MISSING_INPUT listing all missing files", async () => {
    // Skip this test if ffmpeg is not available (test would get FFMPEG_NOT_FOUND instead)
    try {
      const proc = Bun.spawn(["which", "ffmpeg"], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        // ffmpeg not installed — skip
        return;
      }
    } catch {
      return;
    }

    try {
      await stitchClips(
        [
          "/tmp/missing-file-aaa.mp4",
          "/tmp/missing-file-bbb.mp4",
          "/tmp/missing-file-ccc.mp4",
        ],
        "/tmp/test-stitch-output.mp4",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      expect(err.code).toBe("MISSING_INPUT");
      expect(err.message).toContain("missing-file-aaa.mp4");
      expect(err.message).toContain("missing-file-bbb.mp4");
      expect(err.message).toContain("missing-file-ccc.mp4");
    }
  });

  // -------------------------------------------------------------------------
  // Options defaults
  // -------------------------------------------------------------------------

  test('defaults transition to "none"', async () => {
    // We can't actually stitch without real files, but we can verify the
    // validation passes — the error should be about missing files or ffmpeg,
    // not about invalid arguments.
    try {
      await stitchClips(
        ["/tmp/no-such-a.mp4", "/tmp/no-such-b.mp4"],
        "/tmp/test-output.mp4",
        {}, // empty options — should default transition to "none"
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const err = error as StitchError;
      // Should NOT be INVALID_ARGUMENTS — that would mean defaults didn't kick in
      expect(err.code).not.toBe("INVALID_ARGUMENTS");
    }
  });
});
