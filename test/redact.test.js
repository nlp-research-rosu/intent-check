import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, neverUpload } from "../lib/redact.js";

// Build fake secrets at runtime so this file never contains a real-looking token literal.
const rep = (c, n) => c.repeat(n);
const SECRETS = {
  "private-key": ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA" + rep("x", 40), rep("y", 60), "-----END RSA PRIVATE KEY-----"].join("\n"),
  "intent-key": "ic_" + rep("Q", 32) + "Zx9Yw8",
  "aws-key": "AKIA" + "QWERTYUIOPASDFGH",
  "github-token": "ghp_" + "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5",
  "anthropic-key": "sk-ant-api03-" + rep("Ab1_", 22),
  "openai-key": "sk-proj-" + rep("Zq8", 14),
  "stripe-key": "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  "slack-token": "xoxb-" + "123456789012-abcdefABCDEF",
  "google-key": "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q",
  "jwt": "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "npm-token": "npm_" + "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5",
  "twilio-key": "SK" + "0123456789abcdef0123456789abcdef",
};

for (const [rule, secret] of Object.entries(SECRETS)) {
  test(`redacts ${rule} within the line`, () => {
    const input = `before\nvalue = ${secret} # tail\nafter\n`;
    const { text, count } = redact(input);
    assert.ok(count >= 1, `no redaction for ${rule}`);
    assert.ok(!text.includes(secret.split("\n")[1] || secret), `${rule} survived`);
    assert.equal(text.split("\n").length, input.split("\n").length, "line count changed");
    assert.match(text, /‹redacted:/);
  });
}

test("redacts the password in a URL but keeps the host", () => {
  const { text } = redact('DB = "postgres://admin:s3cr3tP4ss@db.internal:5432/app"');
  assert.ok(!text.includes("s3cr3tP4ss"));
  assert.match(text, /db\.internal/);
});

test("redacts keyword assignments and .env lines with random-looking values", () => {
  const input = 'api_key = "Xk29fLq8Zr4Tw7Vb"\nexport DATABASE_PASSWORD=Hq8w2Lz9Xk4Tb7Vm\nSTRIPE_TOKEN=Ab9dKq2Lx8Wz\n';
  const { text, count } = redact(input);
  assert.equal(count, 3);
  for (const s of ["Xk29fLq8Zr4Tw7Vb", "Hq8w2Lz9Xk4Tb7Vm", "Ab9dKq2Lx8Wz"]) assert.ok(!text.includes(s), s);
});

test("leaves ordinary code alone", () => {
  const code = [
    "def apply_discount(price_cents: int, percent: int) -> int:",
    "    token = get_token(user)",
    "    password = request.form.password",
    "    auth_header = self.auth_header",
    "    secret_name = SECRET_NAME",
    '    tokens = tokenize("hello world")',
    "    return price_cents - price_cents * percent // 100",
    "DEBUG=true",
    "LOG_LEVEL=info",
  ].join("\n");
  const { text, count } = redact(code);
  assert.equal(count, 0, text);
  assert.equal(text, code);
});

test("PEM inside a diff keeps diff markers and line count", () => {
  const diff = ["@@ -0,0 +1,4 @@", "+-----BEGIN PRIVATE KEY-----", "+MIIBVQIBADANBgkqhkiG9w0BAQEFAASC", "+AT8wggE7AgEAAkEA", "+-----END PRIVATE KEY-----", ""].join("\n");
  const { text } = redact(diff);
  assert.equal(text.split("\n").length, diff.split("\n").length);
  assert.ok(!text.includes("MIIBVQ"));
  assert.ok(text.split("\n").slice(2, 5).every((l) => l.startsWith("+")));
});

test("never uploads key files and env files", () => {
  for (const p of [".env", ".env.local", "config/.env.production", "certs/server.pem", "id_rsa", "keys/id_ed25519.pub", "aws/credentials", "infra/terraform.tfstate"]) {
    assert.equal(neverUpload(p), true, p);
  }
  for (const p of ["src/env.py", "pricing.py", "src/auth/login.py"]) assert.equal(neverUpload(p), false, p);
});
