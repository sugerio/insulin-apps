import type { Estimate, SlipList } from "#shared";
import { useYear } from "../components/YearFrame.tsx";
import type { Resource } from "./useResource.ts";

// The year's estimate and slips, loaded once by the year's frame and again whenever the year's revision changes (any
// saved change).

export function useEstimate(): Resource<Estimate> {
  return useYear().estimate;
}

export function useSlips(): Resource<SlipList> {
  return useYear().slips;
}
