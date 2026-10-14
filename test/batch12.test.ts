import { afterEach, describe, expect, it } from "vitest";
import {
  resolveSandboxBackend,
  sandboxDescription,
  sandboxUnavailableGuidance,
  type SandboxOptions,
} from "../packages/core/src/sandbox.js";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

const workspaceWrite: SandboxOptions = { mode: "workspace-write", network: false };

describe("adaptive sandbox backend resolution", () => {
  it("reports host access for danger-full-access with no probing", () => {
    const resolution = resolveSandboxBackend({ mode: "danger-full-access", network: true });
    expect(resolution.backend).toBe("host");
    expect(resolution.description).toBe("host access");
    expect(resolution.reason).toBeUndefined();
    expect(sandboxUnavailableGuidance({ mode: "danger-full-access", network: true })).toBeUndefined();
  });

  it("always explains the situation when no backend is available", () => {
    delete process.env.DSCODE_SANDBOX_IMAGE;
    delete process.env.DSCODE_WINDOWS_SANDBOX;
    const resolution = resolveSandboxBackend(workspaceWrite);
    const available =
      process.platform === "darwin" || (process.platform === "win32" && resolution.backend === "windows-native");
    if (available) {
      expect(resolution.backend).not.toBe("unavailable");
      return;
    }
    expect(resolution.backend).toBe("unavailable");
    expect(resolution.reason).toBeTruthy();
    // Guidance must name the platform and a concrete next step.
    expect(resolution.reason).toContain(process.platform);
    expect(resandbox(resolution.reason!)).toBe(true);
  });

  it("gives Windows-specific guidance naming the three distinct root causes", () => {
    if (process.platform !== "win32") return;
    delete process.env.DSCODE_WINDOWS_SANDBOX;
    delete process.env.DSCODE_SANDBOX_IMAGE;

    // Never opted in.
    const notEnabled = resolveSandboxBackend(workspaceWrite);
    expect(notEnabled.backend).toBe("unavailable");
    expect(notEnabled.description).toContain("not-enabled");
    expect(notEnabled.reason).toContain("DSCODE_WINDOWS_SANDBOX=1");
    expect(notEnabled.reason).toContain("dscode sandbox setup");
    expect(notEnabled.reason).toContain("--sandbox danger-full-access");

    // Opted in, helper compiled, setup pending (or helper absent on a source checkout).
    process.env.DSCODE_WINDOWS_SANDBOX = "1";
    const optedIn = resolveSandboxBackend(workspaceWrite);
    expect(optedIn.backend).toBe("unavailable");
    expect(["helper-missing", "not-set-up"]).toContain(
      optedIn.description.replace(/ \(workspace-write\)$/, "").replace("Windows native sandbox ", ""),
    );
    expect(optedIn.reason).toMatch(/build:windows-sandbox|dscode sandbox setup/);
  });

  it("reports the Docker backend when an image is configured and docker exists", () => {
    if (process.platform === "win32") return;
    if (process.platform === "darwin" && sandboxDescription(workspaceWrite).startsWith("Seatbelt")) return;
    process.env.DSCODE_SANDBOX_IMAGE = "trusted-sandbox:latest";
    const resolution = resolveSandboxBackend(workspaceWrite);
    // Either docker is installed (docker backend) or not (still unavailable),
    // but the description must stay consistent with the guidance contract.
    if (resolution.backend === "unavailable") {
      expect(resolution.reason).toContain("DSCODE_SANDBOX_IMAGE");
    } else {
      expect(resolution.description).toContain("Docker trusted-sandbox:latest");
    }
  });

  it("keeps network state visible in the description", () => {
    delete process.env.DSCODE_SANDBOX_IMAGE;
    delete process.env.DSCODE_WINDOWS_SANDBOX;
    const withNetwork = resolveSandboxBackend({ mode: "workspace-write", network: true });
    if (withNetwork.backend !== "unavailable") expect(withNetwork.description).toContain("+ network");
  });
});

function resandbox(text: string): boolean {
  // Every unavailable reason must offer a concrete instruction, not a dead end.
  return /--sandbox danger-full-access|DSCODE_SANDBOX_IMAGE|dscode sandbox setup/.test(text);
}
