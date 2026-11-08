/** A cached identity session. The sessionToken is a bearer credential and must be protected. */
export interface StoredIdentitySession {
  sessionToken: string;
  visitorId: string;
  deadline: number;
  margin: number;
  origin?: string;
}

/**
 * Storage shared by handler instances. Subject keys are HMAC digests scoped to the integration.
 * Implementations must protect session tokens and expire entries by deadline. Revisions must be
 * unique and never reused after expiry or eviction. Every method must be atomic across instances:
 * read creates a revision even for an absent subject; commit compares and advances it; takeSubject
 * advances it even when empty; deleteToken compares tokens within the supplied namespace and advances
 * each affected revision. This fences an in-flight exchange against logout and concurrent exchanges.
 */
export interface IdentitySessionStore {
  read(subjectKey: string, agent: string): Promise<{ revision: string; session: StoredIdentitySession | null }>;
  /** Atomically verify that no subject mutation has occurred since read. */
  check(subjectKey: string, revision: string): Promise<boolean>;
  /** Atomically compare and advance the subject revision when committing a session. */
  commit(subjectKey: string, agent: string, revision: string, session: StoredIdentitySession): Promise<boolean>;
  /** Remove only entries whose current token equals this token, not a newer replacement. */
  deleteToken(namespace: string, token: string): Promise<void>;
  /** Atomically advance the revision and remove and return all entries, even when none exist. */
  takeSubject(subjectKey: string): Promise<Array<{ agent: string; session: StoredIdentitySession }>>;
}

/** Bounded per-handler default; a shared adapter can be provided for multi-instance hosts. */
export function memoryIdentitySessionStore(limit = 1000): IdentitySessionStore {
  const subjects = new Map<string, { revision: string; sessions: Map<string, StoredIdentitySession> }>();
  const revision = () => crypto.randomUUID();
  const get = (subjectKey: string) => {
    let entry = subjects.get(subjectKey);
    if (!entry) entry = { revision: revision(), sessions: new Map() };
    subjects.delete(subjectKey);
    subjects.set(subjectKey, entry);
    while (subjects.size > limit) subjects.delete(subjects.keys().next().value!);
    return entry;
  };
  return {
    async read(subjectKey, agent) {
      const entry = get(subjectKey);
      return { revision: entry.revision, session: entry.sessions.get(agent) ?? null };
    },
    async check(subjectKey, expected) { return subjects.get(subjectKey)?.revision === expected; },
    async commit(subjectKey, agent, expected, session) {
      const entry = subjects.get(subjectKey);
      if (!entry || entry.revision !== expected) return false;
      entry.sessions.set(agent, session);
      entry.revision = revision();
      return true;
    },
    async deleteToken(namespace, token) {
      for (const [subjectKey, entry] of subjects) if (subjectKey.startsWith(namespace + ":")) {
        for (const [agent, session] of entry.sessions) if (session.sessionToken === token) {
          entry.sessions.delete(agent);
          entry.revision = revision();
        }
      }
    },
    async takeSubject(subjectKey) {
      const entry = get(subjectKey);
      const held = [...entry.sessions].map(([agent, session]) => ({ agent, session }));
      entry.sessions.clear();
      entry.revision = revision();
      return held;
    },
  };
}
