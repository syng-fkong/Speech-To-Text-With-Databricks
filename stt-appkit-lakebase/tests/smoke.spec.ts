import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Smoke tests for the NLP Verdict Workbench app shell.
// These confirm the app boots, renders the home page, and the review queue route
// loads without runtime errors. They don't exercise the actual verdict-submit
// flow because that needs both Lakebase Sync (Phase 2) and verdicts in the
// queue — covered manually in docs/LAKEHOUSE_LAKEBASE_INTEGRATION.md.

const APP_HEADER       = 'NLP Verdict Workbench';
const QUEUE_NAV_LABEL  = 'Review queue';
const QUEUE_PATH       = '/lakebase';
const QUEUE_PAGE_TITLE = 'NLP Verdict Workbench — Review Queue';

// ── Tests ───────────────────────────────────────────────────────────────────

let testArtifactsDir: string;
let consoleLogs: string[] = [];
let consoleErrors: string[] = [];
let pageErrors: string[] = [];
let failedRequests: string[] = [];

test('smoke test - app loads and displays home page', async ({ page }) => {
  await page.goto('/');

  // The header in the layout
  await expect(page.getByRole('heading', { name: APP_HEADER })).toBeVisible();
  // The home page's tagline
  await expect(page.getByText('Human-in-the-loop review')).toBeVisible();
  // The two nav links
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('link', { name: QUEUE_NAV_LABEL })).toBeVisible();
});

test('smoke test - review queue page loads', async ({ page }) => {
  await page.goto(QUEUE_PATH);
  await expect(page.getByText(QUEUE_PAGE_TITLE)).toBeVisible();
  // Dimension filter chips render even when the queue is empty
  await expect(page.getByRole('button', { name: 'All disagreements' })).toBeVisible();
});

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  consoleLogs = [];
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];

  // Create temp directory for test artifacts
  testArtifactsDir = join(process.cwd(), '.smoke-test');
  mkdirSync(testArtifactsDir, { recursive: true });

  // Capture console logs and errors (including React errors)
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();

    // Skip empty lines and formatting placeholders
    if (!text.trim() || /^%[osd]$/.test(text.trim())) {
      return;
    }

    // Get stack trace for errors if available
    const location = msg.location();
    const locationStr = location.url ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';

    consoleLogs.push(`[${type}] ${text}${locationStr}`);

    // Separately track error messages (React errors appear here)
    if (type === 'error') {
      consoleErrors.push(`${text}${locationStr}`);
    }
  });

  // Capture page errors with full stack trace
  page.on('pageerror', (error) => {
    const errorDetails = `Page error: ${error.message}\nStack: ${error.stack || 'No stack trace available'}`;
    pageErrors.push(errorDetails);
    // Also log to console for immediate visibility
    console.error('Page error detected:', errorDetails);
  });

  // Capture failed requests
  page.on('requestfailed', (request) => {
    failedRequests.push(`Failed request: ${request.url()} - ${request.failure()?.errorText}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const testName = testInfo.title.replace(/ /g, '-').toLowerCase();
  // Always capture artifacts, even if test fails
  const screenshotPath = join(testArtifactsDir, `${testName}-app-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const logsPath = join(testArtifactsDir, `${testName}-console-logs.txt`);
  const allLogs = [
    '=== Console Logs ===',
    ...consoleLogs,
    '\n=== Console Errors (React errors) ===',
    ...consoleErrors,
    '\n=== Page Errors ===',
    ...pageErrors,
    '\n=== Failed Requests ===',
    ...failedRequests,
  ];
  writeFileSync(logsPath, allLogs.join('\n'), 'utf-8');

  console.log(`Screenshot saved to: ${screenshotPath}`);
  console.log(`Console logs saved to: ${logsPath}`);
  if (consoleErrors.length > 0) {
    console.log('Console errors detected:', consoleErrors);
  }
  if (pageErrors.length > 0) {
    console.log('Page errors detected:', pageErrors);
  }
  if (failedRequests.length > 0) {
    console.log('Failed requests detected:', failedRequests);
  }

  await page.close();
});
