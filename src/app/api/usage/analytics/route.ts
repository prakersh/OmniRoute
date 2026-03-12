import { NextResponse } from "next/server";
import { getUsageDb } from "@/lib/usageDb";
import { computeAnalytics } from "@/lib/usageAnalytics";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "30d";

    const db = await getUsageDb();
    const history = db.data.history || [];

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
