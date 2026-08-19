/**
 * Integrity layer: the first gate an envelope passes through.
 *
 * This is deliberately narrow, not a general-purpose content firewall. It
 * catches the class of payload that would corrupt something downstream if
 * let through unchecked: prototype-pollution keys (a real, well-known attack
 * against anything that merges untrusted objects), payloads that can't
 * round-trip through JSON (functions, circular references — anything that
 * would silently break `JSON.stringify` in the provenance layer), and
 * oversized fields (a cheap denial-of-service guard). It does not attempt to
 * judge whether a payload is semantically correct — that's what consensus
 * and independent verification are for.
 */
import type { SwarmEnvelope } from './schema.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_STRING_LENGTH = 4096;

export interface IntegrityViolation {
  readonly reason: string;
}

function scanForForbiddenKeys(value: unknown, path: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `forbidden key "${key}" at ${path || '<root>'}`;
    }
    const found = scanForForbiddenKeys((value as Record<string, unknown>)[key], `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

function scanForOversizedStrings(value: unknown, path: string): string | undefined {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `oversized string at ${path || '<root>'} (${value.length} chars)` : undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const found = scanForOversizedStrings((value as Record<string, unknown>)[key], `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

/** Returns `null` if the envelope's payload is clean, or a violation describing why it isn't. */
export function checkIntegrity(envelope: SwarmEnvelope): IntegrityViolation | null {
  // Checked first, deliberately: a circular payload would otherwise send the
  // recursive scans below into infinite recursion before ever reaching this
  // check. Once JSON.stringify succeeds, the payload is provably cycle-free,
  // which is what actually makes the recursive scans below safe to run.
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope.payload);
  } catch {
    return { reason: 'payload is not JSON-serializable' };
  }
  if (serialized === undefined) {
    return { reason: 'payload is not JSON-serializable' };
  }

  const forbidden = scanForForbiddenKeys(envelope.payload, '');
  if (forbidden) return { reason: forbidden };

  const oversized = scanForOversizedStrings(envelope.payload, '');
  if (oversized) return { reason: oversized };

  return null;
}
