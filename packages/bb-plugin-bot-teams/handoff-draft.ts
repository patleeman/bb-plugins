export function channelHandoffText(source: {
  threadId: string;
  projectId: string;
  title: string;
}) {
  const path =
    source.projectId === "proj_personal"
      ? `/threads/${encodeURIComponent(source.threadId)}`
      : `/projects/${encodeURIComponent(source.projectId)}/threads/${encodeURIComponent(source.threadId)}`;
  const title = source.title
    .replace(/[\\[\]<>*_`]/gu, "\\$&")
    .replace(/[\r\n]/gu, " ");
  return `Continue from [${title}](${path}) (@thread:${source.threadId})`;
}
