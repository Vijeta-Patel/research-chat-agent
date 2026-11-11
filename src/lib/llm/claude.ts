import { config } from "@/lib/config";
import { agentSdkRuntime } from "@/lib/llm/agent-sdk";
import { messagesApiRuntime } from "@/lib/llm/messages-api";
import type { GenerateHooks, GenerateInput, GenerateResult, Runtime } from "@/lib/llm/shared";

export type { GenerateHooks, GenerateInput, GenerateResult } from "@/lib/llm/shared";

// The model: Claude. Two interchangeable ways to reach it, same prompt, same
// one tool, same guardrails — only who runs the model ⇄ tool loop differs:
//   agent-sdk.ts     the Claude Agent SDK's loop (primary) — runs on an API key
//                    or on a local Claude Code login. The project was built
//                    without an API key, so this is the path that has been
//                    exercised end to end.
//   messages-api.ts  our own loop on the Messages API — CLAUDE_RUNTIME=api,
//                    needs ANTHROPIC_API_KEY.

export const runtime = (): Runtime => (config.claudeRuntime === "api" ? messagesApiRuntime : agentSdkRuntime);

export const generate = (input: GenerateInput, hooks: GenerateHooks): Promise<GenerateResult> => runtime().generate(input, hooks);
export const complete = (system: string, prompt: string): Promise<string> => runtime().complete(system, prompt);
export const describeError = (err: unknown): string => runtime().describeError(err);
