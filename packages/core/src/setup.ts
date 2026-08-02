import process from "node:process";
import pc from "picocolors";
import type { AuthEvent, AuthInteraction } from "@earendil-works/pi-ai";
import { authenticateProvider, getDSCodeAuthPath, saveDeepSeekKey, validateDeepSeekKey } from "./auth.js";
import { getDSCodeHome } from "./home.js";
import {
  chooseRecommendedModel,
  detectAvailableProviders,
  providerDisplayName,
  saveModelSelection,
  SUPPORTED_PROVIDER_IDS,
  type SupportedProviderId,
  getStoredModelSelection,
  defaultModelForProvider,
} from "./providers.js";
import {
  isInteractiveTerminal,
  promptIntro,
  promptOutro,
  promptSelect,
  promptText,
  promptSecret,
  SetupCancelledError,
  promptConfirm,
  type PromptSelectOption,
} from "./setup-prompts.js";
import { printAsciiHeader, printPanel, printInfo, printSuccess } from "./terminal-ui.js";
import { saveDeepSeekBaseUrl, DEFAULT_DEEPSEEK_BASE_URL } from "./settings.js";

function printNonInteractiveSetupGuidance(): void {
  printInfo("Non-interactive terminal detected. Use explicit commands:");
  printInfo("  dscode login <provider>");
  printInfo("  dscode --provider <id> --model <id>");
  printInfo("  # or configure API keys via env vars and rerun `dscode auth status`");
}

export async function runSetupWizard(): Promise<void> {
  if (!isInteractiveTerminal()) {
    printNonInteractiveSetupGuidance();
    return;
  }

  try {
    printAsciiHeader(["Setup Wizard"]);
    await promptIntro("DSCode Setup");

    // 1. Provider Selection
    printPanel("1. Provider Selection", ["Choose the AI provider you want to configure."]);
    
    const detected = detectAvailableProviders();
    if (detected.length > 0) {
      printInfo(`Detected API keys for: ${detected.map((id) => providerDisplayName(id)).join(", ")}`);
    } else {
      printInfo("No provider API keys detected in environment.");
    }

    const providerOptions: PromptSelectOption<SupportedProviderId | "skip">[] = [
      ...SUPPORTED_PROVIDER_IDS.map(id => ({
        value: id,
        label: providerDisplayName(id),
      })),
      { value: "skip", label: "Skip this step" }
    ];

    const currentSelection = getStoredModelSelection();

    const selectedProvider = await promptSelect(
      "Select a provider to authenticate:",
      providerOptions,
      currentSelection?.providerId
    );

    let finalProviderId: SupportedProviderId | undefined;

    // 2. Auth
    if (selectedProvider !== "skip") {
      finalProviderId = selectedProvider;
      printPanel("2. Authentication", [`Configuring ${providerDisplayName(selectedProvider)}`]);
      
      if (selectedProvider === "deepseek") {
        printInfo("DeepSeek requires an API key.");
        const key = await promptSecret("DeepSeek API key (will be masked)");
        if (!key.trim()) {
          throw new SetupCancelledError("API key setup cancelled");
        }

        // 3. Base URL Configuration
        const baseUrl = await promptText(
          "API base URL (optional, press Enter to use default)", 
          DEFAULT_DEEPSEEK_BASE_URL
        );

        const modelId = defaultModelForProvider("deepseek");
        process.stdout.write(pc.dim(`Validating key with ${baseUrl}...\n`));
        
        const validation = await validateDeepSeekKey(key, baseUrl, modelId);
        if (validation.status === "invalid") {
           printInfo(`${pc.red("failed")} ${validation.message}`);
           const saveAnyway = await promptConfirm("Save this key anyway?", false);
           if (!saveAnyway) throw new SetupCancelledError("Setup cancelled due to invalid key.");
        } else if (validation.status === "unverified") {
           printInfo(`${pc.yellow("could not verify")} ${validation.message}`);
           const saveAnyway = await promptConfirm("Save this key anyway?", false);
           if (!saveAnyway) throw new SetupCancelledError("Setup cancelled.");
        } else {
           printSuccess("Key verified successfully.");
        }
        
        await saveDeepSeekKey(key);
        await saveDeepSeekBaseUrl(baseUrl);

      } else if (selectedProvider === "amazon-bedrock") {
        printInfo("Amazon Bedrock uses AWS credentials.");
        try {
          // @ts-ignore
          const { fromNodeProviderChain } = await import("@aws-sdk/credential-provider-node");
          await fromNodeProviderChain()();
          printSuccess(`${providerDisplayName(selectedProvider)} authenticated via AWS credential chain.`);
        } catch (error) {
          printInfo(`Authentication failed: ${(error as Error).message}. Please configure AWS credentials.`);
        }
      } else {
        const interaction: AuthInteraction = {
          prompt: async (prompt) => {
            if (prompt.type === "secret") {
              return promptSecret(prompt.message);
            }
            if (prompt.type === "select") {
              return promptSelect(
                prompt.message,
                prompt.options.map<PromptSelectOption<string>>((opt) => {
                  const option: PromptSelectOption<string> = {
                    value: opt.id,
                    label: opt.label,
                  };
                  if (opt.description) option.hint = opt.description;
                  return option;
                })
              );
            }
            return promptText(prompt.message, "", prompt.placeholder);
          },
          notify: (event: AuthEvent) => {
            if (event.type === "auth_url") {
              printInfo(`${event.instructions ?? "Complete login in your browser."}`);
              printInfo(event.url);
            } else if (event.type === "device_code") {
              printInfo(`Open ${event.verificationUri} and enter code ${event.userCode}.`);
            } else if (event.type === "info") {
              printInfo(event.message);
            }
          },
        };
        try {
          await authenticateProvider(selectedProvider, interaction);
          printSuccess(`${providerDisplayName(selectedProvider)} authenticated.`);
        } catch (error) {
          printInfo(`Authentication failed: ${(error as Error).message}`);
        }
      }
    }

    // 4. Model Selection
    printPanel("3. Model Selection", ["Set your default model"]);
    const available = detectAvailableProviders();
    const recommendation = chooseRecommendedModel(available);
    
    if (recommendation) {
      printInfo(`Recommended: ${recommendation.providerId}/${recommendation.modelId} — ${recommendation.reason}`);
      const useRecommendation = await promptConfirm("Use recommended model as default?", true);
      
      if (useRecommendation) {
        saveModelSelection(recommendation.providerId, recommendation.modelId);
        printSuccess(`Default model set to ${recommendation.providerId}/${recommendation.modelId}.`);
      } else {
        printInfo("Default model unchanged. You can set it manually via DSCODE_PROVIDER and DSCODE_MODEL env vars.");
      }
    } else {
      printInfo("No authenticated providers available for recommendation.");
      printInfo("Set DSCODE_PROVIDER and DSCODE_MODEL env vars, or run `dscode login <provider>`.");
    }

    // 5. Settings Summary
    printPanel("4. Summary", ["Setup complete!"]);
    printInfo(`Config directory: ${getDSCodeHome()}`);
    const finalSelection = getStoredModelSelection();
    if (finalSelection) {
      printInfo(`Default Provider: ${finalSelection.providerId}`);
      if (finalSelection.modelId) {
        printInfo(`Default Model: ${finalSelection.modelId}`);
      }
    }
    printInfo("Run `dscode` to start coding, or `dscode --help` for all options.");
    
    await promptOutro("DSCode setup is complete.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      printInfo("\nSetup cancelled.");
      return;
    }
    throw error;
  }
}
