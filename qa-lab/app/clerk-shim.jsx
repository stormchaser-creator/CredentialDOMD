/* eslint-disable react-refresh/only-export-components -- this module stands in for
   @clerk/clerk-react, which exports its hooks and components together. */
// QA-lab stand-in for "@clerk/clerk-react". qa-lab/app/vite.config.mjs aliases
// the package to this file in QA-lab builds only, so the app's own code
// (src/main.jsx, App.jsx, AppContext.jsx, useSubscription.js, AuthPage.jsx,
// SignInMethodsCard.jsx) runs unchanged against a local test physician.
//
// Exports exactly what the app imports from Clerk: ClerkProvider, useUser,
// useAuth, useClerk, SignedIn, SignedOut, SignIn.
import { useEffect, useSyncExternalStore } from 'react';
import { qaClerk } from './qa-clerk.js';
import QaSignIn from './QaSignIn.jsx';

const subscribe = (fn) => qaClerk.subscribe(fn);
const snapshot = () => qaClerk.getVersion();
function useClerkState() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return qaClerk;
}

export function ClerkProvider({ children, afterSignOutUrl }) {
  useEffect(() => { qaClerk.setAfterSignOutUrl(afterSignOutUrl || '/app/'); }, [afterSignOutUrl]);
  useEffect(() => { void qaClerk.load(); }, []);
  return children;
}

export function useClerk() {
  return useClerkState();
}

export function useUser() {
  const c = useClerkState();
  if (!c.loaded) return { isLoaded: false, isSignedIn: undefined, user: undefined };
  return { isLoaded: true, isSignedIn: !!c.user, user: c.user };
}

export function useAuth() {
  const c = useClerkState();
  const loaded = c.loaded;
  return {
    isLoaded: loaded,
    isSignedIn: loaded ? !!c.session : undefined,
    userId: loaded ? (c.user?.id ?? null) : undefined,
    sessionId: loaded ? (c.session?.id ?? null) : undefined,
    orgId: null, orgRole: null, orgSlug: null, actor: null,
    getToken: async (options) => (c.session ? c.session.getToken(options) : null),
    signOut: c.signOut,
    has: () => false,
  };
}

export function SignedIn({ children }) {
  const c = useClerkState();
  return c.loaded && c.session ? children : null;
}

export function SignedOut({ children }) {
  const c = useClerkState();
  return c.loaded && !c.session ? children : null;
}

// AuthPage passes Clerk's appearance/routing props; the QA sign-in ignores them.
export function SignIn() {
  return <QaSignIn clerk={qaClerk} />;
}
