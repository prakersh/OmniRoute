import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, deleteModelAlias, isCloudEnabled } from "@/models";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { cloudModelAliasUpdateSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

// GET /api/models/alias - Get all aliases
export async function GET(request) {
  try {
    // Require authentication for security
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const aliases = await getModelAliases();
    return NextResponse.json({ aliases });
  } catch (error) {
    console.log("Error fetching aliases:", error);
    return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT /api/models/alias - Set model alias
export async function PUT(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    // Require authentication for security
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const validation = validateBody(cloudModelAliasUpdateSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { model, alias } = validation.data;

    await setModelAlias(alias, model);
    await syncToCloudIfEnabled();

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}

// DELETE /api/models/alias?alias=xxx - Delete alias
export async function DELETE(request) {
  try {
    // Require authentication for security
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const alias = searchParams.get("alias");

    if (!alias) {
      return NextResponse.json({ error: "Alias required" }, { status: 400 });
    }

    await deleteModelAlias(alias);
    await syncToCloudIfEnabled();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting alias:", error);
    return NextResponse.json({ error: "Failed to delete alias" }, { status: 500 });
  }
}

async function syncToCloudIfEnabled() {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;

    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    console.log("Error syncing aliases to cloud:", error);
  }
}
