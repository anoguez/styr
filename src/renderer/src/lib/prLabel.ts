/** `#100 - styr-app`: the pull or merge request's number (when the URL has one) and its repo. */
export function prMenuLabel(link: { repo: string; url: string }): string {
  const number = /\/(?:pull|pulls|pull-requests|merge_requests)\/(\d+)/.exec(link.url)?.[1]
  return number ? `#${number} - ${link.repo}` : link.repo
}
