import { create } from "zustand";
import { calendarApi } from "../lib/api";
import type { Calendar } from "../lib/calTypes";

export type CalView = "month" | "week" | "day" | "agenda";
const KEY = "brain2.calendar.view";

function restore(): { view: CalView; cursor: number } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { view: ["month", "week", "day", "agenda"].includes(v.view) ? v.view : "month", cursor: Number(v.cursor) || Date.now() };
  } catch {
    return { view: "month", cursor: Date.now() };
  }
}
function persist(view: CalView, cursor: Date) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ view, cursor: cursor.getTime() }));
  } catch {
    /* storage unavailable */
  }
}

interface CalendarsState {
  calendars: Calendar[];
  loaded: boolean;
  view: CalView;
  cursor: Date;
  /** Bumped when events changed on the backend so views refetch. */
  version: number;
  load(): Promise<void>;
  setView(view: CalView): void;
  setCursor(d: Date): void;
  bump(): void;
}

const initial = restore();

export const useCalendars = create<CalendarsState>((set, get) => ({
  calendars: [],
  loaded: false,
  view: initial.view,
  cursor: new Date(initial.cursor),
  version: 0,
  async load() {
    const calendars = await calendarApi.list();
    set({ calendars, loaded: true });
  },
  setView(view) {
    persist(view, get().cursor);
    set({ view });
  },
  setCursor(cursor) {
    persist(get().view, cursor);
    set({ cursor });
  },
  bump() {
    set({ version: get().version + 1 });
  },
}));

export const CALENDAR_COLORS = [
  "#4f8ff7", "#2bb3a3", "#30a46c", "#8bc34a", "#e5a50a", "#f08c3a",
  "#e5484d", "#d6409f", "#8e4ec6", "#6e56cf", "#7b8794", "#a1887f",
];
