import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFrame } from "./videoFrame";

const execFileAsync = promisify(execFile);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

// ffmpeg is not installed on every dev machine (it's a droplet-only system dependency, see the plan's
// deploy notes) - each test skips itself at runtime instead of failing CI/local runs where it's absent.
// Real coverage runs on the droplet once ffmpeg is installed there.

test("extractFrame produces a real JPEG from a video buffer", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg not installed on this machine");
    return;
  }

  const id = randomUUID();
  const videoPath = join(tmpdir(), `${id}-source.mp4`);
  try {
    // Generates a tiny 1-second synthetic video with ffmpeg itself (lavfi source) - no need to ship
    // a binary test fixture.
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=3:r=5", videoPath]);
    const videoBuffer = await readFile(videoPath);

    const frame = await extractFrame(videoBuffer);
    assert.ok(frame.length > 0, "expected a non-empty frame buffer");
    // JPEG magic bytes
    assert.equal(frame[0], 0xff);
    assert.equal(frame[1], 0xd8);
  } finally {
    await unlink(videoPath).catch(() => {});
  }
});

test("extractFrame throws (does not hang or silently return empty) on garbage input", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg not installed on this machine");
    return;
  }

  await assert.rejects(() => extractFrame(Buffer.from("not a real video")));
});
