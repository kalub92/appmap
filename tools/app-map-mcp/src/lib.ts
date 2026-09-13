/**
 * Public library API — the one import surface shared by the server (03 §8), the CLI (03 §10)
 * and tests. Everything is re-exported by module so consumers can `import { identify } from
 * './lib.ts'`; the module map and ownership tags are in docs/dev/architecture.md.
 *
 * Import order below mirrors the dependency layers (no cycles):
 *   types/config/errors/paths/token/log → yaml,tree,scrub,signature → store,identify,resolve,
 *   plan,format → observe,recipes/*,heal,drift,router-import → server,cli.
 */

// ---- leaf -------------------------------------------------------------------------------------
export * from './types.ts';
export { CONFIG_DEFAULTS, ENV_VARS, LOG_LEVELS, PLATFORMS, RECOMPILE_MODES, configToEnv, driverToolPattern, isPlatform, loadConfig } from './config.ts';
export type { AppMapConfig, LogLevel, RecompileMode } from './config.ts';
export { AppMapError, ERROR_CODES, NotImplementedError, toErrorJson } from './errors.ts';
export type { ErrorCode, ErrorJson } from './errors.ts';
export * as paths from './paths.ts';
export type { SchemaKind, YamlKind } from './paths.ts';
export { TRUNCATION_MARKER, capTokens, estimateTokens, fitsTokens } from './token.ts';
export { LOG_ROTATE_BYTES, createLogger, createMemoryLogger, rotateIfNeeded, sanitizeFields } from './log.ts';
export type { LogFields, Logger, LoggerOptions } from './log.ts';

// ---- yaml / tree ------------------------------------------------------------------------------
export { CHILD_TYPES, ID_SORTED_LISTS, KEY_ORDER, SORTED_STRING_SETS, YAML_STRINGIFY_OPTIONS, canonicalYaml, canonicalize, isCanonical } from './yaml/canonical.ts';
export type { CanonicalType } from './yaml/canonical.ts';
export { assertValid, getValidator, loadSchemas, validateAgainstSchema, validateEventLine } from './yaml/schemas.ts';
export type { SchemaIssue, SchemaValidator } from './yaml/schemas.ts';
export { gitBlobHash, gitTreeHash, indexMap, loadMap, parseYamlFile, readAllowlist, readIds, readManifest, readRecipeFiles, readScreenFiles, readStaticStrings } from './yaml/load.ts';
export type { IndexMapInput, LoadMapOptions } from './yaml/load.ts';
export { crossReferenceIssues, forbiddenContentIssues, formatIssues, nonCanonicalFiles, safeRegexIssue, validateMap } from './validate.ts';
export type { CrossRefInput, ValidateOptions } from './validate.ts';
export { migrateId, rewriteIdReferences } from './migrate-id.ts';
export { mergeYamlDocuments, runMergeDriver } from './merge-driver.ts';
export * as tree from './tree.ts';
export type { TreeShape, Visitor } from './tree.ts';
export { PII_PATTERNS, buildScrubPolicy, findForbiddenContent, perceptionBytes, redactString, scrub } from './scrub.ts';
export { gateSignatureMatches, labelNorm, observedSignature, requiredIdsFraction, roleLabelMatches, structuralHash, titleOf } from './signature.ts';

// ---- store / map --------------------------------------------------------------------------------
export { AppMapDb, DB_SCHEMA_VERSION, DDL, RECOMPILE_DIRTY_PREFIX, isMachineRecompile, openDb } from './store/db.ts';
export type { CounterKind, CounterName, DirtyKind, DirtyRow, OpenDbOptions, RecipeStats, SessionRow } from './store/db.ts';
export { exportMap, renderEntities, unifiedDiff } from './store/export.ts';
export type { ExportOptions } from './store/export.ts';
export { appendEvent, parseEventLine, pruneLocal, readEvents } from './events.ts';
export type { EventSink, PruneResult, ReadEventsOptions } from './events.ts';
export { openContext } from './context.ts';
export type { AppMapContext, OpenContextOptions } from './context.ts';
export { DECAY_FACTOR, DECAY_FLOOR, buildsSince, combineSignals, decayConfidence, evaluateCondition, identify, scoreScreen } from './identify.ts';
export { disambiguate, findElement, findElementDef, queryLocator, resolve, targetFor } from './resolve.ts';
export type { ResolveOptions } from './resolve.ts';
export { planPath, shortestEdgePath } from './plan.ts';
export * as format from './format.ts';

// ---- session ------------------------------------------------------------------------------------
export { declareTask, finishTask, hookPayloadToObservation, inferTaskOutcome, ingestObservation, isDriverTool, lastObservation, nameScreen, readTrajectory, recordHookPayload, recordObservation } from './observe.ts';
export { MATCH_CONFIDENCE, eligibleRecipes, inferParams, matchRecipe, paramsNeeded } from './recipes/match.ts';
export * as compile from './recipes/compile.ts';
export { ARGENT_VERBS, DRIVER_VERBS, UNIVERSAL_VERBS, bareToolName, classifyVerb, isStepVerb, normalizeVerb } from './recipes/verbs.ts';
export type { DriverVerbTable, StepVerb, VerbKind } from './recipes/verbs.ts';
export { THRESHOLDS, conditionKey, decideTransition, deepLinkCovers, eligibleForCiGate, markRecipe, markVerified, recompileCovers, recompileCoversEntry, recordRunOutcome, retireRecipesForScreen, screensReferenced, shouldRecompile, stepIdentity } from './recipes/lifecycle.ts';
export type { LifecycleDecision, RecompileOutcome, RecompileRefusal, VerifiedEntities } from './recipes/lifecycle.ts';
export { COMPATIBLE_ROLES, applyHeal, bboxProximity, heal, healedElement, jaroWinkler, lcsLength, proposeHeal, rejectHeal, scoreCandidates, toPendingHeal } from './heal.ts';
export type { HealProposal } from './heal.ts';
export { assertDebugSandbox, checkExpect, defaultBuildProbe, expandSteps, reportStep, resolveRunSession, startGuidedRun, substituteParams, toRunStep } from './recipes/guided.ts';
export type { BuildInfoProbe, GuidedRunOptions, StartGuidedRunInput } from './recipes/guided.ts';
export { maestroExport, maestroSelectorFor, readParamsFile, recipeToMaestroFlow, resolveRecipeParams, stepForCommandIndex } from './recipes/maestro.ts';
export type { FlowOptions, MaestroExportOptions, MaestroFlow, MaestroSelector } from './recipes/maestro.ts';
export { checkMaestroVersion, defaultExec, defaultHierarchy, fallbackStepFor, parseMaestroResult, runAllHeadless, runHeadless } from './recipes/headless.ts';
export type { ExecFn, ExecResult, HeadlessInput, HeadlessOptions, HierarchyProvider } from './recipes/headless.ts';
export { ciGateScreens, compareScreen, driftTour, formatDriftTable, summarize } from './drift.ts';
export type { DriftOptions } from './drift.ts';
export { importRouter, mergeRouterScreen, routerScreenToScreenFile } from './router-import.ts';
export type { ImportRouterOptions } from './router-import.ts';

// ---- top ------------------------------------------------------------------------------------------
export { RESOURCE_TEMPLATES, SERVER_NAME, TOOL_NAMES, createServer, startServer, toolError, toolJson, toolText } from './server.ts';
export type { RunningServer, ToolName, ToolResult } from './server.ts';
export { INGEST_TIMEOUT_MS, MAX_REQUEST_BYTES, parseRequestLine, postToIngestSocket, startIngestServer } from './ingest-socket.ts';
export type { IngestResponse, IngestServer } from './ingest-socket.ts';
export { KIND_SYNONYMS, constantNames, findStringLiteralIds, lintIds } from './lint-ids.ts';
export type { LintIdsOptions } from './lint-ids.ts';
export { genConfigs } from './gen-configs.ts';
export { intentCriticalDiff, policyCheck } from './policy-check.ts';
export type { IntentCriticalDiffOptions, PolicyCheckOptions } from './policy-check.ts';
export { computeMetrics, formatReport, report } from './report.ts';
