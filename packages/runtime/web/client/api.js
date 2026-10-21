/** @typedef {{path:string,name:string,kind:string,size:number,gitStatus:string}} FileEntry */
/** @typedef {{path:string,content:string,hash:string,size:number,binary:boolean,truncated:boolean}} FileContent */
/** @typedef {{attachmentId:string,artifactId:string,name:string,mimeType:string,size:number,status:'ready',kind:'image'|'text',contentHash:string}} Attachment */
/** @typedef {{revision:string,config:object,presentation:{theme:string,density:string},source:unknown,effective:unknown}} Settings */

export class ApiError extends Error {
  constructor(status, body) {
    super(body.error ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The bearer lives only in this closure. Native shells inject it upstream. */
export function createApi({ token = "", fetch: fetcher = globalThis.fetch } = {}) {
  return async (path, init = {}) => {
    if (!/^\/(?:v1|desktop)\//.test(path) || path.includes("\\") || /[\r\n]/.test(path)) {
      throw new Error("Only same-origin workbench requests are permitted.");
    }
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetcher(path, { ...init, headers, redirect: "error", cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  };
}

export const projectPath = (id) => `/v1/projects/${encodeURIComponent(id)}`;
export const taskPath = (id) => `/v1/tasks/${encodeURIComponent(id)}`;
export const post = (body) => ({ method: "POST", body: JSON.stringify(body) });
