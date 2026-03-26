/**
 * Mock video provider — returns a minimal fake MP4 for testing.
 *
 * The buffer starts with a valid `ftyp` box (ISO base media file format)
 * so basic MP4 detection tools will recognise the output.
 */

import type {
  VideoProvider,
  GenerateClipOptions,
  GenerateClipResult,
} from "./types";

export class MockProvider implements VideoProvider {
  readonly name = "mock";
  readonly description = "Mock video provider for testing";
  readonly models = ["mock-v1"];

  isConfigured(): boolean {
    return true;
  }

  async generateClip(
    prompt: string,
    options?: GenerateClipOptions,
  ): Promise<GenerateClipResult> {
    // Minimal valid ftyp box: 28 bytes
    //   size (4 bytes): 0x0000001C = 28
    //   type (4 bytes): "ftyp"
    //   major_brand (4 bytes): "isom"
    //   minor_version (4 bytes): 0x00000200
    //   compatible_brands (8 bytes): "isomiso2"
    // Then a minimal mdat box: 8 bytes (empty)
    const ftyp = Buffer.from([
      // ftyp box
      0x00, 0x00, 0x00, 0x1c, // size = 28
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x69, 0x73, 0x6f, 0x6d, // "isom"
      0x00, 0x00, 0x02, 0x00, // minor_version = 512
      0x69, 0x73, 0x6f, 0x6d, // "isom"
      0x69, 0x73, 0x6f, 0x32, // "iso2"
      0x6d, 0x70, 0x34, 0x31, // "mp41"
      // mdat box (empty)
      0x00, 0x00, 0x00, 0x08, // size = 8
      0x6d, 0x64, 0x61, 0x74, // "mdat"
    ]);

    return {
      buffer: ftyp,
      mimeType: "video/mp4",
      model: "mock-v1",
      prompt: prompt.trim(),
      metadata: {
        provider: "mock",
        duration: options?.duration ?? 8,
        aspectRatio: options?.aspectRatio ?? "16:9",
      },
    };
  }
}
