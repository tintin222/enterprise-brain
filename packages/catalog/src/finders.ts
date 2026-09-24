import type { AgentTemplate, Catalog, DepartmentTemplate, ProcessTemplate, UseCase } from "@enterprise-brain/core";

/** Find an agent template by id ("hr.cv-screener") or slug ("hr-cv-screener"). */
export function findAgent(catalog: Catalog, idOrSlug: string): AgentTemplate | undefined {
  return catalog.agents.find((a) => a.id === idOrSlug) ?? catalog.agents.find((a) => a.slug === idOrSlug);
}

export function findProcess(catalog: Catalog, id: string): ProcessTemplate | undefined {
  return catalog.processes.find((p) => p.id === id);
}

export function findDepartment(catalog: Catalog, id: string): DepartmentTemplate | undefined {
  return catalog.departments.find((d) => d.id === id);
}

export function findUseCase(catalog: Catalog, id: string): UseCase | undefined {
  return catalog.useCases.find((u) => u.id === id);
}

/** Agent templates of a department, in catalog order (by process). */
export function agentsForDepartment(catalog: Catalog, departmentId: string): AgentTemplate[] {
  return catalog.agents.filter((a) => a.department === departmentId);
}

/** Process templates of a department, in the order the department lists them. */
export function processesForDepartment(catalog: Catalog, departmentId: string): ProcessTemplate[] {
  const order = findDepartment(catalog, departmentId)?.processes ?? [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return catalog.processes.filter((p) => p.department === departmentId).sort((a, b) => rank(a.id) - rank(b.id));
}

/** Agent templates a process lists, in the process's order. */
export function agentsForProcess(catalog: Catalog, processId: string): AgentTemplate[] {
  const process = findProcess(catalog, processId);
  if (!process) return [];
  return process.agents.map((id) => findAgent(catalog, id)).filter((a): a is AgentTemplate => a !== undefined);
}
