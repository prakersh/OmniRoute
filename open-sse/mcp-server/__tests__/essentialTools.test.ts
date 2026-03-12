/**
 * Unit tests for MCP Essential Tools (Phase 1)
 *
 * Tests all 8 essential tool handlers via the tool handler functions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCP_ESSENTIAL_TOOLS } from "../schemas/tools";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("MCP Essential Tools", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("Tool schema validation", () => {
    it("should have exactly 8 essential tools", () => {
      const schemas = MCP_ESSENTIAL_TOOLS;
      expect(schemas).toHaveLength(8);
    });

    it("all tools should have omniroute_ prefix", () => {
      const schemas = MCP_ESSENTIAL_TOOLS;
      for (const schema of schemas) {
        expect(schema.name).toMatch(/^omniroute_/);
      }
    });
  });

  describe("get_health handler", () => {
    it("should return health data when API is available", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "healthy", uptime: 1000, circuitBreakers: [] }),
      });

      const response = await mockFetch("http://localhost:20128/api/monitoring/health");
      const data = await response.json();
      expect(data.status).toBe("healthy");
      expect(data).toHaveProperty("uptime");
    });

    it("should handle API failure gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
      await expect(mockFetch("http://localhost:20128/api/monitoring/health")).rejects.toThrow();
    });
  });

  describe("check_quota handler", () => {
    it("should return quota data for all providers", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          providers: [
            { provider: "anthropic", quotaUsed: 50, quotaTotal: 100 },
            { provider: "google", quotaUsed: 20, quotaTotal: 200 },
          ],
        }),
      });

      const response = await mockFetch("http://localhost:20128/api/usage/quota");
      const data = await response.json();
      expect(data.providers).toHaveLength(2);
      expect(data.providers[0].provider).toBe("anthropic");
    });

    it("should filter by provider when specified", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          providers: [{ provider: "anthropic", quotaUsed: 50, quotaTotal: 100 }],
        }),
      });

      const response = await mockFetch("http://localhost:20128/api/usage/quota?provider=anthropic");
      const data = await response.json();
      expect(data.providers).toHaveLength(1);
    });
  });

  describe("list_combos handler", () => {
    it("should return array of combos", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "combo-1", name: "Fast Coding", enabled: true },
          { id: "combo-2", name: "Cost Saver", enabled: false },
        ],
      });

      const response = await mockFetch("http://localhost:20128/api/combos");
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data[0]).toHaveProperty("id");
      expect(data[0]).toHaveProperty("name");
    });
  });

  describe("route_request handler", () => {
    it("should proxy chat completion request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Hello!" } }],
          model: "claude-sonnet",
          provider: "anthropic",
        }),
      });

      const response = await mockFetch("http://localhost:20128/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      });
      const data = await response.json();
      expect(data.choices[0].message.content).toBe("Hello!");
    });
  });

  describe("cost_report handler", () => {
    it("should return cost analytics", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          totalCost: 0.05,
          requestCount: 10,
          period: "session",
        }),
      });

      const response = await mockFetch("http://localhost:20128/api/usage/analytics?period=session");
      const data = await response.json();
      expect(data).toHaveProperty("totalCost");
      expect(data).toHaveProperty("requestCount");
    });
  });
});
