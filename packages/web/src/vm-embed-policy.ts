const VM_HOSTNAME = "vm.manifold.tyrode.dev";

export function isVmEmbedLink(link: string | null): link is string {
  if (link === null) return false;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === VM_HOSTNAME;
  } catch {
    return false;
  }
}
