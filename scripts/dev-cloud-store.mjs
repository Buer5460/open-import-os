/** In-memory stand-in for D1, mirroring the SQL schema in migrations/0001_init.sql. */
export class InMemoryStore {
  constructor() { this.users = new Map(); this.sessions = new Map(); this.leads = []; }
  getUserByEmail(email) { return [...this.users.values()].find((u) => u.email === email) ?? null; }
  getUserById(id) { return this.users.get(id) ?? null; }
  createUser(u) { this.users.set(u.id, u); return u; }
  createSession(s) { this.sessions.set(s.id, s); return s; }
  deleteSession(id) { this.sessions.delete(id); }
  getUserBySession(sid) {
    const s = this.sessions.get(sid);
    if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
    return this.getUserById(s.user_id);
  }
  createLead(l) { this.leads.push(l); return l; }
  listLeads() { return this.leads; }
}
