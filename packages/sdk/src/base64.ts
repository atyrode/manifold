/** Binary-safe base64 for terminal payloads; works in browsers and Bun alike. */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function textToBase64(text: string): string {
  return bytesToBase64(textEncoder.encode(text));
}

export function base64ToText(b64: string): string {
  return textDecoder.decode(base64ToBytes(b64));
}
