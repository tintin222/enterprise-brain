/**
 * @enterprise-brain/catalog: the template catalog (departments, processes,
 * predefined agents, default use cases) and its validating loader.
 *
 *   const catalog = await loadCatalog();          // throws CatalogError on schema problems
 *   const problems = validateCatalog(catalog);    // cross-reference checks
 *   searchCatalog(catalog, "özgeçmişleri değerlendiren bir ajan")[0].id  // "hr.cv-screener"
 */
export type { Catalog } from "@enterprise-brain/core";
export {
  CatalogError,
  DEFAULT_CATALOG_DIR,
  DEPARTMENT_ORDER,
  USE_CASE_ORDER,
  loadCatalog,
  type LoadCatalogOptions,
} from "./loader.ts";
export { NON_REPLACEABLE_BUILDER_NODES, SHARED_SERVICES_DEPARTMENT, validateCatalog } from "./validate.ts";
export {
  agentsForDepartment,
  agentsForProcess,
  findAgent,
  findDepartment,
  findProcess,
  findUseCase,
  processesForDepartment,
} from "./finders.ts";
export {
  normalizeSearchText,
  searchCatalog,
  searchTokens,
  type CatalogEntityKind,
  type CatalogSearchResult,
  type SearchCatalogOptions,
} from "./search.ts";
export {
  SANDBOX_CATEGORIES,
  SANDBOX_SYSTEMS,
  enumKey,
  findSandboxOperation,
  isAllowedValue,
  sandboxOperationsFor,
  type SandboxOperation,
  type SandboxSystem,
} from "./sandbox-operations.ts";
export {
  BUILTIN_CAPABILITIES,
  capabilityCovered,
  isBuiltinCapability,
  parseConnectorCapability,
  stepCapabilities,
  type BuiltinCapability,
} from "./capabilities.ts";
export { FrontmatterError, splitFrontmatter, type FrontmatterDocument } from "./frontmatter.ts";
export { sourceOf } from "./sources.ts";
