import { z } from "zod";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { deleteMeal } from "@/lib/firebase/meals";
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { db, user } = await authenticated(request);
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const version = Number(params.get("version"));
    const mutationId = params.get("mutationId");
    if (
      !z.uuid().safeParse(id).success ||
      !z.uuid().safeParse(mutationId).success ||
      !params.has("version") ||
      !Number.isInteger(version) ||
      version < 0
    )
      throw new HttpError(400, "invalid_request");
    await deleteMeal(db, user.id, id, version, mutationId!);
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
