import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FrontierChart, type FrontierData } from "@/components/frontier-chart";

/**
 * Read from disk on every request, never bundled and never cached. The acceptance
 * test for this page is that you can edit `data/generated/frontier.json`, reload,
 * and the chart moves — which only holds if the file is the source of truth at
 * request time rather than a build-time snapshot.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FRONTIER_PATH = "data/generated/frontier.json";

async function loadFrontier(): Promise<{ data: FrontierData | null; error: string | null }> {
  try {
    const raw = await readFile(resolve(process.cwd(), FRONTIER_PATH), "utf8");
    const parsed = JSON.parse(raw) as FrontierData;
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
      return { data: null, error: "frontier.json has no rows." };
    }
    if (!parsed.reference || typeof parsed.reference.oracleNetPaise !== "number") {
      return {
        data: null,
        error:
          "frontier.json predates the Oracle reference line. Regenerate it with `npm run frontier` — do not hand-edit the field in.",
      };
    }
    return { data: parsed, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "Could not read frontier.json" };
  }
}

export default async function FrontierPage() {
  const { data, error } = await loadFrontier();

  return (
    <main className="frontier-page">
      <header className="frontier-page-head">
        <a className="secondary-link" href="/">
          ← Dashboard
        </a>
        <a className="secondary-link" href="/replay">
          Replay console →
        </a>
      </header>

      {data ? (
        <FrontierChart data={data} />
      ) : (
        <div className="frontier-empty">
          <h2>No frontier measurement on disk</h2>
          <p>{error}</p>
          <p>
            Run <code>npm run frontier</code> to write <code>{FRONTIER_PATH}</code>. This page renders measurements or
            it renders nothing; there is no placeholder data behind it.
          </p>
        </div>
      )}
    </main>
  );
}
