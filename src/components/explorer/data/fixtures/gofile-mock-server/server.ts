import { setupServer } from 'msw/node';
import { gofileHandlers } from './handlers';

/** Call listen({ onUnhandledRequest: 'error' }) in tests, close in afterAll.
 * No passthrough: an unconfigured URL must fail rather than reach gofile.
 */
export function createGofileMockServer() {
  return setupServer(...gofileHandlers());
}
