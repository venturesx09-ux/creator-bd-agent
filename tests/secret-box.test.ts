import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SecretBox } from "../src/secret-box.js";

describe("SecretBox", () => {
  it("encrypts and decrypts structured values", () => {
    const box = new SecretBox(Buffer.alloc(32, 3).toString("base64"));
    const value = {
      username: "mailbox@example.com",
      password: "test-password"
    };
    const encrypted = box.encrypt(value);

    assert.equal(encrypted.includes(value.password), false);
    assert.deepEqual(box.decrypt(encrypted), value);
  });

  it("rejects decryption with a different key", () => {
    const first = new SecretBox(Buffer.alloc(32, 4).toString("base64"));
    const second = new SecretBox(Buffer.alloc(32, 5).toString("base64"));

    assert.throws(() => second.decrypt(first.encrypt({ secret: "value" })));
  });
});
