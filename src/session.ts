import type { MeroJs } from '@calimero-network/mero-js';
import type { Config } from './config.ts';
import { createSession, type NodeSession } from './node.ts';

type Methods = Record<string, (...args: unknown[]) => unknown>;

/** Every call on this namespace waits for the real session, then forwards to its same-named namespace. */
function lazyNamespace(ensure: () => Promise<NodeSession>, namespace: 'admin' | 'rpc') {
  return new Proxy({} as Methods, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      return (...args: unknown[]) => ensure().then((session) => (session.mero[namespace] as unknown as Methods)[prop](...args));
    },
  });
}

/**
 * A NodeSession stand-in that only calls `create` on first tool use, and only memoizes it on
 * success: a down node or bad credentials fails that one call instead of the server refusing to
 * start, and the next call tries again. `url`/`nodeName`/`authMode` are placeholders until then.
 */
export function createLazySession(cfg: Config, create: (cfg: Config) => Promise<NodeSession> = createSession): NodeSession {
  let pending: Promise<NodeSession> | undefined;

  const ensure = (): Promise<NodeSession> => {
    if (!pending) {
      pending = create(cfg)
        .then((real) => {
          session.url = real.url;
          session.nodeName = real.nodeName;
          session.authMode = real.authMode;
          return real;
        })
        .catch((err: unknown) => {
          pending = undefined;
          throw err;
        });
    }
    return pending;
  };

  const session: NodeSession = {
    url: '',
    nodeName: '',
    authMode: 'none',
    // MeroJs is a class with private fields, so only a stand-in cast satisfies the type; .admin/.rpc are all any caller ever reads.
    mero: { admin: lazyNamespace(ensure, 'admin'), rpc: lazyNamespace(ensure, 'rpc') } as unknown as MeroJs,
  };
  return session;
}
