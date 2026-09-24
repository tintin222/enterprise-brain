/** Minimal RFC 5322 / MIME message builder for single-part text or HTML mail. */

export interface MimeMessage {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html?: boolean;
  inReplyTo?: string;
  references?: string;
}

/** Header values must never contain line breaks (header injection). */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encoded-words for non-ASCII header text, each word kept under 75 characters. */
export function encodeHeaderText(value: string): string {
  const clean = headerValue(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const char of clean) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = char;
    } else {
      chunk += char;
    }
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

export function buildMimeMessage(message: MimeMessage): string {
  const headers: string[] = [];
  if (message.from) headers.push(`From: ${headerValue(message.from)}`);
  headers.push(`To: ${message.to.map(headerValue).join(", ")}`);
  if (message.cc?.length) headers.push(`Cc: ${message.cc.map(headerValue).join(", ")}`);
  if (message.bcc?.length) headers.push(`Bcc: ${message.bcc.map(headerValue).join(", ")}`);
  headers.push(`Subject: ${encodeHeaderText(message.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${headerValue(message.inReplyTo)}`);
    headers.push(`References: ${headerValue(message.references ?? message.inReplyTo)}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push(`Content-Type: ${message.html ? "text/html" : "text/plain"}; charset="UTF-8"`);
  headers.push("Content-Transfer-Encoding: base64");
  const body = (Buffer.from(message.body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/** Decodes bytes in the given charset (falls back to UTF-8 for unknown charsets). */
export function decodeText(bytes: Uint8Array, charset?: string): string {
  try {
    return new TextDecoder(charset?.trim() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
