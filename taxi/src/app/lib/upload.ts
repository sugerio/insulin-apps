import { DOCUMENT_TYPES, routes, type ReadResult } from "#shared";
import { apiRequest } from "../api/client.ts";

/** A file's type for upload: its own when it is one the app reads, else from its extension; null when neither. */
export function uploadType(file: File): string | null {
  if ((DOCUMENT_TYPES as readonly string[]).includes(file.type)) return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  return extension === "pdf" ? "application/pdf" : extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : null;
}

/** Uploads one file into an adult's return for AI to read into slips (step 2, or a missing slip in step 3). */
export function uploadFile(year: number, personId: string, file: File, type: string): Promise<ReadResult> {
  return apiRequest(routes.uploadDocument, {
    params: { year },
    raw: { body: file, contentType: type, headers: { "X-File-Name": encodeURIComponent(file.name), "X-Person-Id": personId } },
  });
}
