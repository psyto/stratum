/**
 * Decode a base64 string to a Uint8Array.
 * Throws if the input is not valid base64.
 */
export function decodeBase64(input: string): Uint8Array {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Invalid base64 input: must be a non-empty string');
  }
  const buf = Buffer.from(input, 'base64');
  if (buf.length === 0 && input.length > 0) {
    throw new Error('Invalid base64 input');
  }
  return new Uint8Array(buf);
}

/**
 * Decode a base64 string and verify the decoded length matches the expected length.
 * Throws if the input is invalid or if the length does not match.
 */
export function decodeBase64Exact(input: string, expectedLength: number): Uint8Array {
  const decoded = decodeBase64(input);
  if (decoded.length !== expectedLength) {
    throw new Error(
      `Invalid base64 input: expected ${expectedLength} bytes, got ${decoded.length}`
    );
  }
  return decoded;
}
