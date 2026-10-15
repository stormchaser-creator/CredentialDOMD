// The hosting CDN may retain an unversioned JavaScript URL across releases.
// A build-specific script URL keeps that cache from pinning the old worker.
export function registerAppWorker(baseUrl, build, serviceWorker = navigator.serviceWorker) {
  return serviceWorker.register(`${baseUrl}sw.js?build=${encodeURIComponent(build)}`, {
    updateViaCache: "none",
  });
}
