import { ClaudeCodeProvider } from './claude-code/index.js';
import { QoderProvider } from './qoder/index.js';
import { CopilotProvider } from './copilot/index.js';
import { AgyProvider } from './antigravity/index.js';
import { KiroProvider } from './kiro/index.js';
import type { Provider } from './Provider.js';
import { LockerError } from '../util/errors.js';

/** Provider id -> factory. A Map keeps ids such as `__proto__` from resolving. */
const factories = new Map<string, () => Provider<any>>([
  ['claude-code', () => new ClaudeCodeProvider()],
  ['qoder', () => new QoderProvider()],
  ['copilot', () => new CopilotProvider()],
  ['agy', () => new AgyProvider()],
  ['kiro', () => new KiroProvider()],
]);

/** Accepted spellings that are not the canonical id stored in the vault. */
const aliases = new Map<string, string>([
  ['antigravity', 'agy'],
  ['kiro-cli', 'kiro'],
]);

export const DEFAULT_PROVIDER = 'claude-code';

/** Canonical provider ids, in registration order. */
export function providerIds(): string[] {
  return [...factories.keys()];
}

export function canonicalProviderId(id: string): string {
  const key = id.trim().toLowerCase();
  return aliases.get(key) ?? key;
}

export function getProvider(id = DEFAULT_PROVIDER): Provider<any> {
  const canonical = canonicalProviderId(id);
  const make = factories.get(canonical);
  if (!make) {
    const known = [...factories.keys(), ...aliases.keys()].join(', ');
    throw new LockerError(`Unknown provider "${id}".`, 'E_ARGS', `Known: ${known}`);
  }
  return make();
}
