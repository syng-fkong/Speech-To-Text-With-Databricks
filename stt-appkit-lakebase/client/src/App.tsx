import { createBrowserRouter, RouterProvider, NavLink, Outlet } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@databricks/appkit-ui/react';
import { LakebasePage } from './pages/lakebase/LakebasePage';
import { ReviewDetailPage } from './pages/lakebase/ReviewDetailPage';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

function Layout() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">NLP Verdict Workbench</h1>
        <nav className="flex gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Home
          </NavLink>
          <NavLink to="/lakebase" className={navLinkClass}>
            Review queue
          </NavLink>
        </nav>
      </header>

      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/lakebase', element: <LakebasePage /> },
      { path: '/lakebase/review/:encodedPath', element: <ReviewDetailPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}

function HomePage() {
  return (
    <div className="max-w-2xl mx-auto space-y-6 mt-8">
      <div className="text-center">
        <h2 className="text-3xl font-bold mb-2 text-foreground">
          NLP Verdict Workbench
        </h2>
        <p className="text-lg text-muted-foreground">
          Human-in-the-loop review for the speech-to-text NLP pipeline.
        </p>
      </div>

      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle>How it works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            The asset bundle runs two NLP implementations in parallel — Databricks AI SQL
            functions and a Foundation Model API. When they disagree on a call&rsquo;s
            sentiment, topic, or extracted entities, that call lands in the review queue here.
          </p>
          <p className="text-muted-foreground">
            For each disagreement you pick a winner (AI SQL / FM API / Neither / Both
            acceptable), optionally provide the ground truth, and submit. Verdicts flow back
            into Delta via UC federation and feed the existing MLflow evaluation as human
            ground truth.
          </p>
          <div className="pt-2">
            <NavLink
              to="/lakebase"
              className="inline-block px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90"
            >
              Open review queue →
            </NavLink>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
