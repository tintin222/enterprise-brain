import type { WorkflowStep } from "@enterprise-brain/core";
import type { ExecutionScope, StepOutcome } from "../run-types.ts";
import type { ToolDeps } from "../tools.ts";
import { runAgentStep } from "./agent-step.ts";
import {
  runApproval,
  runConnector,
  runExcelRead,
  runExcelWrite,
  runExtract,
  runKnowledgeSearch,
  runMailSend,
  runOutput,
  runWait,
} from "./io-steps.ts";
import { runCode, runTransform } from "./control-steps.ts";
import { runLlmClassify, runLlmEvaluate, runLlmExtract, runLlmGenerate } from "./llm-steps.ts";

export async function executeStep(step: WorkflowStep, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  switch (step.type) {
    case "extract":
      return runExtract(step, scope, deps);
    case "llm.extract":
      return runLlmExtract(step, scope, deps);
    case "llm.classify":
      return runLlmClassify(step, scope, deps);
    case "llm.evaluate":
      return runLlmEvaluate(step, scope, deps);
    case "llm.generate":
      return runLlmGenerate(step, scope, deps);
    case "knowledge.search":
      return runKnowledgeSearch(step, scope, deps);
    case "connector":
      return runConnector(step, scope, deps);
    case "approval":
      return runApproval(step, scope);
    case "mail.send":
      return runMailSend(step, scope, deps);
    case "excel.read":
      return runExcelRead(step, scope, deps);
    case "excel.write":
      return runExcelWrite(step, scope, deps);
    case "agent":
      return runAgentStep(step, scope, deps);
    case "wait":
      return runWait(step, scope);
    case "output":
      return runOutput(step, scope);
    case "branch":
    case "each":
      // Steps that hold steps are run by the engine, which runs what they hold.
      throw new Error(`Step "${step.id}" (${step.type}) holds other steps and is run by the engine`);
    case "transform":
      return runTransform(step, scope);
    case "code":
      return runCode(step, scope);
    case "call":
    case "chat.send":
    case "respond":
      throw new Error(`Step "${step.id}": ${step.type} steps are not available yet`);
  }
}

export { mergeUsage } from "./llm-steps.ts";
export { carryUsage, usageOfError } from "./io-steps.ts";
export { TOOL_GUIDANCE } from "./agent-step.ts";
