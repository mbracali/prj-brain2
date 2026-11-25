import { create } from "zustand";
import { api } from "../lib/api";
import type { Repo } from "../lib/repoTypes";

interface ReposState {
  repos: Repo[];
  loaded: boolean;
  /** Bumped whenever a repo changed (commands, sync) so open views reload. */
  version: number;
  load(): Promise<void>;
  bump(): void;
}

export const useRepos = create<ReposState>((set, get) => ({
  repos: [],
  loaded: false,
  version: 0,
  async load() {
    const repos = await api.repos();
    set({ repos, loaded: true });
  },
  bump() {
    set({ version: get().version + 1 });
  },
}));
