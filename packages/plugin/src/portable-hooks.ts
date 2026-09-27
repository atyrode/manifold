/** Resource hooks that run unchanged in a page or a portable React Worker. */
export {
  usePolledResource,
  polledFeedReport,
  resetPolledResources,
  ATTENDANCE_RESOURCE,
  CONTAINER_TERMINALS_RESOURCE,
  FALLBACK_POLL_MS,
  INDEX_RESOURCE,
  MACHINES_RESOURCE,
  TERMINALS_RESOURCE,
  type PolledResource,
  type PolledResourceOptions,
  type PolledEquality,
  type PolledFeedReport,
} from "./polled-resource.ts";
