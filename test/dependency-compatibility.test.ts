/** Patched transitive APIs exercised with synthetic local data, without models. */
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const onnxRequire = createRequire(require.resolve("onnxruntime-node/package.json"));
const transformersRequire = createRequire(require.resolve("@huggingface/transformers"));

describe("patched transitive dependency compatibility", () => {
  it("preserves ONNX installer ZIP entry lookup and flattened extraction", async () => {
    const AdmZip = onnxRequire("adm-zip");
    const dir = await mkdtemp(join(tmpdir(), "experience-zip-"));
    try {
      const source = new AdmZip();
      source.addFile("runtimes/synthetic/native/library.bin", Buffer.from("synthetic binary fixture"));
      const archive = new AdmZip(source.toBuffer());
      const entry = archive.getEntry("runtimes/synthetic/native/library.bin");
      expect(entry).not.toBeNull();
      archive.extractEntryTo(entry, dir, false, true);
      expect(await readFile(join(dir, "library.bin"), "utf8")).toBe("synthetic binary fixture");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("decodes and resizes an image through Transformers' real Sharp adapter", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("network forbidden in compatibility test"); });
    try {
      const sharp = transformersRequire("sharp");
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
      const { RawImage, env } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      const image = await RawImage.fromBlob(new Blob([png], { type: "image/png" }));
      expect([image.width, image.height, image.channels]).toEqual([2, 2, 3]);
      const resized = await image.resize(1, 1);
      expect(Array.from(resized.data)).toEqual([255, 0, 0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
