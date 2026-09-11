import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// Un solo frame a 1 segundo alcanza para el analisis de vision (src/ai/vision.ts) - no hace falta
// el video completo, y evita mandarle un archivo pesado a la API de vision (que solo acepta imagen).
export async function extractFrame(videoBuffer: Buffer): Promise<Buffer> {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `${id}-in.mp4`);
  const outputPath = join(tmpdir(), `${id}-out.jpg`);

  try {
    await writeFile(inputPath, videoBuffer);
    // -pix_fmt yuvj420p avoids "Non full-range YUV is non-standard" MJPEG encoder failures on some
    // full-range source videos (confirmed against a real ffmpeg-generated test video).
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-ss",
      "00:00:01",
      "-frames:v",
      "1",
      "-pix_fmt",
      "yuvj420p",
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}
