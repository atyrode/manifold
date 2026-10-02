import type { CipherSuite } from "@hpke/core";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import {
  CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES,
  CREDENTIAL_ENROLLMENT_SUITE,
  CREDENTIAL_ENROLLMENT_VERSION,
  ServiceCredentialEnrollmentChallengeSchema,
  ServiceCredentialEnrollmentEnvelopeSchema,
  type ServiceCredentialEnrollmentChallenge,
  type ServiceCredentialEnrollmentEnvelope,
  type ServiceCredentialEnrollmentPublicKey,
  type ServiceCredentialEnrollmentRefusal,
} from "./credential-enrollment.ts";
import { canonicalJobJson } from "./canonical-json.ts";

/** Only closed reason words cross a crypto boundary; never retain a library error as cause. */
export class ServiceCredentialEnrollmentError extends Error {
  constructor(readonly reason: ServiceCredentialEnrollmentRefusal) {
    super(reason);
    this.name = "ServiceCredentialEnrollmentError";
  }
}

interface EnrollmentCrypto {
  suite: CipherSuite;
  encoder: TextEncoder;
  info: Uint8Array<ArrayBuffer>;
}
let cryptoState: Promise<EnrollmentCrypto> | undefined;

function enrollmentCrypto(): Promise<EnrollmentCrypto> {
  if (!globalThis.crypto?.subtle) {
    throw new ServiceCredentialEnrollmentError("credential_key_unavailable");
  }
  return (cryptoState ??= import("@hpke/core").then(
    ({ Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 }) => {
      const encoder = new TextEncoder();
      return {
        suite: new CipherSuite({
          kem: new DhkemP256HkdfSha256(),
          kdf: new HkdfSha256(),
          aead: new Aes256Gcm(),
        }),
        encoder,
        info: encoder.encode("manifold.service_credential_enrollment/v1"),
      };
    },
  ));
}

async function publicKeyId(publicKey: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
  let result = "";
  for (const byte of digest) result += byte.toString(16).padStart(2, "0");
  return result;
}

function cryptoRefusal(error: unknown, fallback: ServiceCredentialEnrollmentRefusal): never {
  if (error instanceof ServiceCredentialEnrollmentError) throw error;
  throw new ServiceCredentialEnrollmentError(fallback);
}

/** Native-only custody. Returned plaintext is caller-owned and must be wiped after use. */
export interface ServiceCredentialEnrollmentKey {
  readonly metadata: Readonly<ServiceCredentialEnrollmentPublicKey>;
  open(envelope: ServiceCredentialEnrollmentEnvelope): Promise<Uint8Array<ArrayBuffer>>;
  close(): void;
}

/** One memory-only nonextractable recipient per native owner incarnation. */
export async function createServiceCredentialEnrollmentKey(): Promise<ServiceCredentialEnrollmentKey> {
  try {
    const state = await enrollmentCrypto();
    let pair: CryptoKeyPair | null = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    if (pair.privateKey.extractable) {
      throw new ServiceCredentialEnrollmentError("credential_key_unavailable");
    }
    const rawPublicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (rawPublicKey.byteLength !== 65) {
      throw new ServiceCredentialEnrollmentError("credential_key_unavailable");
    }
    const metadata = Object.freeze({
      version: CREDENTIAL_ENROLLMENT_VERSION,
      suite: CREDENTIAL_ENROLLMENT_SUITE,
      keyId: await publicKeyId(rawPublicKey),
      publicKey: bytesToBase64(new Uint8Array(rawPublicKey)),
    });
    return {
      metadata,
      close() {
        pair = null;
      },
      async open(input) {
        const recipient = pair;
        if (recipient === null) {
          throw new ServiceCredentialEnrollmentError("credential_key_changed");
        }
        const parsed = ServiceCredentialEnrollmentEnvelopeSchema.safeParse(input);
        if (!parsed.success) {
          throw new ServiceCredentialEnrollmentError("credential_envelope_invalid");
        }
        const envelope = parsed.data;
        if (envelope.context.version !== CREDENTIAL_ENROLLMENT_VERSION) {
          throw new ServiceCredentialEnrollmentError("credential_key_version_unsupported");
        }
        if (envelope.context.keyId !== metadata.keyId) {
          throw new ServiceCredentialEnrollmentError("credential_key_changed");
        }
        try {
          const enc = base64ToBytes(envelope.enc);
          const ciphertext = base64ToBytes(envelope.ciphertext);
          const plaintext = new Uint8Array(
            await state.suite.open(
              { recipientKey: recipient, enc: enc.buffer, info: state.info },
              ciphertext,
              state.encoder.encode(canonicalJobJson(envelope.context)),
            ),
          );
          if (pair !== recipient) {
            plaintext.fill(0);
            throw new ServiceCredentialEnrollmentError("credential_key_changed");
          }
          if (
            plaintext.byteLength === 0 ||
            plaintext.byteLength > CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES
          ) {
            plaintext.fill(0);
            throw new ServiceCredentialEnrollmentError("credential_value_invalid");
          }
          return plaintext;
        } catch (error: unknown) {
          return cryptoRefusal(error, "credential_envelope_invalid");
        }
      },
    };
  } catch (error: unknown) {
    return cryptoRefusal(error, "credential_key_unavailable");
  }
}

/** Browser/SDK sender. The caller must clear its input and wipe plaintext in its own finally. */
export async function sealServiceCredentialEnrollment(
  input: ServiceCredentialEnrollmentChallenge,
  plaintext: Uint8Array,
): Promise<ServiceCredentialEnrollmentEnvelope> {
  if (
    plaintext.byteLength === 0 ||
    plaintext.byteLength > CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES
  ) {
    throw new ServiceCredentialEnrollmentError("credential_value_invalid");
  }
  const parsed = ServiceCredentialEnrollmentChallengeSchema.safeParse(input);
  if (!parsed.success) {
    throw new ServiceCredentialEnrollmentError("credential_envelope_invalid");
  }
  const { context, key } = parsed.data;
  if (
    context.version !== CREDENTIAL_ENROLLMENT_VERSION ||
    key.version !== CREDENTIAL_ENROLLMENT_VERSION
  ) {
    throw new ServiceCredentialEnrollmentError("credential_key_version_unsupported");
  }
  if (context.keyId !== key.keyId) {
    throw new ServiceCredentialEnrollmentError("credential_key_changed");
  }
  try {
    const state = await enrollmentCrypto();
    const rawPublicKey = base64ToBytes(key.publicKey);
    if ((await publicKeyId(rawPublicKey.buffer)) !== key.keyId) {
      throw new ServiceCredentialEnrollmentError("credential_key_changed");
    }
    const recipientPublicKey = await state.suite.kem.deserializePublicKey(rawPublicKey.buffer);
    const result = await state.suite.seal(
      { recipientPublicKey, info: state.info },
      plaintext,
      state.encoder.encode(canonicalJobJson(context)),
    );
    return {
      context,
      enc: bytesToBase64(new Uint8Array(result.enc)),
      ciphertext: bytesToBase64(new Uint8Array(result.ct)),
    };
  } catch (error: unknown) {
    return cryptoRefusal(error, "credential_envelope_invalid");
  }
}
