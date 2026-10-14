import { ClaudeCodeProvider } from './claude-code/index.js';
import type { Provider } from './Provider.js';
import { LockerError } from '../util/errors.js';

const factories: Record<string, () => Provider<any>> = {
  'claude-code': () => new ClaudeCodeProvider(),
};

export const DEFAULT_PROVIDER = 'claude-code';

export function getProvider(id = DEFAULT_PROVIDER): Provider<any> {
  const make = factories[id];
  if (!make) throw new LockerError(`Unknown provider "${id}".`, 'E_ARGS', `Known: ${Object.keys(factories).join(', ')}`);
  return make();
}
