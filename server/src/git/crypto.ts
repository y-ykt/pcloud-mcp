// © 2026 Yasuhiko Yokote

/**
 * Decryption (AES-256-GCM) of the files under the folder named by `gitRoot`.
 *
 * Encryption is done by the tool that writes the repositories (written in Go). The stored format is
 *
 *   nonce (12 bytes) + ciphertext + authentication tag (16 bytes)
 *
 * which is exactly 28 bytes longer than the plaintext.
 * Because the authentication tag is at the end, **a partial fetch is not possible** (the whole file is needed).
 *
 * This module provides decryption only. Encryption is not implemented
 * (this server is read-only and has no means of writing).
 */
import { createDecipheriv } from "node:crypto";

export const NONCE_SIZE = 12;
export const TAG_SIZE = 16;
export const KEY_SIZE = 32;
/** Length added by encryption. Used to estimate the plaintext size from the encrypted size. */
export const ENCRYPT_OVERHEAD = NONCE_SIZE + TAG_SIZE;

export class GitDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDecryptError";
  }
}

/** Decrypts. Throws `GitDecryptError` if the authentication tag does not verify. */
export function decrypt(key: Buffer, data: Buffer): Buffer {
  if (key.length !== KEY_SIZE) {
    throw new GitDecryptError(`Unexpected key length (${key.length} bytes; it must be 32 bytes)`);
  }
  if (data.length < ENCRYPT_OVERHEAD + 1) {
    throw new GitDecryptError(`The encrypted file is too short (${data.length} bytes)`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, NONCE_SIZE));
  decipher.setAuthTag(data.subarray(data.length - TAG_SIZE));
  try {
    return Buffer.concat([
      decipher.update(data.subarray(NONCE_SIZE, data.length - TAG_SIZE)),
      decipher.final(),
    ]);
  } catch {
    throw new GitDecryptError("Decryption failed. The key is wrong or the file is corrupted");
  }
}

// ---------------------------------------------------------------- fetching the key

/** Describes only the part of the Secrets Manager SDK that is used (same shape as in handler.ts). */
interface SecretsManagerModule {
  SecretsManagerClient: new (config: { region: string }) => {
    send(command: unknown): Promise<{ SecretString?: string }>;
  };
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
}

/** The means of obtaining the decryption key. Tests replace it with a fixed key. */
export interface KeyProvider {
  get(): Promise<Buffer>;
}

/** Turns 64 hexadecimal characters into a 32-byte key. Throws `GitDecryptError` if the format is wrong. */
export function parseKeyHex(hex: string): Buffer {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new GitDecryptError("Unexpected key format (it must be 64 hexadecimal characters)");
  }
  return Buffer.from(trimmed, "hex");
}

/**
 * Reads from Secrets Manager.
 *
 * Handled the same way as the token (`secretsManagerTokenProvider` in handler.ts):
 * **kept in memory only for the lifetime of the execution environment**, with no re-fetch on expiry.
 * When the key is replaced, `set-git-encrypt-key` recreates the execution environment as well.
 */
export function secretsManagerKeyProvider(secretArn: string, region: string): KeyProvider {
  let cached: Buffer | undefined;
  return {
    async get(): Promise<Buffer> {
      if (cached !== undefined) return cached;
      const specifier = "@aws-sdk/client-secrets-manager";
      const sdk = (await import(specifier).catch(() => {
        throw new Error(`Could not load ${specifier}`);
      })) as SecretsManagerModule;
      const client = new sdk.SecretsManagerClient({ region });
      const res = await client.send(new sdk.GetSecretValueCommand({ SecretId: secretArn }));
      const raw = res.SecretString;
      if (raw === undefined || raw === "") {
        throw new Error("The secret holds no value. Register it with set-git-encrypt-key");
      }
      // Accepts either {"encrypt_key":"..."} or the bare hexadecimal string
      let hex = raw.trim();
      if (hex.startsWith("{")) {
        const parsed = JSON.parse(hex) as Record<string, unknown>;
        const v = parsed["encrypt_key"];
        if (typeof v !== "string" || v === "") {
          throw new Error("The secret has no encrypt_key");
        }
        hex = v;
      }
      cached = parseKeyHex(hex);
      return cached;
    },
  };
}
