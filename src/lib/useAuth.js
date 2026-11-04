import { useSyncExternalStore } from "react";
import { getAuthState, subscribeAuth } from "./socket";

export function useAuthState() {
  return useSyncExternalStore(subscribeAuth, getAuthState, getAuthState);
}
