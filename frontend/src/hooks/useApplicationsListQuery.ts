import { useLayoutEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDispatch } from "react-redux";
import type { AppDispatch } from "@/redux/store";
import { getApplications } from "@/redux/actions/applicationActions";
import {
  clearApplications,
  hydrateApplicationsListFromCache,
} from "@/redux/slices/applicationSlice";
import type { GetApplicationsParams } from "@/types/applicationTypes";
import {
  getCachedApplicationsList,
  listFetchKeyFromGetApplicationsParams,
} from "@/lib/applicationsListCache";
import { visibleRefetchInterval } from "@/lib/prefetchFreshness";

/** Revisits within this window paint from cache only — no refetch flicker. */
const LIST_STALE_TIME_MS = 30_000;
/** Letters list needs fresher SendGrid webhook status than the default list cache. */
const LETTER_STATUS_STALE_TIME_MS = 2_000;
const LETTER_STATUS_REFETCH_MS = 5_000;

type UseApplicationsListQueryOptions = {
  enabled?: boolean;
};

/**
 * React Query orchestrates list fetching while Redux remains the table data source.
 *
 * On every stage/filter key change we sync Redux from that key's cache first
 * (instant correct rows). `queryFn` runs only when the key is missing or stale,
 * so sidebar clicks stay smooth without leaving the previous stage on screen.
 */
export function useApplicationsListQuery(
  params: GetApplicationsParams,
  options: UseApplicationsListQueryOptions = {},
) {
  const dispatch = useDispatch<AppDispatch>();
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const fetchKey = listFetchKeyFromGetApplicationsParams(params);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const tracksLetterStatus = Boolean(params.includeLetterStatus);

  useLayoutEffect(() => {
    if (!enabled) return;

    const rqCached = queryClient.getQueryData(["applications-list", fetchKey]);
    if (rqCached !== undefined) {
      dispatch(hydrateApplicationsListFromCache(rqCached));
      return;
    }

    // Letter-status lists must not paint stale "sent" from IndexedDB after webhooks.
    if (!tracksLetterStatus) {
      const l1Cached = getCachedApplicationsList(fetchKey);
      if (l1Cached !== undefined) {
        dispatch(hydrateApplicationsListFromCache(l1Cached));
        // Seed RQ so a warm L1 hit can satisfy staleTime without a redundant fetch.
        queryClient.setQueryData(["applications-list", fetchKey], l1Cached);
        return;
      }
    }

    // No rows for this stage yet — clear previous stage and show loading.
    dispatch(clearApplications());
  }, [dispatch, enabled, fetchKey, queryClient, tracksLetterStatus]);

  return useQuery({
    queryKey: ["applications-list", fetchKey],
    enabled,
    queryFn: async () => {
      const latestParams = paramsRef.current;
      const hasWarmListCache = getCachedApplicationsList(fetchKey) !== undefined;
      const hasPaintedRows =
        queryClient.getQueryData(["applications-list", fetchKey]) !== undefined;
      return dispatch(
        getApplications({
          ...latestParams,
          // Always re-hit the API for letter delivery status (SendGrid webhooks).
          // skipListCache also avoids writing a stale "delivered" snapshot to IDB.
          ...(tracksLetterStatus
            ? { skipListCacheRead: true, skipListCache: true }
            : {}),
          // Warm key / letter-status poll: keep painted rows; cold key: clear via pending.
          clearListOnFetch:
            hasWarmListCache || (tracksLetterStatus && hasPaintedRows)
              ? false
              : Boolean(latestParams.clearListOnFetch),
        }),
      ).unwrap();
    },
    staleTime: tracksLetterStatus ? LETTER_STATUS_STALE_TIME_MS : LIST_STALE_TIME_MS,
    gcTime: tracksLetterStatus ? 15_000 : 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: tracksLetterStatus,
    refetchInterval: tracksLetterStatus
      ? () => visibleRefetchInterval(LETTER_STATUS_REFETCH_MS)
      : false,
  });
}
