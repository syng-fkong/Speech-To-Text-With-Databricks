import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
  Textarea,
  Badge,
} from '@databricks/appkit-ui/react';

const DIMENSIONS = ['sentiment', 'topic', 'summary', 'entities'] as const;
type Dimension = (typeof DIMENSIONS)[number];

const WINNERS = ['ai_query', 'ai_func', 'neither', 'both_acceptable'] as const;
type Winner = (typeof WINNERS)[number];

const WINNER_LABELS: Record<Winner, string> = {
  ai_query: 'AI Query (FM API)',
  ai_func: 'AI Func (SQL functions)',
  neither: 'Neither — I’ll provide truth',
  both_acceptable: 'Both acceptable',
};

interface ReviewQueueItem {
  path: string;
  transcription_text: string;
  sentiment_ai_query: string | null;
  sentiment_ai_func: string | null;
  summary_ai_query: string | null;
  summary_ai_func: string | null;
  topic_ai_query: string | null;
  topic_ai_func: string | null;
  entities_ai_query: unknown;
  entities_ai_func: unknown;
  entity_jaccard_similarity: number | null;
  disagreement_flags: string[];
  status: string;
  claimed_by: string | null;
}

interface DimensionDraft {
  winner: Winner | null;
  truth_value: string;
  notes: string;
}

function emptyDraft(): DimensionDraft {
  return { winner: null, truth_value: '', notes: '' };
}

function aiQueryValue(item: ReviewQueueItem, dim: Dimension): unknown {
  switch (dim) {
    case 'sentiment': return item.sentiment_ai_query;
    case 'topic':     return item.topic_ai_query;
    case 'summary':   return item.summary_ai_query;
    case 'entities':  return item.entities_ai_query;
  }
}

function aiFuncValue(item: ReviewQueueItem, dim: Dimension): unknown {
  switch (dim) {
    case 'sentiment': return item.sentiment_ai_func;
    case 'topic':     return item.topic_ai_func;
    case 'summary':   return item.summary_ai_func;
    case 'entities':  return item.entities_ai_func;
  }
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

export function ReviewDetailPage() {
  const { encodedPath } = useParams<{ encodedPath: string }>();
  const path = encodedPath ? decodeURIComponent(encodedPath) : '';
  const navigate = useNavigate();

  const [item, setItem]   = useState<ReviewQueueItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [drafts, setDrafts] = useState<Record<Dimension, DimensionDraft>>({
    sentiment: emptyDraft(),
    topic: emptyDraft(),
    summary: emptyDraft(),
    entities: emptyDraft(),
  });

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    fetch(`/api/review-queue/item?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (res.status === 404) throw new Error('Item not found');
        if (!res.ok) throw new Error(`Failed to load: ${res.statusText}`);
        return res.json() as Promise<ReviewQueueItem>;
      })
      .then((data) => {
        setItem(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [path]);

  // Claim the item once it's loaded and still pending.
  useEffect(() => {
    if (!item || item.status !== 'pending') return;
    fetch('/api/review-queue/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
      .then((res) => {
        // 409 means someone else claimed it — leave status as-is so UI shows it.
        if (!res.ok) return;
        return res.json().then((updated: { status: string; claimed_by: string }) => {
          setItem((prev) => (prev ? { ...prev, ...updated } : prev));
        });
      })
      .catch(() => undefined);
  }, [item?.status, path]);

  const updateDraft = (dim: Dimension, patch: Partial<DimensionDraft>) => {
    setDrafts((prev) => ({ ...prev, [dim]: { ...prev[dim], ...patch } }));
  };

  const canSubmit =
    item &&
    item.disagreement_flags.some((d) => drafts[d as Dimension]?.winner !== null);

  const submit = async () => {
    if (!item) return;
    setSubmitting(true);
    try {
      const verdicts = item.disagreement_flags
        .filter((d) => drafts[d as Dimension]?.winner !== null)
        .map((d) => {
          const draft = drafts[d as Dimension];
          return {
            dimension: d,
            winner: draft.winner as Winner,
            truth_value: draft.winner === 'neither' && draft.truth_value
              ? draft.truth_value : undefined,
            notes: draft.notes || undefined,
          };
        });
      const res = await fetch('/api/verdicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, verdicts }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Submit failed: ${res.statusText}`);
      }
      navigate('/lakebase');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  };

  const release = async () => {
    if (!item) return;
    try {
      await fetch('/api/review-queue/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
    } catch {
      // Best effort — navigate away regardless.
    }
    navigate('/lakebase');
  };

  if (loading) {
    return (
      <div className="space-y-3 max-w-4xl mx-auto">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="text-destructive bg-destructive/10 p-3 rounded-md">
          {error ?? 'Item not found'}
        </div>
        <Link to="/lakebase" className="text-primary underline">
          Back to queue
        </Link>
      </div>
    );
  }

  const someoneElsesClaim =
    item.status === 'claimed' && item.claimed_by && item.claimed_by !== '__me__'; // server-side check

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <Link to="/lakebase" className="text-sm text-primary underline">
          ← Back to queue
        </Link>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Status:</span>
          <Badge variant="secondary">{item.status}</Badge>
          {item.claimed_by && (
            <span className="text-xs text-muted-foreground">by {item.claimed_by}</span>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="break-all">{item.path}</CardTitle>
        </CardHeader>
        <CardContent>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Transcript</h3>
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{item.transcription_text}</p>
        </CardContent>
      </Card>

      {item.disagreement_flags.map((d) => {
        const dim = d as Dimension;
        const draft = drafts[dim];
        return (
          <Card key={dim}>
            <CardHeader>
              <CardTitle className="capitalize">{dim} disagreement</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground mb-1">AI Query (FM API)</div>
                  <pre className="text-sm whitespace-pre-wrap break-words">{renderValue(aiQueryValue(item, dim))}</pre>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground mb-1">AI Func (SQL functions)</div>
                  <pre className="text-sm whitespace-pre-wrap break-words">{renderValue(aiFuncValue(item, dim))}</pre>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Winner</div>
                <div className="flex flex-wrap gap-2">
                  {WINNERS.map((w) => (
                    <Button
                      key={w}
                      size="sm"
                      variant={draft.winner === w ? 'default' : 'outline'}
                      onClick={() => updateDraft(dim, { winner: w })}
                    >
                      {WINNER_LABELS[w]}
                    </Button>
                  ))}
                </div>
              </div>

              {draft.winner === 'neither' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Your truth value</label>
                  <Textarea
                    value={draft.truth_value}
                    onChange={(e) => updateDraft(dim, { truth_value: e.target.value })}
                    placeholder="What's the correct answer?"
                    rows={2}
                  />
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">Notes (optional)</label>
                <Textarea
                  value={draft.notes}
                  onChange={(e) => updateDraft(dim, { notes: e.target.value })}
                  rows={2}
                />
              </div>
            </CardContent>
          </Card>
        );
      })}

      <div className="flex justify-between items-center sticky bottom-4 bg-background border rounded-md p-3 shadow-lg">
        <Button variant="outline" onClick={release} disabled={submitting}>
          Release without verdict
        </Button>
        <Button
          onClick={submit}
          disabled={!canSubmit || submitting || Boolean(someoneElsesClaim)}
        >
          {submitting ? 'Submitting…' : 'Submit verdict'}
        </Button>
      </div>
    </div>
  );
}
