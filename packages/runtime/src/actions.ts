import type { ConnectorService, ExecuteOptions } from "./connectors.ts";
import type { MailService } from "./mail.ts";
import type { ApprovalAction, ChatPoster } from "./run-types.ts";

const VIA_NAMES: Record<string, string> = { teams: "Microsoft Teams", "google-chat": "Google Chat" };

/** Executes an approved side-effecting action. */
export async function executeAction(
  deps: { connectors: ConnectorService; mail: MailService; chat?: ChatPoster },
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
    case "chat.send": {
      if (!deps.chat) throw new Error("Chat is not available here");
      const posted = await deps.chat.post({
        companyId,
        agentId: action.agentId,
        to: action.to,
        via: action.via,
        text: action.text,
        taskId: action.taskId,
        runId: action.runId,
      });
      return { sent: true, to: action.to, ...posted };
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
    case "chat.send":
      return `To: ${action.to}${action.via && action.via !== "chat" ? ` in ${VIA_NAMES[action.via] ?? action.via}` : ""}\n\n${action.text}`;
  }
}
