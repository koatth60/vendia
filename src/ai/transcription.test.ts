import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { groq, transcribeAudio } from "./transcription";

// Regression coverage for the retry-on-transient-error fix: a thrown error (network blip, 5xx) used to
// collapse into the exact same silent "" result as genuinely unclear audio, with zero recovery attempt.

let originalCreate: typeof groq.audio.transcriptions.create;

beforeEach(() => {
  originalCreate = groq.audio.transcriptions.create.bind(groq.audio.transcriptions);
});

afterEach(() => {
  groq.audio.transcriptions.create = originalCreate;
});

test("transcribeAudio retries once after a thrown error and returns the transcript on success", async () => {
  let calls = 0;
  // @ts-expect-error stubbing for the test, real signature is wider than we need here
  groq.audio.transcriptions.create = async () => {
    calls++;
    if (calls === 1) throw new Error("simulated transient Groq failure");
    return { text: "hola quiero el producto" };
  };

  const result = await transcribeAudio(Buffer.from("fake-audio"), "audio/ogg");
  assert.equal(result, "hola quiero el producto");
  assert.equal(calls, 2, "expected exactly one retry after the first failure");
});

test("transcribeAudio gives up and returns empty string after two consecutive failures (no infinite retry)", async () => {
  let calls = 0;
  // @ts-expect-error stubbing for the test
  groq.audio.transcriptions.create = async () => {
    calls++;
    throw new Error("simulated persistent Groq failure");
  };

  const result = await transcribeAudio(Buffer.from("fake-audio"), "audio/ogg");
  assert.equal(result, "");
  assert.equal(calls, 2, "expected exactly two attempts total, not an unbounded retry loop");
});

test("transcribeAudio succeeds on the first try without a wasted retry call", async () => {
  let calls = 0;
  // @ts-expect-error stubbing for the test
  groq.audio.transcriptions.create = async () => {
    calls++;
    return { text: "todo bien" };
  };

  const result = await transcribeAudio(Buffer.from("fake-audio"), "audio/ogg");
  assert.equal(result, "todo bien");
  assert.equal(calls, 1);
});
