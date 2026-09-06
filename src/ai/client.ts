import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";

export const anthropic = new Anthropic({
  apiKey: env.anthropicApiKey,
});

export const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
