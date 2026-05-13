import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
  Badge,
} from '@databricks/appkit-ui/react';

interface QueueRow {
  path: string;
  _ingested_at: string | null;
  disagreement_flags: string[];
  status: string;
  claimed_by: string | null;
}

function basename(path: string): string {
  const cleaned = path.replace(/\/+$/, '');
  const i = cleaned.lastIndexOf('/');
  return i === -1 ? cleaned : cleaned.slice(i + 1);
}

export function LakebasePage() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    const url = filter === 'all' ? '/api/review-queue' : `/api/review-queue?dimension=${filter}`;
    setLoading(true);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch queue: ${res.statusText}`);
        return res.json() as Promise<QueueRow[]>;
      })
      .then((data) => {
        setRows(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load queue'))
      .finally(() => setLoading(false));
  }, [filter]);

  const dimensions = ['all', 'sentiment', 'topic', 'summary', 'entities'];

  return (
    <div className="space-y-6 w-full max-w-5xl mx-auto">
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle>NLP Verdict Workbench — Review Queue</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Calls where the two NLP implementations disagree. Click a row to review and submit a verdict.
          </p>

          <div className="flex gap-2 mb-4 flex-wrap">
            {dimensions.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={filter === d ? 'default' : 'outline'}
                onClick={() => setFilter(d)}
              >
                {d === 'all' ? 'All disagreements' : d}
              </Button>
            ))}
          </div>

          {error && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md mb-4 text-sm">
              {error}
            </div>
          )}

          {loading && (
            <div className="space-y-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={`s-${i}`} className="h-12 w-full" />
              ))}
            </div>
          )}

          {!loading && rows.length === 0 && (
            <p className="text-muted-foreground text-center py-8">
              {filter === 'all'
                ? 'No items pending review. The gold_nlp_disagreements view may be empty or the Lakebase Sync has not run yet.'
                : `No pending items with a ${filter} disagreement.`}
            </p>
          )}

          {!loading && rows.length > 0 && (
            <div className="border rounded-md divide-y">
              {rows.map((row) => (
                <Link
                  key={row.path}
                  to={`/lakebase/review/${encodeURIComponent(row.path)}`}
                  className="block px-4 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate" title={row.path}>
                        {basename(row.path)}
                      </div>
                      <div className="text-xs text-muted-foreground truncate" title={row.path}>
                        {row.path}
                      </div>
                    </div>
                    <div className="flex gap-1 flex-wrap">
                      {row.disagreement_flags.map((f) => (
                        <Badge key={f} variant="secondary">
                          {f}
                        </Badge>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground whitespace-nowrap">
                      {row._ingested_at
                        ? new Date(row._ingested_at).toLocaleString()
                        : '—'}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
