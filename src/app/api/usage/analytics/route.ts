import { NextResponse } from "next/server";
import { getDbInstance } from "@/lib/db/core";
import { computeAnalytics } from "@/lib/usageAnalytics";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "30d";

    const db = getDbInstance();
    const rows = db
      .prepare(
        `
        SELECT provider, model, connection_id, api_key_id, api_key_name,
               tokens_in, tokens_out, status, timestamp
        FROM call_logs
        ORDER BY timestamp ASC
      `
      )
      .all();

    const history = rows.map((rowRaw) => {
      const row = asRecord(rowRaw);
      return {
        provider: toStringOrNull(row.provider),
        model: toStringOrNull(row.model),
        connectionId: toStringOrNull(row.connection_id),
        apiKeyId: toStringOrNull(row.api_key_id),
        apiKeyName: toStringOrNull(row.api_key_name),
        tokens: {
          input: toNumber(row.tokens_in),
          output: toNumber(row.tokens_out),
        },
        status: typeof row.status === "number" ? String(row.status) : toStringOrNull(row.status),
        timestamp: toStringOrNull(row.timestamp) || new Date(0).toISOString(),
      };
    });

    // Build connection map for account names
    const { getProviderConnections } = await import("@/lib/localDb");
    const connectionMap: Record<string, string> = {};
    try {
      const connections = await getProviderConnections();
      for (const connRaw of connections as unknown[]) {
        const conn =
          connRaw && typeof connRaw === "object" && !Array.isArray(connRaw)
            ? (connRaw as Record<string, unknown>)
            : {};
        const connectionId =
          typeof conn.id === "string" && conn.id.trim().length > 0 ? conn.id : null;
        if (!connectionId) continue;

        const name =
          (typeof conn.name === "string" && conn.name.trim()) ||
          (typeof conn.email === "string" && conn.email.trim()) ||
          connectionId;
        connectionMap[connectionId] = name;
      }
    } catch {
      /* ignore */
    }

    const analytics = await computeAnalytics(history, range, connectionMap);

    return NextResponse.json(analytics);
  } catch (error) {
    console.error("Error computing analytics:", error);
    return NextResponse.json({ error: "Failed to compute analytics" }, { status: 500 });
  }
}
