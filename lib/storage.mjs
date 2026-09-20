import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class SubmissionConflictError extends Error {
  constructor() {
    super('This submission reference has already been used for different artwork. Please try again.');
    this.name = 'SubmissionConflictError';
    this.code = 'SUBMISSION_CONFLICT';
    this.status = 409;
  }
}

export function openStorage(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      client_submission_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      student_id TEXT NOT NULL DEFAULT '',
      grid_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS submissions_created_at ON submissions(created_at DESC);
  `);

  const getByReference = database.prepare(`
    SELECT id, created_at, fingerprint FROM submissions WHERE client_submission_id = ?
  `);
  const insert = database.prepare(`
    INSERT INTO submissions (id, client_submission_id, created_at, name, student_id, grid_json, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const count = database.prepare('SELECT COUNT(*) AS total FROM submissions');
  const list = database.prepare(`
    SELECT id, created_at, name, student_id, grid_json FROM submissions
    ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?
  `);
  let closed = false;

  return {
    create(submission) {
      const fingerprint = createHash('sha256').update(JSON.stringify({
        grid: submission.grid, name: submission.name, studentId: submission.studentId,
      })).digest('hex');
      // The write lock makes idempotency atomic even when another process uses this database.
      database.exec('BEGIN IMMEDIATE');
      try {
        const existing = getByReference.get(submission.clientSubmissionId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new SubmissionConflictError();
          database.exec('COMMIT');
          return { id: existing.id, createdAt: existing.created_at, isNew: false };
        }
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        insert.run(id, submission.clientSubmissionId, createdAt, submission.name,
          submission.studentId, JSON.stringify(submission.grid), fingerprint);
        database.exec('COMMIT');
        return { id, createdAt, isNew: true };
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    list({ limit, offset }) {
      const total = count.get().total;
      const submissions = list.all(limit, offset).map((row) => ({
        id: row.id,
        grid: JSON.parse(row.grid_json),
        name: row.name,
        studentId: row.student_id,
        createdAt: row.created_at,
      }));
      return { submissions, total, hasMore: offset + submissions.length < total };
    },
    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
}
