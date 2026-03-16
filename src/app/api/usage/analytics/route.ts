import { NextResponse } from "next/server";
import { getUsageDb } from "@/lib/usageDb";
import { computeAnalytics } from "@/lib/usageAnalytics";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "30d";
    const apiKeyFilter = searchParams.get("apiKey") || "";

    const db = await getUsageDb();
    let history = db.data.history || [];

    // Filter by API key if specified
    if (apiKeyFilter) {
      history = history.filter(
        (e: any) => (e.apiKeyName || "") === apiKeyFilter || (e.apiKeyId || "") === apiKeyFilter
      );
    }

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

    // Build provider name map for display normalization
    const providerNameMap: Record<string, string> = {};
    try {
      const { getProviderNodes } = await import("@/models");
      const nodes = await getProviderNodes();
      for (const nodeRaw of (Array.isArray(nodes) ? nodes : []) as unknown[]) {
        const node =
          nodeRaw && typeof nodeRaw === "object" ? (nodeRaw as Record<string, unknown>) : {};
        const id = typeof node.id === "string" ? node.id : "";
        const name = typeof node.name === "string" ? node.name : "";
        if (id && name) providerNameMap[id] = name;
      }
    } catch {
      /* ignore */
    }

    const analytics = await computeAnalytics(history, range, connectionMap, providerNameMap);

    // Include all registered API keys so the filter dropdown shows all keys
    try {
      const { getApiKeys } = await import("@/lib/localDb");
      const apiKeys = await getApiKeys();
      const registeredKeys = (Array.isArray(apiKeys) ? apiKeys : []).map((k: any) => ({
        name: k.name || "unnamed",
        id: k.id || "",
      }));
      analytics.registeredApiKeys = registeredKeys;
    } catch {
      /* ignore */
    }

    return NextResponse.json(analytics);
  } catch (error) {
    console.error("Error computing analytics:", error);
    return NextResponse.json({ error: "Failed to compute analytics" }, { status: 500 });
  }
}
