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

// Table ownership split (Phase 2.1):
//   app.review_queue  → Lakebase-Sync-owned (read-only), mirrors gold_nlp_disagreements.
//                       Columns: path, transcription_text, sentiment_ai_*, summary_ai_*,
//                       topic_ai_*, entities_ai_* (JSON-encoded strings),
//                       entity_jaccard_similarity, summary_cosine_similarity,
//                       disagreement_flags (JSON-encoded string),
//                       _ingested_date, _ingested_at.
//   app.review_state  → app-owned; workflow state per path. Optional row;
//                       absence implies status='pending'.
//   app.nlp_verdicts  → app-owned; append-only verdict log.
//
// FKs reference review_queue (the source of truth for valid paths) when possible.
// Both FKs are added via DO blocks so startup tolerates missing dependencies
// (sync not yet run, or app SP lacking REFERENCES privilege).

const CREATE_REVIEW_STATE_SQL = `
  CREATE TABLE IF NOT EXISTS app.review_state (
    path        TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','claimed','reviewed','skipped')),
    claimed_by  TEXT,
    claimed_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

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

// Idempotent FK additions. DO block swallows duplicate_object (already exists),
// undefined_table (review_queue not yet synced), and insufficient_privilege
// (app SP lacks REFERENCES on sync-owned table).
const ADD_NLP_VERDICTS_FK_SQL = `
  DO $$ BEGIN
    ALTER TABLE app.nlp_verdicts
      ADD CONSTRAINT nlp_verdicts_path_fk
      FOREIGN KEY (path) REFERENCES app.review_queue(path);
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
    await appkit.lakebase.query(CREATE_REVIEW_STATE_SQL);
    await appkit.lakebase.query(CREATE_NLP_VERDICTS_SQL);
    await appkit.lakebase.query(CREATE_NLP_VERDICTS_PATH_INDEX_SQL);
    await appkit.lakebase.query(CREATE_NLP_VERDICTS_REVIEWED_AT_INDEX_SQL);
    // FK to review_queue is conditional — review_queue is sync-owned and may
    // not exist yet on a cold deploy. The DO block swallows undefined_table.
    await appkit.lakebase.query(ADD_NLP_VERDICTS_FK_SQL);
    console.log('[lakebase] verdict workbench schema ensured (review_state, nlp_verdicts owned by app; review_queue is sync-owned)');
  } catch (err) {
    console.warn('[lakebase] schema provisioning failed:', (err as Error).message);
    console.warn('[lakebase] routes will be registered but may return errors');
  }

  appkit.server.extend((app) => {
    // ── List pending queue items ────────────────────────────────────────────
    // LEFT JOIN review_state because most paths have no state row yet (absence
    // ⇒ pending). disagreement_flags arrives as a JSON-encoded string from the
    // sync (sync flattens array<string> to a string); cast to jsonb for the
    // membership filter and for parsing on the wire.
    app.get('/api/review-queue', async (req, res) => {
      try {
        const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 200);
        const dimension = req.query.dimension as string | undefined;

        const params: unknown[] = [limit];
        let dimClause = '';
        if (dimension && DIMENSIONS.includes(dimension as (typeof DIMENSIONS)[number])) {
          params.push(dimension);
          dimClause = `AND q.disagreement_flags::jsonb ? $${params.length}`;
        }

        const { rows } = await appkit.lakebase.query(
          `SELECT q.path,
                  q._ingested_at,
                  q.disagreement_flags::jsonb AS disagreement_flags,
                  COALESCE(s.status, 'pending') AS status,
                  s.claimed_by
             FROM app.review_queue q
             LEFT JOIN app.review_state s USING (path)
            WHERE COALESCE(s.status, 'pending') = 'pending' ${dimClause}
            ORDER BY q._ingested_at DESC NULLS LAST
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
    // Explicit column list avoids SELECT * which (a) is best-practice over a
    // sync-owned schema we don't control, and (b) sidestepped a PostgreSQL
    // permission-denied error on the sync-owned table.
    app.get('/api/review-queue/item', async (req, res) => {
      try {
        const path = (req.query.path as string) ?? '';
        if (!path) {
          res.status(400).json({ error: 'path query param required' });
          return;
        }
        const { rows } = await appkit.lakebase.query(
          `SELECT q.path,
                  q.transcription_text,
                  q.sentiment_ai_query,  q.sentiment_ai_func,
                  q.summary_ai_query,    q.summary_ai_func,
                  q.topic_ai_query,      q.topic_ai_func,
                  q.entities_ai_query::jsonb AS entities_ai_query,
                  q.entities_ai_func::jsonb  AS entities_ai_func,
                  q.entity_jaccard_similarity,
                  q.summary_cosine_similarity,
                  q.disagreement_flags::jsonb AS disagreement_flags,
                  q._ingested_date,      q._ingested_at,
                  COALESCE(s.status, 'pending') AS status,
                  s.claimed_by,
                  s.claimed_at
             FROM app.review_queue q
             LEFT JOIN app.review_state s USING (path)
            WHERE q.path = $1`,
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
    // INSERT ... ON CONFLICT DO UPDATE ... WHERE — single statement, atomic.
    //   - No existing row: INSERT new 'claimed' state.
    //   - Existing row is 'pending': UPDATE to 'claimed'.
    //   - Existing row is anything else: WHERE clause blocks UPDATE,
    //     RETURNING returns 0 rows → 409.
    app.post('/api/review-queue/claim', async (req, res) => {
      try {
        const parsed = PathBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'path required' });
          return;
        }
        const { rows } = await appkit.lakebase.query(
          `INSERT INTO app.review_state (path, status, claimed_by, claimed_at, updated_at)
             VALUES ($1, 'claimed', $2, now(), now())
           ON CONFLICT (path) DO UPDATE
             SET status = 'claimed',
                 claimed_by = $2,
                 claimed_at = now(),
                 updated_at = now()
             WHERE app.review_state.status = 'pending'
        RETURNING path, status, claimed_by, claimed_at`,
          [parsed.data.path, reviewerEmail(req)],
        );
        if (rows.length === 0) {
          res.status(409).json({ error: 'Already claimed or reviewed' });
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
          `UPDATE app.review_state
              SET status = 'pending',
                  claimed_by = NULL,
                  claimed_at = NULL,
                  updated_at = now()
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
    // CTE keeps the INSERTs and the review_state UPSERT in one statement so
    // they share an implicit transaction without relying on pool-checkout
    // semantics. The verdict_exists CTE validates that path exists in the
    // sync-owned review_queue *before* writing anything (FK enforcement is
    // best-effort because the SP may not have REFERENCES on the sync table).
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
          `WITH path_exists AS (
             SELECT path FROM app.review_queue WHERE path = $1
           ),
           inserted AS (
             INSERT INTO app.nlp_verdicts
               (path, dimension, winner, truth_value, notes, reviewer_email)
             SELECT $1, v.dimension, v.winner, v.truth_value, v.notes, $2
               FROM jsonb_to_recordset($3::jsonb)
                 AS v(dimension TEXT, winner TEXT, truth_value TEXT, notes TEXT)
              WHERE EXISTS (SELECT 1 FROM path_exists)
             RETURNING 1
           ),
           state_upsert AS (
             INSERT INTO app.review_state (path, status, claimed_by, claimed_at, updated_at)
             SELECT $1, 'reviewed', $2, now(), now()
               FROM path_exists
             ON CONFLICT (path) DO UPDATE
               SET status = 'reviewed',
                   updated_at = now()
             RETURNING path
           )
           SELECT (SELECT count(*) FROM inserted)::INT AS verdicts_inserted,
                  (SELECT path FROM state_upsert)     AS reviewed_path`,
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
