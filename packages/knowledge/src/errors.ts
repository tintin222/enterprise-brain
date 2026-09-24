export class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "validation" = "validation",
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}
