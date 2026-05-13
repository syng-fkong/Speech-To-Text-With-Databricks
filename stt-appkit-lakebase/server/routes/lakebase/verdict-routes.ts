import { z } from 'zod';
import { Application, Request } from 'express';

interface AppKitWithLakebase {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

// review_queue is OWNED by the Lakebase Sync resource (Phase 2) — the sync's
// pipeline creates and writes to it. The app must NOT pre-create it, otherwise
// the sync refuses to take ownership (DESTINATION_TABLE_EXISTS).
// nlp_verdicts is OWNED by the app.
// The FK from nlp_verdicts.path → review_queue.path is added in a separate
// ALTER step so app startup doesn't fail when sync hasn't run yet.
const CREATE_NLP_VERDICTS_SQL = `
  CREATE TABLE IF NOT EXISTS app.nlp_verdicts (
    verdict_id      BIGSERIAL PRIMARY KEY,
    path            TEXT NOT NULL,
    dimension       TEXT NOT NULL CHECK (dimension IN ('sentiment','topic','summary','entities')),
    winner          TEXT NOT NULL CHECK (winner IN ('ai_query','ai_func','neither','both_acceptable')),
    truth_value     TEXT,
    notes           TEXT,
    reviewer_email  TEXT NOT NULL,
    reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

// Idempotent FK addition. Wrapped in DO block so it succeeds when the constraint
// already exists OR when review_queue doesn't yet exist (sync hasn't run).
const ADD_NLP_VERDICTS_FK_SQL = `
  DO $$ BEGIN
    ALTER TABLE app.nlp_verdicts
      ADD CONSTRAINT nlp_verdicts_path_fk
      FOREIGN KEY (path) REFERENCES app.review_queue(path) ON DELETE CASCADE;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_table THEN NULL;
    WHEN insufficient_privilege THEN NULL;
  END $$
`;

const CREATE_NLP_VERDICTS_PATH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS nlp_verdicts_path_idx ON app.nlp_verdicts (path)
`;

const CREATE_NLP_VERDICTS_REVIEWED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS nlp_verdicts_reviewed_at_idx ON app.nlp_verdicts (reviewed_at)
`;

const DIMENSIONS = ['sentiment', 'topic', 'summary', 'entities'] as const;
const WINNERS = ['ai_query', 'ai_func', 'neither', 'both_acceptable'] as const;

const VerdictBody = z.object({
  path: z.string().min(1),
  verdicts: z
    .array(
      z.object({
        dimension: z.enum(DIMENSIONS),
        winner: z.enum(WINNERS),
        truth_value: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1),
});

const PathBody = z.object({ path: z.string().min(1) });

function reviewerEmail(req: Request): string {
  // Databricks Apps OBO sets X-Forwarded-Email. Fallback is for local dev only.
  const header = req.headers['x-forwarded-email'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return 'unknown@example.com';
}

const CREATE_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS app`;

export async function setupVerdictRoutes(appkit: AppKitWithLakebase) {
  try {
    await appkit.lakebase.query(CREATE_SCHEMA_SQL);
    await appkit.lakebase.query(CREATE_NLP_VERDICTS_SQL);
    await appkit.lakebase.query(CREATE_NLP_VERDICTS_PATH_INDEX_SQL);
    await appkit.lakebase.query(CREATE_NLP_VERDICTS_REVIEWED_AT_INDEX_SQL);
    // FK to review_queue is conditional — review_queue is sync-owned and may
    // not exist yet on a cold deploy. The DO block swallows undefined_table.
    await appkit.lakebase.query(ADD_NLP_VERDICTS_FK_SQL);
    console.log('[lakebase] verdict workbench schema ensured (nlp_verdicts; review_queue is sync-owned)');
  } catch (err) {
    console.warn('[lakebase] schema provisioning failed:', (err as Error).message);
    console.warn('[lakebase] routes will be registered but may return errors');
  }

  appkit.server.extend((app) => {
    // ── List pending queue items ────────────────────────────────────────────
    app.get('/api/review-queue', async (req, res) => {
      try {
        const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 200);
        const dimension = req.query.dimension as string | undefined;

        const params: unknown[] = [limit];
        let dimClause = '';
        if (dimension && DIMENSIONS.includes(dimension as (typeof DIMENSIONS)[number])) {
          params.push(dimension);
          dimClause = `AND $${params.length} = ANY(disagreement_flags)`;
        }

        const { rows } = await appkit.lakebase.query(
          `SELECT path, _ingested_at, disagreement_flags, status, claimed_by
             FROM app.review_queue
            WHERE status = 'pending' ${dimClause}
            ORDER BY _ingested_at DESC NULLS LAST
            LIMIT $1`,
          params,
        );
        res.json(rows);
      } catch (err) {
        console.error('Failed to list review queue:', err);
        res.status(500).json({ error: 'Failed to list review queue' });
      }
    });

    // ── Single item detail (path passed URL-encoded as query param) ─────────
    app.get('/api/review-queue/item', async (req, res) => {
      try {
        const path = (req.query.path as string) ?? '';
        if (!path) {
          res.status(400).json({ error: 'path query param required' });
          return;
        }
        const { rows } = await appkit.lakebase.query(
          `SELECT * FROM app.review_queue WHERE path = $1`,
          [path],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json(rows[0]);
      } catch (err) {
        console.error('Failed to load review queue item:', err);
        res.status(500).json({ error: 'Failed to load item' });
      }
    });

    // ── Atomically claim an item ────────────────────────────────────────────
    app.post('/api/review-queue/claim', async (req, res) => {
      try {
        const parsed = PathBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'path required' });
          return;
        }
        const { rows } = await appkit.lakebase.query(
          `UPDATE app.review_queue
              SET status = 'claimed', claimed_by = $2, claimed_at = now()
            WHERE path = $1 AND status = 'pending'
        RETURNING path, status, claimed_by, claimed_at`,
          [parsed.data.path, reviewerEmail(req)],
        );
        if (rows.length === 0) {
          res.status(409).json({ error: 'Already claimed or not found' });
          return;
        }
        res.json(rows[0]);
      } catch (err) {
        console.error('Failed to claim:', err);
        res.status(500).json({ error: 'Failed to claim' });
      }
    });

    // ── Release a claim without verdict ─────────────────────────────────────
    app.post('/api/review-queue/release', async (req, res) => {
      try {
        const parsed = PathBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'path required' });
          return;
        }
        const { rows } = await appkit.lakebase.query(
          `UPDATE app.review_queue
              SET status = 'pending', claimed_by = NULL, claimed_at = NULL
            WHERE path = $1 AND status = 'claimed' AND claimed_by = $2
        RETURNING path, status`,
          [parsed.data.path, reviewerEmail(req)],
        );
        if (rows.length === 0) {
          res.status(409).json({ error: 'Not your claim or not claimed' });
          return;
        }
        res.json(rows[0]);
      } catch (err) {
        console.error('Failed to release:', err);
        res.status(500).json({ error: 'Failed to release' });
      }
    });

    // ── Submit verdict (single statement, atomic by definition) ─────────────
    // Implemented as a CTE so the INSERTs and UPDATE share one transaction
    // boundary without relying on pool-checkout semantics that AppKit's
    // lakebase.query() may or may not provide. The nlp_verdicts.path FK
    // constraint guards against orphan inserts: if review_queue lacks the row,
    // the INSERT fails and the whole statement rolls back together.
    app.post('/api/verdicts', async (req, res) => {
      try {
        const parsed = VerdictBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid verdict body', details: parsed.error.format() });
          return;
        }
        const reviewer = reviewerEmail(req);
        const verdictsJson = JSON.stringify(parsed.data.verdicts);

        const { rows } = await appkit.lakebase.query(
          `WITH inserted AS (
             INSERT INTO app.nlp_verdicts
               (path, dimension, winner, truth_value, notes, reviewer_email)
             SELECT $1, v.dimension, v.winner, v.truth_value, v.notes, $2
               FROM jsonb_to_recordset($3::jsonb)
                 AS v(dimension TEXT, winner TEXT, truth_value TEXT, notes TEXT)
             RETURNING 1
           ),
           updated AS (
             UPDATE app.review_queue
                SET status = 'reviewed'
              WHERE path = $1
          RETURNING path
           )
           SELECT (SELECT count(*) FROM inserted)::INT AS verdicts_inserted,
                  (SELECT path FROM updated)         AS reviewed_path`,
          [parsed.data.path, reviewer, verdictsJson],
        );

        const r = rows[0] ?? {};
        if (!r.reviewed_path) {
          // review_queue had no matching row; FK would've blocked the inserts
          // already, but be explicit in the response.
          res.status(404).json({ error: 'review_queue row not found for path' });
          return;
        }
        res.status(201).json({
          path: parsed.data.path,
          verdicts_recorded: r.verdicts_inserted,
        });
      } catch (err) {
        console.error('Failed to record verdict:', err);
        res.status(500).json({ error: 'Failed to record verdict' });
      }
    });

    // ── My recent verdicts ──────────────────────────────────────────────────
    app.get('/api/verdicts/me', async (req, res) => {
      try {
        const reviewer = reviewerEmail(req);
        const { rows } = await appkit.lakebase.query(
          `SELECT verdict_id, path, dimension, winner, notes, reviewed_at
             FROM app.nlp_verdicts
            WHERE reviewer_email = $1
            ORDER BY reviewed_at DESC
            LIMIT 100`,
          [reviewer],
        );
        res.json(rows);
      } catch (err) {
        console.error('Failed to list my verdicts:', err);
        res.status(500).json({ error: 'Failed to load my verdicts' });
      }
    });
  });
}
