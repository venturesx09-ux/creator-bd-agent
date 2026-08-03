import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) {
      throw new Error("SecretBox requires a 32-byte key");
    }
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64")
    ].join(".");
  }

  decrypt<T>(encrypted: string): T {
    const [version, ivValue, tagValue, ciphertextValue, extra] =
      encrypted.split(".");
    if (
      version !== VERSION ||
      !ivValue ||
      !tagValue ||
      !ciphertextValue ||
      extra !== undefined
    ) {
      throw new Error("Unsupported encrypted value");
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(ivValue, "base64")
      );
      decipher.setAuthTag(Buffer.from(tagValue, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64")),
        decipher.final()
      ]).toString("utf8");
      return JSON.parse(plaintext) as T;
    } catch {
      throw new Error("Unable to decrypt stored value");
    }
  }
}
