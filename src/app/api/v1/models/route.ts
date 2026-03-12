import { CORS_ORIGIN } from "@/shared/utils/cors";
import { getUnifiedModelsResponse } from "./catalog";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list
 */
export async function GET(request: Request) {
  return getUnifiedModelsResponse(request);
}
