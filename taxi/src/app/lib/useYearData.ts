import { routes, type Estimate, type SlipList } from "#shared";
import { apiRequest } from "../api/client.ts";
import { useYear } from "../components/YearFrame.tsx";
import { useResource, type Resource } from "./useResource.ts";

// The year's estimate and slips, loaded again whenever the year's revision changes (any saved change).

export function useEstimate(): Resource<Estimate> {
  const { year } = useYear();
  return useResource(`estimate-${year.year}-${year.revision}`, (signal) => apiRequest(routes.getEstimate, { params: { year: year.year }, signal }));
}

export function useSlips(): Resource<SlipList> {
  const { year } = useYear();
  return useResource(`slips-${year.year}-${year.revision}`, (signal) => apiRequest(routes.listSlips, { params: { year: year.year }, signal }));
}
