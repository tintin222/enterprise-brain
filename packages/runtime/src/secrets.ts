import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * AES-256-GCM encryption for connector credentials and other secrets at rest.
 * The master key comes from EB_MASTER_KEY or a key file generated on first
 * start (same approach as Paperclip's local_encrypted secrets provider).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    this.key = createHash("sha256").update(masterKey).digest();
  }

  static fromEnvOrFile(keyFile: string, env: NodeJS.ProcessEnv = process.env): SecretBox {
    if (env.EB_MASTER_KEY) return new SecretBox(env.EB_MASTER_KEY);
    if (existsSync(keyFile)) return new SecretBox(readFileSync(keyFile, "utf8").trim());
    mkdirSync(dirname(keyFile), { recursive: true });
    const generated = randomBytes(32).toString("base64");
    writeFileSync(keyFile, generated, { mode: 0o600 });
    return new SecretBox(generated);
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
  }

  decrypt<T = unknown>(payload: string): T {
    const [version, iv, tag, data] = payload.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported secret payload");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }
}
