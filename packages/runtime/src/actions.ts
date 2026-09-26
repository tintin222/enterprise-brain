import type { ConnectorService, ExecuteOptions } from "./connectors.ts";
import type { MailService } from "./mail.ts";
import type { ApprovalAction } from "./run-types.ts";

/** Executes an approved side-effecting action. */
export async function executeAction(
  deps: { connectors: ConnectorService; mail: MailService },
  companyId: string,
  action: ApprovalAction,
  options: ExecuteOptions = {},
): Promise<unknown> {
  switch (action.type) {
    case "decision":
      return { approved: true };
    case "connector": {
      const resolved = await deps.connectors.resolve(companyId, {
        ref: action.ref,
        category: action.category,
        instanceId: action.instanceId,
      });
      return deps.connectors.execute(companyId, resolved, action.operation, action.input, options);
    }
    case "mail.send": {
      const sent = await deps.mail.send(companyId, {
        to: action.to,
        subject: action.subject,
        body: action.body,
        inReplyTo: action.inReplyTo,
        mailbox: action.mailbox,
        taskId: action.taskId,
      });
      return { sent: true, messageId: sent.messageId, delivery: sent.delivery, to: action.to, subject: action.subject };
    }
  }
}

/** Human-readable description of an action for the approval inbox. */
export function describeAction(action: ApprovalAction): string {
  switch (action.type) {
    case "decision":
      return "Decision requested";
    case "connector":
      return `${action.system ?? action.ref}: ${action.operationName ?? action.operation}\n\n${JSON.stringify(action.input, null, 2)}`;
    case "mail.send":
      return `To: ${action.to}\nSubject: ${action.subject}\n\n${action.body}`;
  }
}
