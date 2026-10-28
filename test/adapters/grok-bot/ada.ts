// The Bot the Grok Bot write tests hand over: persona, instructions, two skills (one with a
// second file), three facts and three routines (an enabled cron, a paused interval, a one-off).
import type { Bundle } from "../../../src/core/schema.js";

export const ADA_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
/** Another agent that is also called Ada. */
export const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V";

const encoder = new TextEncoder();
export const bytes = (text: string): Uint8Array => encoder.encode(text);

export function adaBundle(): Bundle {
  return {
    manifest: {
      schemaVersion: "0.1",
      id: ADA_ID,
      name: "Ada",
      title: "Research assistant",
      models: [{ provider: "anthropic", model: "claude-opus-5-5" }],
      capabilities: [],
    },
    persona: "Curious, precise and brief.",
    instructions: "Read the papers first.\nThen summarise them.",
    skills: [
      {
        name: "web-brief",
        files: [
          {
            path: "SKILL.md",
            bytes: bytes("---\nname: web-brief\ndescription: Brief a page.\n---\n\n# Web brief\n"),
          },
          { path: "references/checklist.md", bytes: bytes("- Who wrote it?\n- When?\n") },
        ],
      },
      {
        name: "triage",
        files: [
          {
            path: "SKILL.md",
            bytes: bytes("---\nname: triage\ndescription: Sort the inbox.\n---\n\n# Triage\n"),
          },
        ],
      },
    ],
    routines: [
      {
        name: "Morning digest",
        instruction: "Summarise the news.\nKeep it to five lines.\n",
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "cron", expression: "0 8 * * 1-5" },
      },
      {
        name: "Half hourly check",
        instruction: "Check the inbox.",
        enabled: false,
        timezone: "UTC",
        schedule: { kind: "every", every: "30m" },
      },
      {
        name: "Launch day",
        instruction: "Post the launch note.",
        enabled: true,
        timezone: "UTC",
        schedule: { kind: "at", at: "2026-12-01T07:00:00.000Z" },
      },
    ],
    facts: ["Prefers short answers", "Works in Europe/Warsaw", "Reads papers on Fridays"],
    notes: [],
    files: [],
    unknownPaths: [],
  };
}
