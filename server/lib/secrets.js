import crypto from "node:crypto";
const key = () =>
  crypto.createHash("sha256").update(process.env.JWT_SECRET).digest();
export function protectSecret(value) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
export function revealSecret(value) {
  const raw = Buffer.from(value, "base64"),
    decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key(),
      raw.subarray(0, 12),
    );
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
