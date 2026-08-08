export {
  formatDSCodeError,
  runDSCode,
  runDSCodeProcess,
} from "./cli-runtime.js";
export { createDSCodeExtension } from "./dscode-extension.js";
export { registerDiscoveryCommands } from "./discovery.js";
export {
  createDSCodeRpcClient,
  getDSCodeRpcEntryPath,
  RpcClient,
  type DSCodeRpcClientOptions,
  type RpcClientOptions,
} from "./rpc-client.js";
export {
  authenticateProvider,
  getDSCodeAgentDir,
  getDSCodeAuthPath,
  hasDeepSeekEnvironmentKey,
  hasStoredDeepSeekKey,
  hasStoredProviderCredential,
  removeStoredDeepSeekKey,
  removeStoredProviderCredential,
  runAuthCommand,
  saveDeepSeekKey,
  saveProviderApiKey,
  validateDeepSeekKey,
  type ApiKeyProviderId,
  type KeyValidation,
  type ProviderLoginResult,
} from "./auth.js";
export type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
export {
  createDSCodeCredentialStore,
  FileCredentialStore,
  installDSCodeCredentialStore,
  KeyringCredentialStore,
  type CreateCredentialStoreOptions,
  type DSCodeKeyringFactory,
} from "./credential-store.js";
export {
  getDSCodeArchivedSessionsDir,
  getDSCodeHome,
  getDSCodeSessionsDir,
  initializeDSCodeHome,
  migrateLegacyDSCodeHome,
  partitionExistingSessions,
  partitionSessionFile,
  type PartitionedSessionPath,
} from "./home.js";
export {
  DSCodeStateStore,
  getDSCodeStatePath,
  indexDSCodeSession,
  listDSCodeThreads,
  type DSCodeThread,
  type ListThreadOptions,
} from "./state.js";
export {
  DEFAULT_DEEPSEEK_BASE_URL,
  getDSCodeStorageSettings,
  getDSCodeSettingsPath,
  getStoredDeepSeekBaseUrl,
  getStoredServiceTier,
  normalizeDeepSeekBaseUrl,
  saveDeepSeekBaseUrl,
  saveServiceTier,
  type CredentialStoreMode,
  type DSCodeStorageSettings,
  type HistoryPersistence,
} from "./settings.js";
export {
  MODEL_CREDENTIAL_ENV_KEYS,
  SUPPORTED_PROVIDER_IDS,
  buildModelGuidance,
  chooseRecommendedModel,
  defaultEffortForProvider,
  defaultModelForProvider,
  detectAvailableProviders,
  getStoredModelSelection,
  isSupportedProviderId,
  parseSupportedProviderId,
  providerDisplayName,
  providerEnvironmentKey,
  saveModelSelection,
  stripModelCredentialEnvironment,
  type ModelRecommendation,
  type StoredModelSelection,
  type SupportedProviderId,
} from "./providers.js";
export {
  parseRuntimeArgs,
  printDSCodeHelp,
  sandboxModeSchema,
  type DSCodeRuntimeOptions,
  type ParsedRuntimeArgs,
  type SandboxMode,
} from "./runtime-options.js";
export {
  SERVICE_TIERS,
  normalizeServiceTier,
  registerServiceTierControls,
  resolveActiveServiceTier,
  resolveProviderServiceTier,
  type ServiceTier,
} from "./service-tier.js";
export {
  formatWebSearchStatus,
  getWebSearchConfigPath,
  getWebSearchStatus,
  loadWebSearchConfig,
  resolveSearchMcpBinary,
  resolveWebSearchExecution,
  saveWebSearchConfig,
  type ResolvedWebSearchExecution,
  type WebSearchConfig,
  type WebSearchProvider,
  type WebSearchStatus,
} from "./web-search.js";
export {
  WebSearchError,
  executeWebSearch,
  formatWebSearchResponse,
  searchWithExa,
  searchWithPerplexity,
  searchWithSearchMcp,
  type SearchMcpLevel,
  type WebSearchExecOptions,
  type WebSearchExecProvider,
  type WebSearchHit,
  type WebSearchResponse,
} from "./web-search-providers.js";
export {
  CORE_PACKAGE_SOURCES,
  OPTIONAL_PACKAGE_PRESETS,
  formatPackageList,
  getPackageSources,
  listPackagePresets,
  resolvePackageUpdateSources,
  type OptionalPackagePresetName,
} from "./packages.js";
export { syncBundledAssets, type BootstrapSyncResult } from "./sync.js";
export {
  installSkills,
  formatInstallSkillsResult,
  resolveTargetDir,
  type InstallSkillsOptions,
  type InstallSkillsResult,
  type SkillInstallTarget,
} from "./skills-installer.js";
export { runSetupWizard } from "./setup.js";
export { DSCODE_VERSION } from "./version.js";
export { collectStatusSnapshot, runDoctor, runDoctorCli, type DoctorOptions, type DSCodeStatusSnapshot } from "./doctor.js";
export { createResearchRunReport, formatResearchRunMarkdown, type ResearchRunReport, type ResearchRunMetadata, type ResearchRunSection } from "./research-run.js";
export {
  searchArXiv,
  searchHuggingFaceModels,
  type ArXivResult,
  type HuggingFaceModelResult,
} from "./science-connectors.js";
export * from "./workbench-types.js";
export * from "./paper-rank.js";
