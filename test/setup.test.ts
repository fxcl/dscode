import { describe, expect, it } from "vitest";
import {
  isInteractiveTerminal,
  promptConfirm,
  promptSecret,
  promptSelect,
  promptText,
  SetupCancelledError,
} from "../packages/core/src/setup-prompts.js";
import { runSetupWizard } from "../packages/core/src/setup.js";

describe("isInteractiveTerminal", () => {
  it("reports false under the vitest runner (no real TTY)", () => {
    // The test process has piped stdin/stdout, so this must be false.
    expect(isInteractiveTerminal()).toBe(false);
  });
});

describe("SetupCancelledError", () => {
  it("uses the default message when none is given", () => {
    const error = new SetupCancelledError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SetupCancelledError");
    expect(error.message).toBe("setup cancelled");
  });

  it("preserves a custom message", () => {
    const error = new SetupCancelledError("user pressed ESC");
    expect(error.message).toBe("user pressed ESC");
  });
});

describe("prompt helpers in a non-interactive terminal", () => {
  // Every prompt helper calls ensureInteractiveTerminal(), which throws when
  // stdin/stdout are not TTYs. Under vitest they never are, so each helper
  // must reject immediately rather than hanging on readline input.

  it("promptText rejects with an interactive-terminal requirement", async () => {
    await expect(promptText("q")).rejects.toThrow(/interactive terminal/i);
  });

  it("promptSecret rejects with an interactive-terminal requirement", async () => {
    await expect(promptSecret("q")).rejects.toThrow(/interactive terminal/i);
  });

  it("promptSelect rejects with an interactive-terminal requirement", async () => {
    await expect(
      promptSelect("q", [{ value: "a", label: "A" }], "a"),
    ).rejects.toThrow(/interactive terminal/i);
  });

  it("promptConfirm rejects with an interactive-terminal requirement", async () => {
    await expect(promptConfirm("q")).rejects.toThrow(/interactive terminal/i);
  });
});

describe("runSetupWizard non-interactive guard", () => {
  it("completes without prompting when no TTY is attached", async () => {
    // In a non-interactive environment the wizard must short-circuit to a
    // guidance message and never enter the interactive prompt loop.
    await expect(runSetupWizard()).resolves.toBeUndefined();
  });
});
