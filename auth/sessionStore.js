import session from "express-session";
import createFileStore from "session-file-store";

const FileStore = createFileStore(session);

export class PersistentSessionStore extends FileStore {
  constructor(options) {
    super(options);
    this.pending = new Map();
    this.revoked = new Map();
    this.revocationLifetimeMs = options.ttl * 1000;
    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, expires] of this.revoked) {
        if (expires <= now) this.revoked.delete(sessionId);
      }
    }, 60 * 60 * 1000);
    cleanup.unref();
  }

  run(sessionId, operation, callback) {
    const previous = this.pending.get(sessionId) || Promise.resolve();
    const task = previous.then(() => new Promise((resolve, reject) => {
      operation((error, value) => error ? reject(error) : resolve(value));
    }));
    const completed = task.then((value) => callback?.(null, value), (error) => callback?.(error));
    this.pending.set(sessionId, completed);
    completed.finally(() => {
      if (this.pending.get(sessionId) === completed) this.pending.delete(sessionId);
    }).catch(() => {});
  }

  get(sessionId, callback) {
    this.run(sessionId, (done) => this.revoked.has(sessionId) ? done(null, null) : super.get(sessionId, done), callback);
  }

  set(sessionId, value, callback) {
    this.run(sessionId, (done) => this.revoked.has(sessionId) ? done(null) : super.set(sessionId, value, done), callback);
  }

  touch(sessionId, value, callback) {
    this.run(sessionId, (done) => this.revoked.has(sessionId) ? done(null) : super.touch(sessionId, value, done), callback);
  }

  destroy(sessionId, callback) {
    this.revoked.set(sessionId, Date.now() + this.revocationLifetimeMs);
    this.run(sessionId, (done) => super.destroy(sessionId, done), callback);
  }
}